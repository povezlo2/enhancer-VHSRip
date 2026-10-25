# Third-party notices

Enhancer VHSRip's own source code is MIT-licensed (see `LICENSE`).

The external tools below are **not** stored in this repository. `npm run setup` downloads them into `bin/` from their official releases. The app runs them as separate processes (`child_process.spawn`); it does not link against them.

If you distribute a packaged build that includes `bin/`, ship the corresponding licenses with it.

| Component | Source | License |
|---|---|---|
| Real-ESRGAN ncnn-vulkan (binary) | https://github.com/xinntao/Real-ESRGAN | BSD 3-Clause |
| Real-ESRGAN models (`realesr-animevideov3`, `realesrgan-x4plus`) | https://github.com/xinntao/Real-ESRGAN | BSD 3-Clause |
| ncnn (inside the binary) | https://github.com/Tencent/ncnn | BSD 3-Clause |
| FFmpeg (Windows GPL build) | https://github.com/BtbN/FFmpeg-Builds | GPL v3 (includes x264) |
| GFPGAN v1.4 (`gfpgan_1.4.onnx`) | https://github.com/TencentARC/GFPGAN, ONNX export by https://huggingface.co/facefusion/models-3.0.0 | Apache 2.0 |
| YuNet face detector (`face_detection_yunet_2023mar.onnx`) | https://github.com/opencv/opencv_zoo | MIT |
| ONNX Runtime (npm `onnxruntime-node`, incl. DirectML on Windows) | https://github.com/microsoft/onnxruntime | MIT |
| sharp / libvips (npm) | https://github.com/lovell/sharp | Apache 2.0 / LGPL-3.0 (libvips) |

## FFmpeg

The Windows build from BtbN is a GPL build. If you redistribute it, for example inside an installer:

- include its `LICENSE.txt` (`npm run setup` copies it to `bin/ffmpeg/`);
- point to the corresponding source code: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org/download.html.

## npm dependencies

Angular, Electron and the other npm packages come with their own licenses (mostly MIT). They are listed in `package-lock.json` and inside `node_modules/*/LICENSE`.
