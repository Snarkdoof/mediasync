/**
 * TimingMediaSession
 * 
 * Intercepts OS-level Media Session events (Lock screen, Bluetooth, Notifications)
 * and routes them to a W3C Timing Object.
 */
class TimingMediaSession {
  /**
   * @param {Object} timingObject - W3C Timing Object
   * @param {Object} metadata - Optional MediaMetadata init object or options
   * @param {Object} options - Optional configuration options
   */
  constructor(timingObject, metadata = {}, options = {}) {
    if (!timingObject || typeof timingObject.update !== "function") {
      throw new Error("TimingMediaSession requires a W3C Timing Object");
    }

    this.timing = timingObject;

    // Detect if metadata parameter is actually options
    const isMetadata = (obj) => {
      if (!obj || typeof obj !== 'object') return false;
      const metadataKeys = ['title', 'artist', 'album', 'artwork'];
      return Object.keys(obj).some(k => metadataKeys.includes(k));
    };

    let meta = metadata;
    let opts = options;

    if (Object.keys(metadata).length > 0 && !isMetadata(metadata) && Object.keys(options).length === 0) {
      opts = metadata;
      meta = {};
    }

    this.options = {
      forwardSkipInterval: 30,
      backwardSkipInterval: 15,
      mediaElement: null,
      duration: null,
      ...opts
    };

    this._boundOnTimingChange = () => {
      if (!('mediaSession' in navigator)) return;
      const query = this.timing.query();
      
      this.setPlaybackState(query.velocity === 0 ? 'paused' : 'playing');
      this._updatePositionState(query);
    };

    this._boundOnDurationChange = null;

    if ('mediaSession' in navigator) {
      this._setupHandlers();
      
      this.timing.on("change", this._boundOnTimingChange);
      
      if (this.options.mediaElement instanceof HTMLMediaElement) {
        this._boundOnDurationChange = () => {
          this._updatePositionState(this.timing.query());
        };
        this.options.mediaElement.addEventListener("durationchange", this._boundOnDurationChange);
      }
      
      this._boundOnTimingChange(); // Initial position & state sync

      if (Object.keys(meta).length > 0) {
        this.updateMetadata(meta);
      }
    }
  }

  _getOverride(action) {
    const actionLower = action.toLowerCase();
    if (typeof this.options[actionLower] === 'function') return this.options[actionLower];

    const camelMap = {
      'seekforward': 'onSeekForward',
      'seekbackward': 'onSeekBackward',
      'seekto': 'onSeekTo',
      'nexttrack': 'onNextTrack',
      'previoustrack': 'onPreviousTrack',
      'skipad': 'onSkipAd',
      'play': 'onPlay',
      'pause': 'onPause',
      'stop': 'onStop'
    };
    const camelKey = camelMap[actionLower];
    if (camelKey && typeof this.options[camelKey] === 'function') {
      return this.options[camelKey];
    }

    const capKey = 'on' + action.charAt(0).toUpperCase() + action.slice(1);
    if (typeof this.options[capKey] === 'function') return this.options[capKey];

    return null;
  }

  _setupHandlers() {
    const ms = navigator.mediaSession;

    const setupAction = (action, defaultHandler) => {
      const override = this._getOverride(action);
      try {
        if (override) {
          ms.setActionHandler(action, override);
        } else if (defaultHandler) {
          ms.setActionHandler(action, defaultHandler);
        } else {
          ms.setActionHandler(action, null);
        }
      } catch (e) {
        console.warn(`[TimingMediaSession] Action handler '${action}' not supported on this browser/platform.`, e);
      }
    };

    setupAction('play', (details) => {
      console.log("[MediaSession] OS Play command received");
      this.timing.update({ velocity: 1.0 });
    });

    setupAction('pause', (details) => {
      console.log("[MediaSession] OS Pause command received");
      this.timing.update({ velocity: 0.0 });
    });

    setupAction('stop', (details) => {
      console.log("[MediaSession] OS Stop command received");
      this.timing.update({ velocity: 0.0, position: 0 });
    });

    setupAction('seekto', (details) => {
      console.log("[MediaSession] OS Seek command received:", details.seekTime);
      this.timing.update({ position: details.seekTime });
    });

    setupAction('seekbackward', (details) => {
      console.log("[MediaSession] OS SeekBackward command received");
      const q = this.timing.query();
      const offset = details.seekOffset || this.options.backwardSkipInterval;
      this.timing.update({ position: Math.max(0, q.position - offset) });
    });

    setupAction('seekforward', (details) => {
      console.log("[MediaSession] OS SeekForward command received");
      const q = this.timing.query();
      const offset = details.seekOffset || this.options.forwardSkipInterval;
      this.timing.update({ position: q.position + offset });
    });

    setupAction('previoustrack', null);
    setupAction('nexttrack', null);
    setupAction('skipad', null);
  }

  /**
   * Registers or updates a Media Session action handler.
   * Can be used to override default skip/seek behaviors or handle next/prev track events.
   * @param {string} action - Action name (e.g., 'play', 'pause', 'seekforward', 'seekbackward', 'nexttrack', 'previoustrack')
   * @param {function|null} handler - Custom callback function, or null to restore/disable
   */
  setActionHandler(action, handler) {
    if (!('mediaSession' in navigator)) return;

    const actionLower = action.toLowerCase();
    const capKey = 'on' + actionLower.charAt(0).toUpperCase() + actionLower.slice(1);

    if (handler === null) {
      delete this.options[capKey];
      const camelMap = {
        'seekforward': 'onSeekForward',
        'seekbackward': 'onSeekBackward',
        'seekto': 'onSeekTo',
        'nexttrack': 'onNextTrack',
        'previoustrack': 'onPreviousTrack',
        'skipad': 'onSkipAd',
        'play': 'onPlay',
        'pause': 'onPause',
        'stop': 'onStop'
      };
      const camelKey = camelMap[actionLower];
      if (camelKey) delete this.options[camelKey];
      delete this.options[actionLower];
    } else {
      this.options[capKey] = handler;
    }

    this._setupHandlers();
  }

  /**
   * Updates the visual metadata shown on the OS lock screen
   * @param {Object} data - {title, artist, album, artwork: [{src, sizes, type}]}
   */
  updateMetadata(data) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata(data);
    }
  }

  /**
   * Manually update the OS playback state (playing/paused)
   * Note: This is usually handled automatically if a media element is playing,
   * but can be forced here.
   */
  setPlaybackState(state) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state; // 'playing', 'paused', or 'none'
    }
  }

  _updatePositionState(query) {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;

    try {
      const duration = this.getDuration();
      if (duration && !isNaN(duration) && duration > 0) {
        const position = Math.max(0, Math.min(duration, query.position));
        const playbackRate = Math.abs(query.velocity);
        
        navigator.mediaSession.setPositionState({
          duration: duration,
          playbackRate: playbackRate > 0 ? playbackRate : 1.0,
          position: position
        });
      }
    } catch (e) {
      console.warn("[TimingMediaSession] Failed to set position state:", e);
    }
  }

  getDuration() {
    if (typeof this.options.duration === 'function') {
      return this.options.duration();
    }
    if (typeof this.options.duration === 'number') {
      return this.options.duration;
    }
    if (this.options.mediaElement instanceof HTMLMediaElement) {
      return this.options.mediaElement.duration;
    }
    return null;
  }

  destroy() {
    if (this._boundOnTimingChange) {
      this.timing.off("change", this._boundOnTimingChange);
    }
    if (this._boundOnDurationChange && this.options.mediaElement) {
      this.options.mediaElement.removeEventListener("durationchange", this._boundOnDurationChange);
    }
  }
}

// Universal Module Definition (UMD)
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TimingMediaSession = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return TimingMediaSession;
}));