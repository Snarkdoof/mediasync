# MediaSync API & Library Documentation

This library provides synchronization of HTML5 `<video>` or `<audio>` media elements with W3C Timing Objects (or similar shared motion models). It is designed to offer frame-accurate playback alignment across multiple devices and browser tabs.

There are two primary synchronization implementations available:
1. **BasicMediaSync (basic-mediasync.js):** A lightweight class that provides loose sync (default 1s drift threshold) using standard HTML5 media events like `timeupdate`. Best suited for simpler/lighter integrations or as a fallback.
2. **MediaSync V2 (mediasync-v2.js):** A highly precise class implementing a clean state machine and modern Web APIs (like `requestVideoFrameCallback` or high-resolution DOMTimestamps) to achieve synchronization drifts below 25ms (lipsync precision).

---

## 1. BasicMediaSync

### Usage

Include the library on your page:
```html
<script src="dist/basic-mediasync.js"></script>
```

Initialize it by pairing your HTMLMediaElement with a W3C Timing Object:
```javascript
const video = document.querySelector('video');
const timingObject = new TIMINGSRC.TimingObject();

const sync = new BasicMediaSync(video, timingObject, {
  threshold: 1.0, // Maximum allowed drift (in seconds) before seeking
  skew: 0.0,      // Constant offset (in seconds) to add to the timing object position
  debug: false    // Enable console logging
});
```

### Mobile & Tab Resume Resiliency (Autoplay Policies)

`BasicMediaSync` includes robust handling for mobile resumes and tab suspension/foregrounding:
1. **Visibility & Focus Change Tracking:** Listens to `visibilitychange`, `pageshow`, and `focus` events on mobile. If a backgrounded tab is resumed, it triggers an immediate sync state re-evaluation.
2. **Safe Resume Seeking:** If the media element is paused on resume, any large drift is corrected via a `currentTime` seek *prior* to calling `.play()`. This prevents WebKit/Safari "hot-seeking" glitches during play transitions.
3. **Sequential play() & playbackRate:** Modifying a media element's `playbackRate` while paused or in transition on WebKit/Safari can trigger an internal audio pipeline reset, resulting in silent playback. `BasicMediaSync` ensures `playbackRate` changes are applied *only* after `.play()` resolves successfully (or while the media is already playing).

---

## 2. MediaSync V2 (Precision Sync)

### Usage

```javascript
import { MediaSync } from './dist/mediasync-v2.js';

const sync = new MediaSync(video, timingObject, {
  mode: "auto",          // "auto" (uses playbackRate micro-adjustments) or "skip" (seeks only)
  macroThreshold: 0.15,  // Jumps/re-syncs if drift exceeds 150ms
  microThreshold: 0.025, // Considers perfect sync if drift is under 25ms
  debug: true
});
```

### Key Principles

* **State Machine:** Governed by clear states: `INIT`, `SEEKING`, `WAITING`, `PLAYING`, `PAUSED`.
* **rVFC Sync Loop:** Uses `requestVideoFrameCallback` to obtain accurate frame render times and display alignment, bypassing low-performance standard timers.
* **Auto-Calibration:** Dynamically estimates physical seek latency and media engine start times to pre-seek and trigger playback ahead of time, ensuring perfect alignment at the trigger instant.

## 3. TimingMediaSession (OS Media Session Integration)

`TimingMediaSession` intercepts OS-level media session controls (e.g. lock screen, notifications, headset/Bluetooth buttons, keyboards) and routes them directly to a W3C Timing Object, keeping everything perfectly in sync.

### Usage

Include the script:
```html
<script src="dist/timing-media-session.js"></script>
```

Initialize with a Timing Object and optional metadata:
```javascript
const timing = new TIMINGSRC.TimingObject();

const metadata = {
  title: "My Synchronized Video",
  artist: "MCorp Developer",
  album: "Demos"
};

const session = new TimingMediaSession(timing, metadata);
```

### Configurable Options & Skip Behavior

`TimingMediaSession` accepts a third argument `options = {}` (or as the second argument if metadata is omitted):

```javascript
const options = {
  mediaElement: video,      // Optional. Automatically synchronizes lock screen progress bar, duration, and playbackState
  duration: 120,            // Optional. Custom duration in seconds (can also be a function: () => duration)
  forwardSkipInterval: 30,  // Interval (in seconds) for seekforward events. Default: 30
  backwardSkipInterval: 15, // Interval (in seconds) for seekbackward events. Default: 15
  
  // Custom action overrides (optional)
  onSeekForward: (details) => {
    console.log("App-specific seek forward handler!");
    // e.g. Skip to next application segment/marker instead of a generic time jump
    const nextMarker = getNextMarkerPosition();
    timing.update({ position: nextMarker });
  },
  onSeekBackward: (details) => {
    const prevMarker = getPreviousMarkerPosition();
    timing.update({ position: prevMarker });
  }
};

const session = new TimingMediaSession(timing, metadata, options);
```

### Dynamic Action Overrides

You can register or update custom action handlers dynamically after initialization using `.setActionHandler(action, callback)`:

```javascript
// Map the "next track" lock-screen button to a custom function
session.setActionHandler("nexttrack", (details) => {
  goToNextTrack();
});

// Map skip forward/backward to custom segment-based jumps
session.setActionHandler("seekforward", (details) => {
  jumpToNextSegment();
});

// Reset an action to its default timing-object behavior
session.setActionHandler("seekforward", null);
```

---

## 4. Deployment Info

These scripts are built and deployed as static assets.
* **Production CDN URL:** `https://www.mcorp.no/lib/mediasync-v2.js`
* **Alternate URL:** `https://www.mcorp.no/lib/basic-mediasync.js`
* **Media Session URL:** `https://www.mcorp.no/lib/timing-media-session.js`

To rebuild the distribution and minified files, use the Makefile:
```bash
make build
```
*(Note: If building behind strict proxy/npm registries, append `--registry=https://registry.npmjs.org` to `npx terser` if needed).*
