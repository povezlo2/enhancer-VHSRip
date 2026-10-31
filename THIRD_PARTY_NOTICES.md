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
| CodeFormer (`codeformer.onnx`) | https://github.com/sczhou/CodeFormer, ONNX export by https://huggingface.co/facefusion/models-3.0.0 | S-Lab License 1.0 (**non-commercial**) |
| YuNet face detector (`face_detection_yunet_2023mar.onnx`) | https://github.com/opencv/opencv_zoo | MIT |
| ONNX Runtime (npm `onnxruntime-node`, incl. DirectML on Windows) | https://github.com/microsoft/onnxruntime | MIT |
| sharp / libvips (npm) | https://github.com/lovell/sharp | Apache 2.0 / LGPL-3.0 (libvips) |

## CodeFormer

CodeFormer's weights are released under the S-Lab License 1.0, which allows **non-commercial use only**. The app works without it (GFPGAN is the Apache-2.0 alternative). Do not ship `codeformer.onnx` in a commercial product, and check the license before redistributing it: https://github.com/sczhou/CodeFormer/blob/master/LICENSE

## FFmpeg

The Windows build from BtbN is a GPL build. If you redistribute it, for example inside an installer:

- include its `LICENSE.txt` (`npm run setup` copies it to `bin/ffmpeg/`);
- point to the corresponding source code: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org/download.html.

## Claude Code skill: ffmpeg-skill

`.claude/skills/ffmpeg-skill/` is a vendored copy of [ffmpeg-skill](https://github.com/povezlo2/ffmpeg-skill) 3.1.1 (fork of https://github.com/kajisho5/ffmpeg-skill), MIT, license in that folder. It is a development aid for coding agents working in this repository (local FFmpeg editing tools), not part of the app. Installed with `node bin/install.js --project` from the fork, keeping only `docs/contract.md` from `docs/` like the npm package does. To update: run the installer again from a newer checkout and repeat that trim.

## npm dependencies

Angular, Electron and the other npm packages come with their own licenses (mostly MIT). They are listed in `package-lock.json` and inside `node_modules/*/LICENSE`.
