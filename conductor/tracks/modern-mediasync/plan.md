# Modern MediaSync Implementation Plan

## Phase 1: Core Implementation (Frontend Specialist)
1. **Scaffolding:** Create `modern-mediasync.js`. Define the `ModernMediaSync` class structure, options parsing, and event listener attachments for the Timing Object and the HTMLVideoElement.
2. **Timing Object Integration:** Implement reading from the timing object. Handle `change` events to update the sync state. Support `velocity` extraction.
3. **Latency Tracking:** Implement the `device_latency` estimation logic using `localStorage`. Set a default starting latency (e.g., 100ms).
4. **State Machine & Pre-seeking:** Implement the `SEEKING` and `WAITING` states. 
   - When the timing object starts playing, calculate `target_time`.
   - Set `video.currentTime = target_time`.
   - Setup a high-frequency polling loop (`requestAnimationFrame` or `setTimeout`) to call `video.play()` exactly when `TimingObject.position >= target_time - estimated_latency`.
5. **rVFC Loop & Micro-adjustments:** Implement the `PLAYING` state using `requestVideoFrameCallback`.
   - Compare `metadata.mediaTime` with the current Timing Object position.
   - If drift < 150ms, calculate a compensated `playbackRate`. Use exponential smoothing or a PID controller approach to avoid thrashing.
6. **Macro-adjustments:** If drift > 150ms in the rVFC loop, increment the stored `device_latency` (e.g., add 50ms) and transition back to `SEEKING`.

## Phase 2: Testing & Visualization (Test Engineer)
1. **Mock Timing Object:** Create a simple mock or use an existing Timing Object polyfill for testing.
2. **Test Harness UI:** Create an `index.html` (or `test.html`) that loads a video file, the timing object, and `modern-mediasync.js`.
3. **Visualization:** Add a `<canvas>` or charting library to plot real-time metrics:
   - Device Latency estimate over time.
   - Sync Drift (actual `currentTime` vs target `TimingObject` time).
   - Current `playbackRate`.
4. **Stress Testing:** Add UI controls to test various scenarios:
   - Play/Pause the timing object.
   - Change timing object velocity (0.5x, 1.0x, 2.0x).
   - Simulate CPU load (e.g., busy waiting loops) to force macro-adjustments and watch the latency estimate adapt.

## Phase 3: Refinement & Review (Generalist/Code Reviewer)
1. Review the performance of the rVFC loop.
2. Ensure edge cases are handled (e.g., video ended, buffering/stalled events).
3. Validate that the sync limits relax appropriately when base velocity != 1.0.

## Phase 4: Packaging & Documentation (Product Manager)
1. **Create `dist/` Directory:** Prepare the output directory for production files.
2. **UMD Wrapper:** Wrap the `ModernMediaSync` class in a Universal Module Definition (UMD) to support ES modules/CommonJS and legacy global namespaces in a single file.
   - *Question Answer:* Yes, both ES module/CommonJS support and legacy global namespace (`MCorp.mediaSync`) can be solved in a single file using a UMD wrapper.
3. **Legacy Compatibility:** Ensure `MCorp.mediaSync(video, timing, options)` correctly instantiates and returns the new `ModernMediaSync` object.
4. **JSDoc Documentation:** Review and enhance the JSDoc comments for the class, constructor, and public methods to ensure the final file is well-documented.
5. **Generate `dist/mediasync-v2.js`:** Output the final packaged and documented code.
