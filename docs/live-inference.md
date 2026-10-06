# Live capture and inference

The Game View toolbar has two independent controls:

- **Inference:** choose CPU or a detected GPU (DirectML). The choice is saved locally and applies to model inference, including the next model you run. Stop recording before changing it so one recording keeps a consistent observation schema. Unsupported devices/model operations report a model error; FireFly does not silently retry the entire model on CPU. ONNX Runtime may assign individual unsupported operations to CPU.
- **Threads** (shown for CPU): how many threads the CPU runs the model on, 2 by default, saved locally. More is faster but leaves less for capture, template matching and the game. On an i7-12700K with a 16-channel UNet at 512×512, one frame took 133 ms on 2 threads, 74 ms on 4, 56 ms on 6, 50 ms on 8 and 42 ms on 12. It's a runtime setting (`inference.threads`), not part of the graph, so changing it doesn't change the observation schema; CPU sessions are cached per thread count.
- **Live capture / Detection view:** Live capture displays fresh raw frames without waiting for model inference or template matching. Detection view shows processed frames, including overlays, at detection speed. Previewing a flow step automatically uses Detection view; choosing Live capture clears that step preview. Switching views resets that view's rewind history.

Template region boxes in Live capture show the latest completed template match, which can be older than the image. The toolbar shows detection age relative to the current capture, and, while a region follows an object, tracking age too. Exact model overlays are available in Detection view, attached to their original image. Rewind keeps template instance boxes only when their timestamp matches the stored frame. Template matching runs on CPU, on a worker of its own (below).

## Runtime behavior

Capture and command handling stay on the main runtime thread. Two workers receive immutable frame/configuration snapshots: the detection worker evaluates the observation graph (model inference, region values, OCR), and the tracking worker does template matching for every region that follows an object, all in the same frame, which it converts and shrinks once for all of them. Neither waits for the other, so a slow CPU model doesn't slow the boxes that follow objects, and tracking gets every captured frame even while a recording limits graph submissions to its rate. Each worker keeps one executing job and one replaceable pending job; new frames replace pending frames rather than building a backlog. Results carry source timestamps and configuration generations. Graph results from a previous target, graph or capture size are discarded, and so are template results from a previous target or capture size. Template results carry each region's context, and the app ignores any from before that region's templates changed. Setting or removing one region's templates doesn't disturb the others. Changing the graph doesn't reset tracking, and changing templates doesn't reset the graph.

Template matching (`native/template_match.cpp`) prepares each template once when it is set: whether it has any detail, and a copy halved up to three times, as long as its shorter side stays at least 10 px. Each frame is halved as often as needed. The shrunk template is scored over the shrunk frame, and every local best there is scored again at full size, following the scores uphill when the best sits at the edge of the few pixels looked at. So reported confidences are always full-size `TM_CCOEFF_NORMED`. Large score maps are computed in bands of rows on several cores. On 1080p MapleStory frames this took one 160×120 template from about 200 ms to 12 ms, three 40×40 templates from 400 ms to 12 ms, and multi-match with two 24×24 templates from 360 ms to 45 ms. It agreed with a full-size search on 98.5% of single-template searches; the misses were weak matches (under about 0.8) or near-identical lookalikes. Templates under 20 px, including the default 12 px corner patches, are always searched at full size.

Recording rates are targets, not a guarantee that a slow detector can produce that many samples. Completed observations use their analyzed frame's timestamp and historical button state. Stopping a recording discards outstanding, unfinished detection samples. Live preview continues independently while recording.

## Building GPU support

Run `npm run native:onnxruntime:gpu`, then `npm run native:configure` and `npm run native:build`. This installs Microsoft's pinned ONNX Runtime 1.20.1 DirectML package and its DirectML 1.15.2 dependency into a separate ignored directory. It preserves the existing CPU-only installation. DirectML requires a supported DirectX 12 GPU/driver. Restart FireFly after building to load the new runtime DLLs.

CMake prefers the GPU-capable runtime when present; CPU inference remains available in that build. Configure with `-DFIREFLY_DIRECTML=OFF` to use the original CPU-only runtime. The setup copies all required runtime DLLs beside the native executables.

## Verification

- `npm run build`: strict TypeScript checking and production renderer build.
- `npm run native:test`: graph, template, recording and bounded detection-worker tests.
- `npm run test:inference-ui`: isolated real renderer/preload tests for controls, persistence, error recovery and recording lock.
- `npm run test:runtime-preview`: real Windows Graphics Capture and inference with `runs/unet/best.onnx`. Opens a small animated lab window, records to an isolated build directory, tests available GPU inference, and checks timestamps and late-result rejection. It sends no keyboard or mouse input. Measurements are saved to `build/runtime-preview-result.json`; they describe this lab workload, not game-wide performance.

DirectML API and deployment requirements: https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html
