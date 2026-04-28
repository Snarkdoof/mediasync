# Modern MediaSync Specification

## Objective
Create a modern, highly accurate media synchronization object (`ModernMediaSync`) that synchronizes an HTML5 `HTMLVideoElement` with a W3C Timing Object. It will replace the legacy `mediasync.js` implementation by leveraging modern web APIs (`requestVideoFrameCallback`) and a pre-seeking state machine.

## Key Features & Requirements

1. **requestVideoFrameCallback (rVFC):**
   - The primary synchronization loop must use `requestVideoFrameCallback` to access `mediaTime` and `expectedDisplayTime`.
   - This provides frame-accurate timing, replacing the inaccurate `timeupdate` event.

2. **Device Latency Estimation:**
   - The system must calculate and store the "device latency" (the time delay between issuing a `play()` command and the first frame being presented on screen).
   - This estimate should be stored locally (e.g., `localStorage` under `modern_mediasync_latency`) to optimize startup times across sessions.
   - If the player misses its target (plays too late), the latency estimate should be increased.

3. **Pre-seeking Strategy (Fast Startup):**
   - When preparing to play, the system should *not* just seek to the current time and hit play.
   - It should calculate a future target time: `target_time = current_timing_object_time + estimated_latency + safe_fudge_margin`.
   - It will pause the media, seek to `target_time`, and wait.
   - It will unpause the media exactly when the timing object reaches `target_time - estimated_latency`.

4. **Micro vs. Macro Adjustments:**
   - **Micro-adjustments (< 150ms error):** If the video drifts slightly, adjust the `playbackRate` to catch up or slow down gradually. The audio pitch correction in modern browsers will handle this smoothly.
   - **Macro-adjustments (> 150ms error):** If the video is significantly out of sync (e.g., due to buffering or CPU spikes):
     - Pause the video.
     - Increase the estimated device latency.
     - Re-trigger the pre-seeking strategy (seek ahead, wait, play).
     - *Preference:* It is better to "wait" 150ms (pause and resume) than to skip abruptly or play extremely fast.

5. **Variable Playback Speeds:**
   - The Timing Object may have a `velocity` other than 1.0 (e.g., 0.5, 2.0).
   - The sync object must pass this base velocity to the media element's `playbackRate`.
   - Micro-adjustments will be relative to this base velocity.
   - Synchronization thresholds may need to be adjusted (loosened) when playing at non-standard speeds.

6. **Packaging & Compatibility:**
   - The final output must be a production-ready library named `mediasync-v2.js` located in a `dist/` directory.
   - It must support modern ES module imports and CommonJS environments.
   - It must support legacy global namespace usage, specifically backwards compatibility so that `<script>` tag users can call `sync = MCorp.mediaSync(video, timing, options);`.
   - Both modern and legacy compatibility must be solved in a single file using a Universal Module Definition (UMD) wrapper.
   - The code must be well-documented with JSDocs.

## Architecture

- **`ModernMediaSync` Class:**
  - constructor: `constructor(mediaElement, timingObject, options = {})`
  - Internal State Machine:
    - `INIT`: Reading initial values, attaching listeners.
    - `SEEKING`: Paused, setting `currentTime` to a future point.
    - `WAITING`: Paused, polling to hit the exact start time.
    - `PLAYING`: Playing, monitoring rVFC for drift.
  - Options:
    - `debug`: boolean for console logging.
    - `latencyFudge`: baseline margin to add to latency (e.g., 50ms).
    - `macroThreshold`: drift threshold to trigger a re-sync (default 0.15s).

## Dependencies
- Standard HTML5 `HTMLVideoElement` (must support `requestVideoFrameCallback`).
- A W3C-compatible Timing Object (or polyfill exposing `.query()`, `.on("change", ...)`).
