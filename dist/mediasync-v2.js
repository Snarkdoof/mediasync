/**
 * MediaSync
 * 
 * Synchronizes an HTMLVideoElement with a W3C Timing Object using modern APIs.
 * 
 * Key Principles:
 * - Architecture & Scalability: Implements a clean State Machine (INIT, SEEKING, WAITING, PLAYING, PAUSED).
 * - Performance & Optimization: Uses requestVideoFrameCallback instead of timeupdate 
 *   for frame-accurate, high-performance synchronization.
 * - Browser-First Thinking: Leverages native performance.now() and native timing expectations.
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
      latencyFudge: 1.000,   // MASSIVE margin to seek ahead (1s) to isolate play latency
      macroThreshold: 0.15,  // >150ms drift triggers macro adjustment (pause & re-seek)
      microThreshold: 0.025, // <25ms drift is considered perfectly in-sync (just let it play)
      skipThreshold: 0.033,  // >33ms drift triggers re-seek in skip mode
      slideTestMode: false,  // If true, stops all adjustments after first hitting perfect sync
      modeKey: "mediasync_v2_mode",
      readyKey: "mediasync_v2_ready_buffer",
      mode: "auto",          // "auto" (use playbackRate) or "skip" (only seek/wait)
      ...options
    };

    // Safari detection (Safari struggles with variable playback rates)
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    
    // Load persisted mode, or default based on browser
    const savedMode = localStorage.getItem(this.options.modeKey);
    if (savedMode === "auto" || savedMode === "skip") {
      this.options.mode = savedMode;
    } else if (isSafari) {
      this.options.mode = "skip";
    }

    this.state = "INIT";
    
    // Empirical estimates from previous runs
    this.estimatedStartupLatency = parseFloat(localStorage.getItem(this.options.latencyKey)) || 0.020;
    this.estimatedSeekTime = parseFloat(localStorage.getItem(this.options.seekKey)) || 0.100;
    this.estimatedReadyBuffer = parseFloat(localStorage.getItem(this.options.readyKey)) || 0.200;
    
    this._vfcId = null;
    this._rafSyncId = null;
    this._waitId = null;
    this._targetTime = 0;
    this._baseVelocity = 0;

    // Measurement timestamps
    this._tSeekStart = 0;
    this._playAllowance = 0;
    this._sampleCount = 0;
    this._smoothedDrift = 0;
    this._currentRawDrift = 0;
    this._hasStartedMoving = false;
    this._framesIgnored = 0;
    this._startupLatencyEvaluated = false;
    this._macroAdjustmentTimes = [];

    // Bound methods for predictable event listener management
    this._boundOnTimingChange = this._onTimingChange.bind(this);
    this._boundSyncLoop = this._syncLoop.bind(this);
    this._boundFallbackSyncLoop = this._fallbackSyncLoop.bind(this);
    this._boundCheckWaiting = this._checkWaiting.bind(this);
    this._boundOnSeeked = this._onSeeked.bind(this);

    this._init();
  }

  _log(...args) {
    if (this.options.debug) {
      const timestamp = (performance.now() / 1000).toFixed(3);
      console.log(`[MediaSync] [${timestamp}]`, ...args);
    }
  }

  _init() {
    this._log("Initializing. Startup Latency:", this.estimatedStartupLatency.toFixed(3), "Seek Time:", this.estimatedSeekTime.toFixed(3));
    this.timing.on("change", this._boundOnTimingChange);
    // Trigger initial state assessment
    this._onTimingChange();
  }

  /**
   * Calculates the position of the timing object at a specific point in time.
   * Crucial for bridging the gap between Timing Object domain and Browser rVFC domain.
   */
  _getTimingPositionAtAccurate() {
      // The timing object's query() returns the position evaluated at the moment query() is called.
      return this.timing.query().position;
  }

  _getTimingPositionAtEvent(eventTime) {
      // eventTime is a DOMHighResTimeStamp (from requestVideoFrameCallback's expectedDisplayTime)
      // Since query().position is evaluated 'now', we calculate dt relative to performance.now().
      // This elegantly avoids needing to know the timing object's internal clock domain (epoch vs page load).
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
        // Update the visual frame if the timing object skipped while paused
        this.video.currentTime = timingTime; 
      }
      this._transition("PAUSED");
      return;
    }

    // Check if completely out of bounds and moving away
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

    // Re-sync if state is stale, velocity changed, or drift is too large
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
        this.video.pause();
        this.video.playbackRate = this._baseVelocity || 1.0;
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
    
    // Strategy: Skip far enough ahead to survive the physical seek AND the engine startup time, 
    // plus a dynamic ready-buffer that ensures we don't miss the start point.
    const delay = this.estimatedSeekTime + this.activeLatency + this.estimatedReadyBuffer;
    let targetTime = nowPos + (this._baseVelocity * delay);
    
    const duration = this.video.duration;
    if (duration && !isNaN(duration)) {
        // If the intended target is out of bounds and moving away, abort and pause.
        // This handles cases where the video naturally ends while PLAYING, triggering a SEEKING loop.
        if ((targetTime >= duration && this._baseVelocity > 0) || 
            (targetTime <= 0 && this._baseVelocity < 0)) {
            this._log("Target time is beyond media range. Pausing.");
            this._transition("PAUSED");
            return;
        }
        
        // Clamp target time for "moving towards bounds" wake-up cases.
        // e.g. Timing Object is at -5s. targetTime will clamp to 0, 
        // and _checkWaiting will correctly wait until the object hits 0 (minus startup latency).
        if (targetTime < 0) targetTime = 0;
        if (targetTime > duration) targetTime = duration;
    }
    
    this._targetTime = targetTime;
    
    this._log(`Seeking to ${this._targetTime.toFixed(3)} (Est seek duration: ${this.estimatedSeekTime.toFixed(3)})`);
    
    this.video.pause();
    this.video.playbackRate = Math.max(0.1, Math.abs(this._baseVelocity));
    this.video.currentTime = this._targetTime;

    this._tSeekStart = performance.now();
    this.video.addEventListener("seeked", this._boundOnSeeked);
  }

  _onSeeked() {
    const actualSeekDuration = (performance.now() - this._tSeekStart) / 1000;
    
    const nowPos = this._getTimingPositionAtAccurate();
    const triggerTime = this._targetTime - (this._baseVelocity * this.activeLatency);
    const timeLeft = (triggerTime - nowPos) / (this._baseVelocity || 1);

    this._log(`Seek completed in ${actualSeekDuration.toFixed(3)}s. Time left to trigger: ${timeLeft.toFixed(3)}s`);

    // Update estimate (weighted moving average)
    this.estimatedSeekTime = (this.estimatedSeekTime * 0.7) + (actualSeekDuration * 0.3);
    localStorage.setItem(this.options.seekKey, this.estimatedSeekTime.toFixed(3));

    this.video.removeEventListener("seeked", this._boundOnSeeked);

    // FAILURE DETECTION: If the seek took so long that we missed the trigger point, we must abort.
    if (timeLeft < 0) {
      // Penalty: Add exactly how much we missed it by, plus a safe 150ms padding
      const penalty = Math.abs(timeLeft) + 0.150;
      this.estimatedReadyBuffer += penalty; 
      this.estimatedReadyBuffer = Math.min(2.0, this.estimatedReadyBuffer);
      localStorage.setItem(this.options.readyKey, this.estimatedReadyBuffer.toFixed(3));
      
      this._log(`SEEK TOO SLOW: Missed trigger by ${Math.abs(timeLeft).toFixed(3)}s. Increasing ready buffer by ${penalty.toFixed(3)}s to ${this.estimatedReadyBuffer.toFixed(3)}s and re-seeking.`);
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
    
    // Strategy: Trigger play at target_time - (startup_latency * velocity)
    const triggerTime = this._targetTime - (this._baseVelocity * this.activeLatency);
    
    // Support non-1 playback speeds (and directional checks)
    const reachedTrigger = this._baseVelocity > 0 ? (nowPos >= triggerTime) : (nowPos <= triggerTime);

    if (reachedTrigger) {
      // FAILURE DETECTION: If we reached the trigger time but the video is still internally seeking,
      // we are late. Increase the ready buffer and try again.
      if (this.video.seeking) {
        this.estimatedReadyBuffer += 0.200; // Add 200ms penalty
        this.estimatedReadyBuffer = Math.min(2.0, this.estimatedReadyBuffer); // Cap at 2s
        localStorage.setItem(this.options.readyKey, this.estimatedReadyBuffer.toFixed(3));
        this._log(`MISSED TRAIN: Player still seeking at trigger time. Increasing ready buffer to ${this.estimatedReadyBuffer.toFixed(3)}s and re-seeking.`);
        this._transition("SEEKING");
        return;
      }

      // SUCCESS: How much idle time did we actually have?
      const idleTime = (performance.now() - this._tSeekStart) / 1000 - this.estimatedSeekTime;
      if (idleTime > 0.300) {
        // If we were idle for a long time (> 300ms), aggressively shrink the buffer
        // We shrink it by 20% of the difference between our idle time and a tight 150ms target.
        const excessiveIdle = idleTime - 0.150;
        this.estimatedReadyBuffer -= (excessiveIdle * 0.20); 
        this.estimatedReadyBuffer = Math.max(0.050, this.estimatedReadyBuffer); // Floor at 50ms
        localStorage.setItem(this.options.readyKey, this.estimatedReadyBuffer.toFixed(3));
        this._log(`Buffer optimization: Idle for ${idleTime.toFixed(3)}s. Shrunk ready buffer to ${this.estimatedReadyBuffer.toFixed(3)}s.`);
      }

      // Exactly how much runway (in media seconds) did we actually give the engine?
      this._playAllowance = (this._targetTime - nowPos) / this._baseVelocity;

      this._log(`Triggering play. Target: ${this._targetTime.toFixed(3)} (At: ${nowPos.toFixed(3)}, Allowance: ${this._playAllowance.toFixed(3)}s, Buffer: ${this.estimatedReadyBuffer.toFixed(3)}s)`);
      this._transition("PLAYING"); 
      
      this.video.play().catch(err => {
        if (err.name !== 'AbortError') {
          this._log("Play failed", err);
          this._transition("PAUSED");
        }
      });
    } else {
      this._waitId = requestAnimationFrame(this._boundCheckWaiting);
    }
  }

  _startPlaying() {
    this._testDriftLocked = false;
    this._tPlayCall = performance.now();
    
    // We launch a requestAnimationFrame fallback by default because it works for pure Audio.
    this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);

    // If rVFC is supported (and it's a VIDEO tag that might have frames), we start it too.
    // If it fires, it will automatically cancel the rAF fallback.
    if (typeof this.video.requestVideoFrameCallback === "function" && this.video.tagName === 'VIDEO') {
      this._vfcId = this.video.requestVideoFrameCallback((now, metadata) => {
         if (this._rafSyncId) {
             this._log("rVFC fired successfully. Cancelling rAF fallback.");
             cancelAnimationFrame(this._rafSyncId);
             this._rafSyncId = null;
         }
         this._boundSyncLoop(now, metadata);
      });
    }
  }

  get activeLatency() {
    if (typeof this.manualLatencyOverride === "number") {
      return this.manualLatencyOverride;
    }
    return this.estimatedStartupLatency;
  }

  get currentSmoothedDrift() {
    return this._smoothedDrift;
  }

  get currentRawDrift() {
    return this._currentRawDrift;
  }

  _getSmoothedDrift(drift) {
    this._sampleCount++;
    if (this._sampleCount === 1) {
      this._smoothedDrift = drift;
    } else {
      // Exponential Moving Average (EMA)
      // alpha = 0.05 provides heavy smoothing (equivalent to ~20 frame window)
      const alpha = 0.05;
      this._smoothedDrift = (alpha * drift) + (1 - alpha) * this._smoothedDrift;
    }
    return this._smoothedDrift;
  }

  _fallbackSyncLoop(now) {
    if (this.state !== "PLAYING") return;

    const mediaTime = this.video.currentTime;

    // Do not start tracking drift or samples until the engine has actually started emitting new frames
    if (!this._hasStartedMoving) {
      if (Math.abs(mediaTime - this._targetTime) > 0.001) {
        this._hasStartedMoving = true;
        this._log(`Engine has started moving. Initial media movement: ${(mediaTime - this._targetTime).toFixed(3)}s`);
      } else {
        this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
        return;
      }
    }

    if (this._framesIgnored < 5) {
      this._framesIgnored++;
      this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
      return;
    }

    const timingPos = this._getTimingPositionAtAccurate();
    const drift = timingPos - mediaTime;
    this._currentRawDrift = drift;
    const smoothedDrift = this._getSmoothedDrift(drift);

    // Natural stable evaluation point
    const elapsedSincePlay = performance.now() - this._tPlayCall;
    if (!this._startupLatencyEvaluated) {
      let isStable = false;
      if (this.options.mode === "skip") {
        if (elapsedSincePlay > 5000) isStable = true;
      } else {
        if (elapsedSincePlay > 2000) isStable = true; // Wait 2 seconds for a clean read
      }
      
      if (isStable) {
        this._startupLatencyEvaluated = true;
        this._evaluateStartupLatency(smoothedDrift);
      }
    }

    if (this.options.mode === "skip") {
      // In skip mode, we don't use micro-adjustments. If drift exceeds skipThreshold, we jump.
      if (Math.abs(smoothedDrift) > this.options.skipThreshold && !this._testDriftLocked && elapsedSincePlay > 1000) {
        if (!this._startupLatencyEvaluated) {
          this._startupLatencyEvaluated = true;
          this._evaluateStartupLatency(smoothedDrift);
        }
        this._log(`Skip mode drift detected: ${smoothedDrift.toFixed(3)}s. Triggering re-seek.`);
        this._applyMacroAdjustment(drift);
      } else {
        // Enforce strict base velocity
        if (Math.abs(this.video.playbackRate - this._baseVelocity) > 0.001) this.video.playbackRate = this._baseVelocity;
        if (this._vfcId !== undefined && typeof this.video.requestVideoFrameCallback === "function" && this.video.tagName === 'VIDEO') {
            this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
        } else {
            this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
        }
      }
    } else {
      // Auto mode: Use raw drift for macro-adjustments so we catch massive stalls immediately
      if (Math.abs(drift) > this.options.macroThreshold && !this._testDriftLocked && elapsedSincePlay > 1000) {
        if (!this._startupLatencyEvaluated) {
          this._startupLatencyEvaluated = true;
          this._evaluateStartupLatency(smoothedDrift);
        }
        this._log(`Macro drift detected: ${drift.toFixed(3)}s. Triggering re-sync.`);
        this._applyMacroAdjustment(drift);
      } else {
        this._applyMicroAdjustment(smoothedDrift, elapsedSincePlay);
        if (this._vfcId !== undefined && typeof this.video.requestVideoFrameCallback === "function" && this.video.tagName === 'VIDEO') {
            this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
        } else {
            this._rafSyncId = requestAnimationFrame(this._boundFallbackSyncLoop);
        }
      }
    }
  }

  _syncLoop(now, metadata) {
    if (this.state !== "PLAYING") return;

    const mediaTime = metadata.mediaTime;

    // Do not start tracking drift or samples until the engine has actually started emitting new frames
    if (!this._hasStartedMoving) {
      if (Math.abs(mediaTime - this._targetTime) > 0.001) {
        this._hasStartedMoving = true;
        this._log(`Engine has started moving. Initial media movement: ${(mediaTime - this._targetTime).toFixed(3)}s`);
      } else {
        this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
        return;
      }
    }

    if (this._framesIgnored < 5) {
      this._framesIgnored++;
      this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
      return;
    }

    // Utilize metadata.expectedDisplayTime for highly accurate alignment
    const timingPos = this._getTimingPositionAtEvent(metadata.expectedDisplayTime);
    const drift = timingPos - mediaTime;
    this._currentRawDrift = drift;
    const smoothedDrift = this._getSmoothedDrift(drift);

    // Natural stable evaluation point
    if (!this._startupLatencyEvaluated) {
      let isStable = false;
      if (this.options.mode === "skip") {
        if ((performance.now() - this._tPlayCall) > 5000) isStable = true;
      } else {
        if (this._sampleCount === 50) isStable = true;
      }
      
      if (isStable) {
        this._startupLatencyEvaluated = true;
        this._evaluateStartupLatency(smoothedDrift);
      }
    }

    if (this.options.mode === "skip") {
      if (Math.abs(smoothedDrift) > this.options.skipThreshold && !this._testDriftLocked && this._sampleCount > 30) {
        if (!this._startupLatencyEvaluated) {
          this._startupLatencyEvaluated = true;
          this._evaluateStartupLatency(smoothedDrift);
        }
        this._log(`Skip mode drift detected: ${smoothedDrift.toFixed(3)}s. Triggering re-seek.`);
        this._applyMacroAdjustment(drift);
      } else {
        // Enforce strict base velocity
        if (Math.abs(this.video.playbackRate - this._baseVelocity) > 0.001) this.video.playbackRate = this._baseVelocity;
        this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
      }
    } else {
      if (Math.abs(drift) > this.options.macroThreshold && !this._testDriftLocked && this._sampleCount > 30) {
        if (!this._startupLatencyEvaluated) {
          this._startupLatencyEvaluated = true;
          this._evaluateStartupLatency(smoothedDrift);
        }
        this._log(`Macro drift detected: ${drift.toFixed(3)}s. Triggering re-sync.`);
        this._applyMacroAdjustment(drift);
      } else {
        const elapsedSincePlay = performance.now() - this._tPlayCall;
        this._applyMicroAdjustment(smoothedDrift, elapsedSincePlay);
        this._vfcId = this.video.requestVideoFrameCallback(this._boundSyncLoop);
      }
    }
  }

  _evaluateStartupLatency(stabilizedDrift) {
    // True Latency = the time we allowed the engine to start + any leftover drift.
    // If we gave the engine 0.1s to start, and it was 0.05s late (drift), it took 0.15s.
    // (drift is measured in media time, so we divide by velocity to get real-world seconds)
    const actualStartupLatency = this._playAllowance + (stabilizedDrift / this._baseVelocity);
    
    if (typeof this.manualLatencyOverride === "number") {
       this._log(`Empirical Startup Latency evaluated: ${actualStartupLatency.toFixed(3)}s (Manual Override Active: ${this.manualLatencyOverride.toFixed(3)}s, Allowance: ${this._playAllowance.toFixed(3)}s)`);
       return; // Do not corrupt the saved estimate if the user is forcing a manual value
    }

    // Update estimate (Aggressive 80% weight on actual so it learns fast!)
    const newLatency = (this.estimatedStartupLatency * 0.2) + (actualStartupLatency * 0.8);
    
    // Prevent crazy numbers from corrupting the state
    this.estimatedStartupLatency = Math.max(0, Math.min(1.000, newLatency));
    
    this._log(`UPDATED LATENCY ESTIMATE: ${this.estimatedStartupLatency.toFixed(3)}s (Actual this run: ${actualStartupLatency.toFixed(3)}s, Allowance: ${this._playAllowance.toFixed(3)}s, Stabilized drift: ${stabilizedDrift.toFixed(3)}s)`);
    
    localStorage.setItem(this.options.latencyKey, this.estimatedStartupLatency.toFixed(3));
  }

  _applyMicroAdjustment(smoothedDrift, elapsedSincePlay) {
    if (this._testDriftLocked) return;

    // Do not apply micro-adjustments until we have a very stable smoothed value AND 
    // we have waited for the latency evaluation (2000ms). If we adjust speed before 
    // evaluating latency, our own speed tweaks will corrupt the latency measurement!
    if (elapsedSincePlay < 2000) return;

    const isCurrentlyCorrecting = Math.abs(this.video.playbackRate - this._baseVelocity) > 0.001;

    if (isCurrentlyCorrecting) {
      // If we are currently correcting, keep going until we hit the exact center (0ms)
      const isCatchingUp = this.video.playbackRate > this._baseVelocity;
      
      // We crossed the center if the drift sign flipped
      const crossedCenter = isCatchingUp ? (smoothedDrift <= 0) : (smoothedDrift >= 0);

      if (crossedCenter) {
        this._log(`Perfect center achieved (${(smoothedDrift * 1000).toFixed(1)}ms). Restoring base velocity: ${this._baseVelocity}`);
        this.video.playbackRate = this._baseVelocity;
        
        // Reset smoothing counter so we start fresh observing the "natural" playback speed
        this._sampleCount = 0;

        if (this.options.slideTestMode) {
          this._log("SLIDE TEST MODE: Locking playback speed. No further adjustments will be made.");
          this._testDriftLocked = true;
        }
      }
      // If we haven't crossed the center, just return and let it keep correcting
      return;
    }

    // If we are NOT currently correcting, check if we drifted outside the acceptable window
    if (Math.abs(smoothedDrift) > this.options.microThreshold) {
      // Determine direction of correction
      const isLate = smoothedDrift > 0;
      
      // Calculate a fixed compensation speed (0.5% adjustment). 
      const correctionFactor = 0.005; 
      const targetRate = isLate ? this._baseVelocity * (1 + correctionFactor) : this._baseVelocity * (1 - correctionFactor);
      
      this._log(`Drift exceeded threshold (${(smoothedDrift * 1000).toFixed(1)}ms). Locking playbackRate to ${targetRate.toFixed(3)} until centered.`);
      this.video.playbackRate = targetRate;
    }
  }

  _applyMacroAdjustment(drift) {
    const now = performance.now();
    this._macroAdjustmentTimes.push(now);
    
    // Keep only adjustment records from the last 30 seconds
    this._macroAdjustmentTimes = this._macroAdjustmentTimes.filter(t => now - t <= 30000);

    // If we had to hard-skip 2 or more times in 30 seconds while in 'auto' mode,
    // the variable playback rate is failing to keep up with clock drift.
    if (this.options.mode === "auto" && this._macroAdjustmentTimes.length >= 2) {
      this._log("Multiple macro adjustments within 30s. Variable playback rate seems unstable. Falling back to SKIP mode permanently.");
      this.options.mode = "skip";
      localStorage.setItem(this.options.modeKey, "skip");
      // Clear array so we don't spam logs if skip mode also triggers jumps
      this._macroAdjustmentTimes = []; 
    }

    this._transition("SEEKING");
  }

  /**
   * Safe teardown mechanism
   */
  destroy() {
    this._cleanupState(this.state);
    this.timing.off("change", this._boundOnTimingChange);
    this._log("Destroyed and decoupled");
  }
}

// Universal Module Definition (UMD) & Legacy Compatibility
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    // Global assignment
    const SyncClass = factory();
    root.MediaSync = SyncClass;
    
    // Legacy MCorp/Mediascape compatibility wrapper
    root.MCorp = root.MCorp || {};
    root.MCorp.mediaSync = function(elem, motion, options) {
       return new SyncClass(elem, motion, options);
    };
    
    root.mediascape = root.mediascape || {};
    root.mediascape.mediaSync = root.MCorp.mediaSync;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return MediaSync;
}));