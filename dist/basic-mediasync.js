/**
 * BasicMediaSync
 * 
 * A lightweight media synchronization class that provides loose sync 
 * (default 1s threshold) to a W3C Timing Object using standard timeupdate events.
 * Handles native media controls and basic play/pause/velocity matching.
 */
class BasicMediaSync {
  /**
   * @param {HTMLMediaElement} video 
   * @param {Object} timingObject - W3C Timing Object
   * @param {Object} options 
   */
  constructor(video, timingObject, options = {}) {
    if (!(video instanceof HTMLMediaElement)) {
      throw new Error("BasicMediaSync requires an HTMLMediaElement");
    }
    if (!timingObject || typeof timingObject.query !== "function") {
      throw new Error("BasicMediaSync requires a W3C Timing Object");
    }

    this.video = video;
    this.timing = timingObject;
    
    this.options = {
      debug: false,
      threshold: 1.0,  // 1 second drift threshold
      skew: 0.0,       // Offset to add to the timing object position
      ...options
    };

    this._scriptTriggeredAction = false;
    this._baseVelocity = 0;

    this._boundOnTimingChange = this._onTimingChange.bind(this);
    this._boundOnTimeUpdate = this._onTimeUpdate.bind(this);
    this._boundOnNativePlay = this._onNativePlay.bind(this);
    this._boundOnNativePause = this._onNativePause.bind(this);

    this._init();
  }

  _log(...args) {
    if (this.options.debug) {
      const timestamp = (performance.now() / 1000).toFixed(3);
     console.log(`[BasicMediaSync] [${timestamp}]`, ...args);
    }
  }

  _init() {
    this.timing.on("change", this._boundOnTimingChange);
    this.video.addEventListener("timeupdate", this._boundOnTimeUpdate);
    this.video.addEventListener("play", this._boundOnNativePlay);
    this.video.addEventListener("pause", this._boundOnNativePause);
    this._onTimingChange();
  }

  _onNativePlay() {
    if (this._scriptTriggeredAction) return;
    this._log("User Play detected. Updating Timing Object.");
    this.timing.update({ velocity: 1.0 });
  }

  _onNativePause() {
    if (this._scriptTriggeredAction) return;
    this._log("User Pause detected. Updating Timing Object.");
    this.timing.update({ velocity: 0.0 });
  }

  _videoAction(fn) {
    this._scriptTriggeredAction = true;
    try {
      return fn();
    } finally {
      setTimeout(() => { this._scriptTriggeredAction = false; }, 100);
    }
  }

  _onTimingChange() {
    const query = this.timing.query();
    this._baseVelocity = query.velocity;
    const duration = this.video.duration;
    const targetPos = query.position + this.options.skew;
    
    if (this._baseVelocity === 0) {
      if (!this.video.paused) {
        this._log("Timing object paused. Pausing video.");
        this._videoAction(() => this.video.pause());
      }
      // If timing object jumped while paused, sync frame
      if (Math.abs(targetPos - this.video.currentTime) > this.options.threshold) {
         this._videoAction(() => { this.video.currentTime = targetPos; });
      }
      return;
    }

    // Range Check: Pause if outside media bounds and moving away
    if (duration && !isNaN(duration)) {
        if ((targetPos >= duration && this._baseVelocity > 0) || 
            (targetPos <= 0 && this._baseVelocity < 0)) {
            if (!this.video.paused) {
                this._log("Timing object out of bounds. Pausing.");
                this._videoAction(() => this.video.pause());
            }
            return;
        }
    }

    // Ensure playback speed matches timing object
    if (Math.abs(this.video.playbackRate - this._baseVelocity) > 0.01) {
      this._log(`Adjusting playbackRate to ${this._baseVelocity}`);
      this._videoAction(() => { this.video.playbackRate = this._baseVelocity; });
    }

    if (this.video.paused) {
      this._log("Timing object playing. Starting video.");
      this._videoAction(() => {
          this.video.play().catch(e => this._log("Play failed", e));
      });
    }

    this._checkSync();
  }

  _onTimeUpdate() {
    this._checkSync();
  }

  _checkSync() {
    const query = this.timing.query();
    if (query.velocity === 0) return;

    const duration = this.video.duration;
    let targetTime = query.position + this.options.skew;

    // Clamp target time to valid media range
    if (duration && !isNaN(duration)) {
        if (targetTime < 0) targetTime = 0;
        if (targetTime > duration) targetTime = duration;
    }

    const drift = Math.abs(targetTime - this.video.currentTime);
    if (drift > this.options.threshold) {
      this._log(`Sync drift exceeded threshold (${drift.toFixed(2)}s). Seeking to ${targetTime.toFixed(3)}s (Raw: ${query.position.toFixed(3)}s, Skew: ${this.options.skew}s).`);
      this._videoAction(() => { this.video.currentTime = targetTime; });
    }
  }

  get skew() {
    return this.options.skew;
  }

  set skew(value) {
    const num = parseFloat(value);
    if (!isNaN(num) && num !== this.options.skew) {
      this.options.skew = num;
      this._log(`Skew updated to ${this.options.skew}s`);
      this._onTimingChange(); // Trigger re-evaluation
    }
  }

  // Stubbed properties for drop-in compatibility with MediaSync v2
  get activeLatency() { return 0; }
  get currentSmoothedDrift() { return 0; }
  get currentRawDrift() { return 0; }

  destroy() {
    this.timing.off("change", this._boundOnTimingChange);
    this.video.removeEventListener("timeupdate", this._boundOnTimeUpdate);
    this.video.removeEventListener("play", this._boundOnNativePlay);
    this.video.removeEventListener("pause", this._boundOnNativePause);
    this._log("Destroyed");
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
    root.BasicMediaSync = SyncClass;
    root.MCorp = root.MCorp || {};
    root.MCorp.basicMediaSync = function(elem, motion, options) {
       return new SyncClass(elem, motion, options);
    };
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return BasicMediaSync;
}));
