/**
 * TimingMediaSession
 * 
 * Intercepts OS-level Media Session events (Lock screen, Bluetooth, Notifications)
 * and routes them to a W3C Timing Object.
 */
class TimingMediaSession {
  /**
   * @param {Object} timingObject - W3C Timing Object
   * @param {Object} metadata - Optional MediaMetadata init object
   */
  constructor(timingObject, metadata = {}) {
    if (!timingObject || typeof timingObject.update !== "function") {
      throw new Error("TimingMediaSession requires a W3C Timing Object");
    }

    this.timing = timingObject;

    if ('mediaSession' in navigator) {
      this._setupHandlers();
      if (Object.keys(metadata).length > 0) {
        this.updateMetadata(metadata);
      }
    }
  }

  _setupHandlers() {
    const ms = navigator.mediaSession;

    ms.setActionHandler('play', () => {
      console.log("[MediaSession] OS Play command received");
      this.timing.update({ velocity: 1.0 });
    });

    ms.setActionHandler('pause', () => {
      console.log("[MediaSession] OS Pause command received");
      this.timing.update({ velocity: 0.0 });
    });

    ms.setActionHandler('stop', () => {
      console.log("[MediaSession] OS Stop command received");
      this.timing.update({ velocity: 0.0, position: 0 });
    });

    ms.setActionHandler('seekto', (details) => {
      console.log("[MediaSession] OS Seek command received:", details.seekTime);
      this.timing.update({ position: details.seekTime });
    });

    // Optional handlers
    try {
        ms.setActionHandler('seekbackward', (details) => {
            const q = this.timing.query();
            const offset = details.seekOffset || 10;
            this.timing.update({ position: Math.max(0, q.position - offset) });
        });
        ms.setActionHandler('seekforward', (details) => {
            const q = this.timing.query();
            const offset = details.seekOffset || 10;
            this.timing.update({ position: q.position + offset });
        });
    } catch(e) {}
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