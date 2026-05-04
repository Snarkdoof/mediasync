/**
 * MediaSync
 * 
 * Synchronizes an HTMLMediaElement with a W3C Timing Object using modern APIs.
 * 
 * Key Principles:
 * - Architecture & Scalability: Implements a clean State Machine (INIT, SEEKING, WAITING, PLAYING, PAUSED).
 * - Performance & Optimization: Uses requestVideoFrameCallback instead of timeupdate 
 *   for frame-accurate, high-performance synchronization.
 * - Browser-First Thinking: Leverages native performance.now() and native timing expectations.
 * - User-Centric: Handles native media controls and Safari quirks gracefully.
 */
class MediaSync {
  /**
   * @param {HTMLMediaElement} video 
   * @param {Object} timingObject - W3C Timing Object
   * @param {Object} options 
   */
  constructor(video, timingObject, options = {}) {
    if (!(video instanceof HTMLMediaElement)) {
      throw new Error("MediaSync requires an HTMLMediaElement");
    }
    if (!timingObject || typeof timingObject.query !== "function") {
      throw new Error("MediaSync requires a W3C Timing Object");
    }

    this.video = video;
    this.timing = timingObject;
    
    this.options = {
      debug: false,
      latencyKey: "mediasync_v2_latency",
      seekKey: "mediasync_v2_seek_time",
      modeKey: "mediasync_v2_mode",
      readyKey: "mediasync_v2_ready_buffer",
      latencyFudge: 0.150,   // Base safety margin
      macroThreshold: 0.15,  // >150ms drift triggers macro adjustment (pause & re-seek)
      microThreshold: 0.025, // <25ms drift is considered perfectly in-sync (just let it play)
      skipThreshold: 0.033,  // >33ms drift triggers re-seek in skip mode
      slideTestMode: false,  // If true, stops all adjustments after first hitting perfect sync
      mode: "auto",          // "auto" (use playbackRate) or "skip" (only seek/wait)
      ...options
    };

    // Safari detection (Safari struggles with variable playback rates)
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    
    // Load persisted mode, or default based on browser
    let savedMode = null;
    try { savedMode = localStorage.getItem(this.options.modeKey); } catch(e) {}

    if (savedMode === "auto" || savedMode === "skip") {
      this.options.mode = savedMode;
    } else if (isSafari) {
      this.options.mode = "skip";
    }

    this.state = "INIT";
    
    // Empirical estimates from previous runs
    this.estimatedStartupLatency = this._safeGetStorage(this.options.latencyKey, 0.020);
    this.estimatedSeekTime = this._safeGetStorage(this.options.seekKey, 0.100);
    this.estimatedReadyBuffer = this._safeGetStorage(this.options.readyKey, 0.200);
    
    this._vfcId = null;
    this._rafSyncId = null;
    this._waitId = null;
    this._targetTime = 0;
    this._baseVelocity = 0;

    // Measurement timestamps
    this._tSeekStart = 0;
    this._tPlayCall = 0;
    this._playAllowance = 0;
    this._sampleCount = 0;
    this._smoothedDrift = 0;
    this._currentRawDrift = 0;
    this._hasStartedMoving = false;
    this._framesIgnored = 0;
    this._startupLatencyEvaluated = false;
    this._macroAdjustmentTimes = [];
    this._scriptTriggeredAction = false;

    // Bound methods for predictable event listener management
    this._boundOnTimingChange = this._onTimingChange.bind(this);
    this._boundSyncLoop = this._syncLoop.bind(this);
    this._boundFallbackSyncLoop = this._fallbackSyncLoop.bind(this);
    this._boundCheckWaiting = this._checkWaiting.bind(this);
    this._boundOnSeeked = this._onSeeked.bind(this);
    this._boundOnNativePlay = this._onNativePlay.bind(this);
    this._boundOnNativePause = this._onNativePause.bind(this);

    this._init();
  }

  _safeGetStorage(key, defaultValue) {
    try {
      const val = window.localStorage.getItem(key);
      return val !== null ? parseFloat(val) : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }

  _safeSetStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // Ignore storage errors (e.g. private mode)
    }
  }

  _log(...args) {
    if (this.options.debug) {
      const timestamp = (performance.now() / 1000).toFixed(3);
      console.log(`[MediaSync] [${timestamp}]`, ...args);
    }
  }

  _init() {
    this._log("Initializing. Mode:", this.options.mode, "Latency:", this.estimatedStartupLatency.toFixed(3));
    this.timing.on("change", this._boundOnTimingChange);
    
    // Listen for native media element events to detect user interaction
    this.video.addEventListener("play", this._boundOnNativePlay);
    this.video.addEventListener("pause", this._boundOnNativePause);

    // Trigger initial state assessment
    this._onTimingChange();
  }

  _onNativePlay() {
    if (this._scriptTriggeredAction) return;
    this._log("User-initiated Play detected. Updating Timing Object.");
    this.timing.update({ velocity: 1.0 });
  }

  _onNativePause() {
    if (this._scriptTriggeredAction) return;
    this._log("User-initiated Pause detected. Updating Timing Object.");
    this.timing.update({ velocity: 0.0 });
  }

  /**
   * Helper to perform video operations while bypassing native event logic
   */
  _videoAction(fn) {
    this._scriptTriggeredAction = true;
    try {
      return fn();
    } finally {
      // Small delay to ensure the event loop processes the resulting events before we clear the flag
      setTimeout(() => { this._scriptTriggeredAction = false; }, 100);
    }
  }

  _getTimingPositionAtAccurate() {
      return this.timing.query().position;
  }

  _getTimingPositionAtEvent(eventTime) {
      const now = performance.now();
      const dt = (eventTime - now) / 1000;
      const q = this.timing.query();
      return q.position + (q.velocity * dt) + (0.5 * (q.acceleration || 0) * Math.pow(dt, 2));
  }

  _onTimingChange() {
    const query = this.timing.query();
    const velocityChanged = query.velocity !== this._baseVelocity;
    this._baseVelocity = query.velocity;

    const timingTime = this._getTimingPositionAtAccurate();
    const duration = this.video.duration;

    if (this._baseVelocity === 0) {
      if (Math.abs(timingTime - this.video.currentTime) > this.options.macroThreshold) {
        this._videoAction(() => { this.video.currentTime = timingTime; });
      }
      this._transition("PAUSED");
      return;
    }

    if (duration && !isNaN(duration)) {
        if ((timingTime >= duration && this._baseVelocity > 0) || 
            (timingTime <= 0 && this._baseVelocity < 0)) {
            if (this.state !== "PAUSED") {
                this._log("Timing object is out of bounds. Pausing.");
                this._transition("PAUSED");
            }
            return;
        }
    }

    const mediaTime = this.video.currentTime;
    const drift = timingTime - mediaTime;

    if (this.state === "PAUSED" || this.state === "INIT" || velocityChanged || Math.abs(drift) > this.options.macroThreshold) {
      this._transition("SEEKING");
    }
  }

  _transition(newState) {
    if (this.state === newState) return;
    this._log(`Transitioning: ${this.state} -> ${newState}`);
    
    this._cleanupState(this.state);
    this.state = newState;

    switch (newState) {
      case "PAUSED":
        this._videoAction(() => {
          this.video.pause();
          this.video.playbackRate = this._baseVelocity || 1.0;
        });
        break;
      case "SEEKING":
        this._startSeeking();
        break;
      case "WAITING":
        this._startWaiting();
        break;
      case "PLAYING":
        this._smoothedDrift = 0;
        this._sampleCount = 0;
        this._framesIgnored = 0;
        this._startupLatencyEvaluated = false;
        this._hasStartedMoving = false;
        this._startPlaying();
        break;
    }
  }

  _cleanupState(state) {
    if (state === "WAITING" && this._waitId) {
      cancelAnimationFrame(this._waitId);
      this._waitId = null;
    }
    if (state === "PLAYING") {
      if (this._vfcId && typeof this.video.cancelVideoFrameCallback === "function") {
        this.video.cancelVideoFrameCallback(this._vfcId);
        this._vfcId = null;
      }
      if (this._rafSyncId) {
        cancelAnimationFrame(this._rafSyncId);
        this._rafSyncId = null;
      }
    }
    this.video.removeEventListener("seeked", this._boundOnSeeked);
  }

  _startSeeking() {
    const nowPos = this._getTimingPositionAtAccurate();
    const delay = this.estimatedSeekTime + this.activeLatency + this.estimatedReadyBuffer;
    let targetTime = nowPos + (this._baseVelocity * delay);
    
    const duration = this.video.duration;
    if (duration && !isNaN(duration)) {
        if ((targetTime >= duration && this._baseVelocity > 0) || (targetTime <= 0 && this._baseVelocity < 0)) {
            this._log("Target time is beyond media range. Pausing.");
            this._transition("PAUSED");
            return;
        }
        if (targetTime < 0) targetTime = 0;
        if (targetTime > duration) targetTime = duration;
    }
    
    this._targetTime = targetTime;
    this._log(`Seeking to ${this._targetTime.toFixed(3)} (Est seek duration: ${this.estimatedSeekTime.toFixed(3)})`);
    
    this._videoAction(() => {
      this.video.pause();
      this.video.playbackRate = Math.max(0.1, Math.abs(this._baseVelocity));
      this.video.currentTime = this._targetTime;
    });

    this._tSeekStart = performance.now();
    this.video.addEventListener("seeked", this._boundOnSeeked);
  }

  _onSeeked() {
    const actualSeekDuration = (performance.now() - this._tSeekStart) / 1000;
    const nowPos = this._getTimingPositionAtAccurate();
    const triggerTime = this._targetTime - (this._baseVelocity * this.activeLatency);
    const timeLeft = (triggerTime - nowPos) / (this._baseVelocity || 1);

    this._log(`Seek completed in ${actualSeekDuration.toFixed(3)}s. Time left to trigger: ${timeLeft.toFixed(3)}s`);

    this.estimatedSeekTime = (this.estimatedSeekTime * 0.7) + (actualSeekDuration * 0.3);
    this._safeSetStorage(this.options.seekKey, this.estimatedSeekTime.toFixed(3));
    this.video.removeEventListener("seeked", this._boundOnSeeked);

    if (timeLeft < 0) {
      const penalty = Math.abs(timeLeft) + 0.150;
      this.estimatedReadyBuffer += penalty; 
      this.estimatedReadyBuffer = Math.min(2.0, this.estimatedReadyBuffer);
      this._safeSetStorage(this.options.readyKey, this.estimatedReadyBuffer.toFixed(3));
      this._log(`SEEK TOO SLOW: Missed trigger by ${Math.abs(timeLeft).toFixed(3)}s. Retrying with larger buffer.`);
      this._startSeeking();
      return;
    }

    this._transition("WAITING");
  }

  _startWaiting() {
    this._waitId = requestAnimationFrame(this._boundCheckWaiting);
  }

  _checkWaiting() {
    if (this.state !== "WAITING") return;
    const nowPos = this._getTimingPositionAtAccurate();
    const triggerTime = this._targetTime - (this._baseVelocity * this.activeLatency);
    const reachedTrigger = this._baseVelocity > 0 ? (nowPos >= triggerTime) : (nowPos <= triggerTime);

    if (reachedTrigger) {
      if (this.video.seeking) {
        this.estimatedReadyBuffer += 0.200;
        this.estimatedReadyBuffer = Math.min(2.0, this.estimatedReadyBuffer);
        this._safeSetStorage(this.options.readyKey, this.estimatedReadyBuffer.toFixed(3));
        this._log(`MISSED TRAIN: Player still seeking. Increasing ready buffer.`);
        this._startSeeking();
        return;
      }

      const idleTime = (performance.now() - this._tSeekStart) / 1000 - this.estimatedSeekTime;
      if (idleTime > 0.300) {
        const excessiveIdle = idleTime - 0.150;
        this.estimatedReadyBuffer -= (excessiveIdle * 0.20); 
        this.estimatedReadyBuffer = Math.max(0.050, this.estimatedReadyBuffer);
        this._safeSetStorage(this.options.readyKey, this.estimatedReadyBuffer.toFixed(3));
      }

      this._playAllowance = (this._targetTime - nowPos) / this._baseVelocity;
      this._tPlayCall = performance.now();
      this._transition("PLAYING"); 
      
      this._videoAction(() => {
        this.video.play().catch(err => {
            if (err.name !== 'AbortError') { this._log("Play failed", err); this._transition("PAUSED"); }
        });
      });
    } else {
      this._waitId = requestAnimationFrame(this._boundCheckWaiting);
    }
  }

  _startPlaying() {
    this._testDriftLocked = false;
    this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
    if (typeof this.video.requestVideoFrameCallback === "function" && this.video.tagName === 'VIDEO') {
      this._vfcId = this.video.requestVideoFrameCallback((now, metadata) => {
         if (this._rafSyncId) { cancelAnimationFrame(this._rafSyncId); this._rafSyncId = null; }
         this._boundSyncLoop(now, metadata);
      });
    }
  }

  get activeLatency() {
    if (typeof this.manualLatencyOverride === "number") return this.manualLatencyOverride;
    return this.estimatedStartupLatency;
  }

  get currentSmoothedDrift() { return this._smoothedDrift; }
  get currentRawDrift() { return this._currentRawDrift; }

  _getSmoothedDrift(drift) {
    this._sampleCount++;
    if (this._sampleCount === 1) {
      this._smoothedDrift = drift;
    } else {
      const alpha = 0.05;
      this._smoothedDrift = (alpha * drift) + (1 - alpha) * this._smoothedDrift;
    }
    return this._smoothedDrift;
  }

  _fallbackSyncLoop(now) {
    if (this.state !== "PLAYING") return;
    const mediaTime = this.video.currentTime;
    if (!this._hasStartedMoving) {
      if (Math.abs(mediaTime - this._targetTime) > 0.001) {
        this._hasStartedMoving = true;
      } else {
        this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
        return;
      }
    }
    if (this._framesIgnored < 5) { this._framesIgnored++; this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop); return; }

    const timingPos = this._getTimingPositionAtAccurate();
    const drift = timingPos - mediaTime;
    this._currentRawDrift = drift;
    const smoothedDrift = this._getSmoothedDrift(drift);
    this._handleSync(drift, smoothedDrift, () => {
        this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
    });
  }

  _syncLoop(now, metadata) {
    if (this.state !== "PLAYING") return;
    const mediaTime = metadata.mediaTime;
    if (!this._hasStartedMoving) {
      if (Math.abs(mediaTime - this._targetTime) > 0.001) {
        this._hasStartedMoving = true;
      } else {
        this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
        return;
      }
    }
    if (this._framesIgnored < 5) { this._framesIgnored++; this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop); return; }

    const timingPos = this._getTimingPositionAtEvent(metadata.expectedDisplayTime);
    const drift = timingPos - mediaTime;
    this._currentRawDrift = drift;
    const smoothedDrift = this._getSmoothedDrift(drift);
    this._handleSync(drift, smoothedDrift, () => {
        this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
    });
  }

  _handleSync(drift, smoothedDrift, nextTick) {
    const elapsedSincePlay = performance.now() - this._tPlayCall;
    if (!this._startupLatencyEvaluated) {
      if ((this.options.mode === "skip" && elapsedSincePlay > 5000) || (this.options.mode === "auto" && elapsedSincePlay > 2000)) {
        this._startupLatencyEvaluated = true;
        this._evaluateStartupLatency(smoothedDrift);
      }
    }

    if (this.options.mode === "skip") {
      if (Math.abs(smoothedDrift) > this.options.skipThreshold && !this._testDriftLocked && elapsedSincePlay > 1000) {
        if (!this._startupLatencyEvaluated) { this._startupLatencyEvaluated = true; this._evaluateStartupLatency(smoothedDrift); }
        this._log(`Skip mode drift detected: ${smoothedDrift.toFixed(3)}s. Triggering re-seek.`);
        this._applyMacroAdjustment(drift);
      } else {
        this._videoAction(() => { if (Math.abs(this.video.playbackRate - this._baseVelocity) > 0.001) this.video.playbackRate = this._baseVelocity; });
        nextTick();
      }
    } else {
      if (Math.abs(drift) > this.options.macroThreshold && !this._testDriftLocked && elapsedSincePlay > 1000) {
        if (!this._startupLatencyEvaluated) { this._startupLatencyEvaluated = true; this._evaluateStartupLatency(smoothedDrift); }
        this._log(`Macro drift detected: ${drift.toFixed(3)}s. Triggering re-sync.`);
        this._applyMacroAdjustment(drift);
      } else {
        this._applyMicroAdjustment(smoothedDrift, elapsedSincePlay);
        nextTick();
      }
    }
  }

  _evaluateStartupLatency(stabilizedDrift) {
    const actualStartupLatency = this._playAllowance + (stabilizedDrift / this._baseVelocity);
    if (typeof this.manualLatencyOverride === "number") return;
    const newLatency = (this.estimatedStartupLatency * 0.2) + (actualStartupLatency * 0.8);
    this.estimatedStartupLatency = Math.max(0, Math.min(1.000, newLatency));
    this._log(`UPDATED LATENCY ESTIMATE: ${this.estimatedStartupLatency.toFixed(3)}s`);
    this._safeSetStorage(this.options.latencyKey, this.estimatedStartupLatency.toFixed(3));
  }

  _applyMicroAdjustment(smoothedDrift, elapsedSincePlay) {
    if (this._testDriftLocked || elapsedSincePlay < 2000) return;
    const isCurrentlyCorrecting = Math.abs(this.video.playbackRate - this._baseVelocity) > 0.001;
    if (isCurrentlyCorrecting) {
      const isCatchingUp = this.video.playbackRate > this._baseVelocity;
      if (isCatchingUp ? (smoothedDrift <= 0) : (smoothedDrift >= 0)) {
        this._log(`Perfect center achieved. Restoring base velocity: ${this._baseVelocity}`);
        this._videoAction(() => { this.video.playbackRate = this._baseVelocity; });
        this._sampleCount = 0;
        if (this.options.slideTestMode) this._testDriftLocked = true;
      }
      return;
    }
    if (Math.abs(smoothedDrift) > this.options.microThreshold) {
      const targetRate = smoothedDrift > 0 ? this._baseVelocity * 1.005 : this._baseVelocity * 0.995;
      this._log(`Drift exceeded threshold. Locking playbackRate to ${targetRate.toFixed(3)} until centered.`);
      this._videoAction(() => { this.video.playbackRate = targetRate; });
    }
  }

  _applyMacroAdjustment(drift) {
    const now = performance.now();
    this._macroAdjustmentTimes.push(now);
    this._macroAdjustmentTimes = this._macroAdjustmentTimes.filter(t => now - t <= 30000);
    if (this.options.mode === "auto" && this._macroAdjustmentTimes.length >= 2) {
      this._log("Multiple macro adjustments within 30s. Falling back to SKIP mode.");
      this.options.mode = "skip";
      this._safeSetStorage(this.options.modeKey, "skip");
      this._macroAdjustmentTimes = []; 
    }
    this._transition("SEEKING");
  }

  destroy() {
    this._cleanupState(this.state);
    this.timing.off("change", this._boundOnTimingChange);
    this.video.removeEventListener("play", this._boundOnNativePlay);
    this.video.removeEventListener("pause", this._boundOnNativePause);
  }
}

// Universal Module Definition (UMD) & Legacy Compatibility
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const SyncClass = factory();
    root.MediaSync = SyncClass;
    root.MCorp = root.MCorp || {};
    root.MCorp.mediaSync = function(elem, motion, options) { return new SyncClass(elem, motion, options); };
    root.mediascape = root.mediascape || {};
    root.mediascape.mediaSync = root.MCorp.mediaSync;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return MediaSync;
}));