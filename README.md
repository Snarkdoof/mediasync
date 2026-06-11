# MediaSync

A robust, modern, and precise media synchronization library for the web. Pair your HTML5 `<video>` or `<audio>` elements with a W3C Timing Object (or a shared motion model) to achieve perfect frame-accurate playback alignment across multiple devices, browser tabs, and OS environments.

---

## Features

- **LipSync-Accuracy (MediaSync V2):** Achieves synchronization drift under 25ms utilizing modern APIs like `requestVideoFrameCallback` and auto-calibration for startup latency.
- **Resilient Mobile Support (BasicMediaSync):** Highly responsive handling of mobile tab suspension, page foregrounding, and strict browser autoplay restrictions (Safari/iOS) via safe sequential play transitions and pre-seeking.
- **OS-Level Media Controls (TimingMediaSession):** Direct integration with the Media Session API, allowing users to control playback, position, and skip/seek actions from lock screens, notifications, headsets, or keyboards.
- **Universal Module Formats:** Supports ES modules, CommonJS, and legacy global namespaces out of the box.

---

## Installation & Setup

Include the library scripts on your page:

```html
<!-- Core Sync Engine -->
<script src="dist/mediasync-v2.js"></script>
<!-- Or lightweight fallback -->
<script src="dist/basic-mediasync.js"></script>
<!-- OS Controls Router -->
<script src="dist/timing-media-session.js"></script>
```

---

## 1. Core Sync Engines

The library provides two primary synchronization implementations:

### MediaSync V2 (Precision Sync)

Designed for high-precision scenarios (e.g., multi-device synchronized playback, frame-accurate presentations).

```javascript
import { MediaSync } from './dist/mediasync-v2.js';

const video = document.querySelector('video');
const timingObject = new TIMINGSRC.TimingObject();

const sync = new MediaSync(video, timingObject, {
  mode: "auto",          // "auto" (dynamic playbackRate micro-adjustments) or "skip" (seeks only)
  macroThreshold: 0.15,  // Re-syncs via hard seeks if drift exceeds 150ms
  microThreshold: 0.025, // Considers perfect sync if drift is under 25ms
  debug: false
});
```

#### Key Mechanics
- **State Machine Integration:** Managed by explicit states (`INIT`, `SEEKING`, `WAITING`, `PLAYING`, `PAUSED`).
- **rVFC Loop:** Leverages `requestVideoFrameCallback` to calculate exact render times instead of low-performance CPU timers.
- **Auto-Calibration:** Automatically estimates local media start-up latency to pre-seek and align playback before releasing play triggers.

---

### BasicMediaSync (Loose Sync)

A lightweight class suited for lighter workloads, older browsers, or as a reliable fallback.

```javascript
const video = document.querySelector('video');
const timingObject = new TIMINGSRC.TimingObject();

const sync = new BasicMediaSync(video, timingObject, {
  threshold: 1.0, // Maximum allowed drift (in seconds) before seeking
  skew: 0.0,      // Constant offset (in seconds) added to the timing object position
  debug: false
});
```

#### Key Mechanics
- **Tab & Mobile Resume Resiliency:** Listens to `visibilitychange`, `pageshow`, and `focus` events to force quick re-sync evaluations when coming back from background.
- **Sequential play() Guard:** Protects Safari/WebKit from silencing audio by applying `playbackRate` modifications *only* after `.play()` resolves successfully.

---

## 2. TimingMediaSession (OS Media Session Router)

`TimingMediaSession` intercepts OS-level media session events (e.g. lock screens, lock-screen buttons, Bluetooth headset play/pause commands, keyboard media keys) and routes them into the W3C Timing Object, preventing native browser events from disrupting the synchronization loop.

### Initialization

```javascript
const metadata = {
  title: "Synchronized Video Demo",
  artist: "MCorp Developers",
  album: "Sync Suite",
  artwork: [
    { src: "cover.png", sizes: "512x512", type: "image/png" }
  ]
};

// Initializes and binds OS events to the W3C Timing Object
const session = new TimingMediaSession(timingObject, metadata);
```

### Advanced Options & Custom Skip Event Handling

By default, the skip buttons trigger jumps of **30 seconds forward** and **15 seconds backward**. You can fully customize these intervals or completely override skip actions (e.g., jumping between app-defined segment markers):

```javascript
const options = {
  mediaElement: videoElement, // Optional. Automatically synchronizes lock screen progress bar, duration, and playbackState
  duration: 120,             // Optional. Custom duration in seconds (can also be a function: () => duration)
  forwardSkipInterval: 30,  // default: 30
  backwardSkipInterval: 15, // default: 15
  
  // Custom Action Overrides
  onSeekForward: (details) => {
    const q = timingObject.query();
    const nextMarker = getNextSegmentTime(q.position);
    timingObject.update({ position: nextMarker });
  },
  onSeekBackward: (details) => {
    const q = timingObject.query();
    const prevMarker = getPrevSegmentTime(q.position);
    timingObject.update({ position: prevMarker });
  }
};

const session = new TimingMediaSession(timingObject, metadata, options);
```

### Dynamic Action Overrides at Runtime

You can dynamically configure or update custom action handlers (such as headphone buttons) at runtime:

```javascript
// Register a dynamic handler for "next track" button clicks
session.setActionHandler('nexttrack', () => {
  loadNextTrackSegment();
});

// Clear a custom action and reset it to default behavior
session.setActionHandler('seekforward', null);
```

---

## Development & Building

The project relies on a `Makefile` to run building and minification via `terser`.

### Rebuilding assets
```bash
make clean && make build
```

This compiles individual source files into minified bundles inside the `dist/` directory:
- `dist/mediasync-v2.min.js`
- `dist/basic-mediasync.min.js`
- `dist/timing-media-session.min.js`

---

## License

This project is licensed under the terms of the MIT License (see `LICENSE` for details).
