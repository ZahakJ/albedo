# Models

The AI features run local ONNX models in the AI worker (`src/workers/ai.worker.js`) through onnxruntime-web: on the GPU through WebGPU where the browser has it, otherwise on the CPU. Nothing leaves the machine.

`npm run setup-models` downloads each model from its source, checks its SHA-256, and writes it to `public/models/`; the Pages build does the same. The list lives in `src/engine/models.js`.

| feature | model | license | source | file | size |
|---|---|---|---|---|---|
| Subject and Background masks; Compose's Select Subject | [ISNet](https://github.com/xuebinqin/DIS) general use | Apache-2.0 | [rembg release](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) | `isnet-general-use.onnx` | 91 MB |
| Sky mask; Compose's Select Sky | [Sky segmentation](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing) (U²-Net) | MIT | [Hugging Face](https://huggingface.co/JianyuanWang/skyseg) | `skyseg.onnx` | 88 MB |
| Object selection, in Develop and Compose | [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) encoder and decoder | Apache-2.0 | [Hugging Face](https://huggingface.co/Acly/MobileSAM) | `mobile_sam_image_encoder.onnx`, `sam_mask_decoder_multi.onnx` | 28 + 16 MB |
| Remove; Compose's content-aware fill and spot healing | [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) | MIT | [Hugging Face](https://huggingface.co/andraniksargsyan/migan) | `migan_pipeline_v2.onnx` | 28 MB |
| AI Denoise | [RawNIND](https://github.com/trougnouf/rawnind_jddc) UtNet2, Bayer | GPL-3.0 | [darktable-ai release 5.6.0](https://github.com/darktable-org/darktable-ai/releases/tag/release-5.6.0) | `rawnind_bayer.onnx` | 31 MB |

| file | SHA-256 of the download |
|---|---|
| `isnet-general-use.onnx` | `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a` |
| `skyseg.onnx` | `ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39` |
| `mobile_sam_image_encoder.onnx` | `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` |
| `sam_mask_decoder_multi.onnx` | `8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe` |
| `migan_pipeline_v2.onnx` | `6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b` |
| `rawdenoise-nind.dtmodel` (zip holding `model_bayer.onnx`) | `d71b5f1e727c85a359e6f74dca9e2016c9d8fc3e2f7ac3e9b347d80ceca969af` |

## Half precision

ISNet and the sky model are stored with float16 weights (`scripts/fp16.py`), which halves the download. Every weight is cast back to float32 inside the graph and onnxruntime folds those casts when it loads the model, so inference runs in float32 and needs no `shader-f16` support, which many GPUs do not expose to WebGPU. Without Python's `onnx` and `numpy`, setup keeps the float32 files.

## Inputs and outputs

| model | input | output |
|---|---|---|
| ISNet | 1024×1024 RGB, `x/255 − 0.5` | saliency 0..1, stretched to its own range |
| Sky | 320×320 RGB, ImageNet mean and std | sky probability 0..1, used as is |
| MobileSAM encoder | the photo, long side 1024, HWC 0..255 | 256×64×64 embedding, cached per photo |
| MobileSAM decoder | points or a box in the encoder's frame | four masks and their IoU; the best is kept |
| MI-GAN | RGB and a mask, 255 = keep | the filled RGB |
| RawNIND | 4×512×512 packed RGGB, `(raw − black)/(white − black)` | 3×1024×1024 camera RGB at the model's own gain, matched back to the input's mean |
