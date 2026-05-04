# BasicMediaSync & Native Controls Integration Specification

## Objective
Design and plan an alternative synchronization class, `BasicMediaSync`, which shares the exact interface as `MediaSync` but provides much looser synchronization. Additionally, design a robust mechanism to integrate native media controls (both OS-level via Media Session API and in-page HTML5 controls) so that user interactions update the Timing Object rather than fighting the synchronization script. This native control logic should be applicable to both `BasicMediaSync` and the main `MediaSync` class.

## 1. BasicMediaSync Design

### Interface
Must match the existing `MediaSync` interface:
`constructor(mediaElement, timingObject, options = {})`

### Synchronization Strategy (Loose Sync)
- **Event Driven:** Relies primarily on the `timeupdate` event of the media element (fires roughly every 250ms) rather than high-frequency loops like `requestVideoFrameCallback`.
- **Large Drift Threshold:** Allows a significant drift (e.g., 1.0 seconds by default, configurable via `options.driftThreshold`) before intervening.
- **Minimal Intervention:**
  - Does not use `playbackRate` micro-adjustments.
  - Only performs macro-adjustments: If the absolute difference between `media.currentTime` and the Timing Object's expected position exceeds the threshold, it forcefully sets `media.currentTime = expectedPosition`.
- **State Management:**
  - Monitors Timing Object `change` events.
  - If Timing Object `velocity > 0` and media is paused, it calls `media.play()`.
  - If Timing Object `velocity === 0` and media is playing, it calls `media.pause()`.

## 2. Native Media Controls Integration

### The Problem
When a user interacts with native OS media controls (lock screen, notifications, Bluetooth buttons) or the in-page `<video controls>`, the browser directly changes the state of the media element. A naive sync script will detect this as a "drift" or incorrect state and immediately revert the user's action to match the Timing Object.

### The Solution: Routing Controls to the Timing Object
We must intercept user actions and route them to update the Timing Object. The sync script will then naturally react to the Timing Object change and update the media element, creating a harmonious loop.

#### A. Media Session API (OS-Level Controls)
Use `navigator.mediaSession` to handle hardware and OS-level media controls.
- Set action handlers for `play`, `pause`, `seekto`, `seekforward`, and `seekbackward`.
- When these handlers are triggered, they will call `timingObject.update({ velocity: ... })` or `timingObject.update({ position: ... })`.
- *Note:* Setting these handlers often prevents the browser's default behavior of directly manipulating the media element, which is exactly what we want.

#### B. In-Page Media Controls (HTML5 `<video controls>`)
The Media Session API does not always catch clicks on the standard HTML5 controls rendered inside the page. We must listen to media element events (`play`, `pause`, `seeked`).
- **Distinguishing User vs. Script:** We need a mechanism to know if a `play` event was caused by the user clicking the play button, or by our script calling `media.play()`.
- **Flag-Based Guard:**
  - Introduce internal flags (e.g., `this._ignoreNextPlayEvent`, `this._ignoreNextPauseEvent`).
  - Before the sync script programmatically calls `media.play()`, it sets `this._ignoreNextPlayEvent = true`.
  - In the media element's `play` event listener:
    - If `this._ignoreNextPlayEvent` is true, clear the flag and do nothing (it was our script).
    - If `this._ignoreNextPlayEvent` is false, it was a user action. We then call `timingObject.update({ velocity: 1.0 })`.
  - Apply the same logic for `pause` and `seeked` events.

## Architecture

- **`BasicMediaSync` Class:**
  - Implements the loose sync logic.
  - Integrates the Native Controls logic.
- **Shared/Extracted Native Controls Logic:**
  - The logic for Media Session API and event guarding should ideally be modular so it can be applied to the high-precision `MediaSync` class as well.

## Options
- `driftThreshold`: (Number) Allowed drift in seconds before seeking. Default: `1.0`.
- `integrateMediaSession`: (Boolean) Whether to hook into `navigator.mediaSession`. Default: `true`.
- `routeInPageControls`: (Boolean) Whether to route in-page media events to the Timing Object. Default: `true`.