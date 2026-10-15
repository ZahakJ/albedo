// Local models: what the AI worker loads from models/ and what
// scripts/fetch-models.mjs puts there. Sources, checksums and licenses are
// in docs/MODELS.md. `fp16` names a half-precision conversion the setup
// script makes from the source when the Python onnx tools are present; the
// worker loads `file`, which setup points at whichever exists.
const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] }

export const MODELS = {
  subject: {
    label: 'Subject', file: 'isnet-general-use.onnx', size: 1024, minmax: true,
    mean: [0.5, 0.5, 0.5], std: [1, 1, 1], minBytes: 50_000_000,
    source: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
    fp16: true, license: 'Apache-2.0',
  },
  sky: {
    label: 'Sky', file: 'skyseg.onnx', size: 320, minmax: false, ...IMAGENET, minBytes: 50_000_000,
    source: 'https://huggingface.co/JianyuanWang/skyseg/resolve/main/skyseg.onnx',
    sha256: 'ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39',
    fp16: true, license: 'MIT',
  },
  samEncoder: {
    label: 'Object selection', file: 'mobile_sam_image_encoder.onnx', minBytes: 20_000_000,
    source: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx',
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
    license: 'Apache-2.0',
  },
  samDecoder: {
    label: 'Object selection', file: 'sam_mask_decoder_multi.onnx', minBytes: 10_000_000,
    source: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_multi.onnx',
    sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
    license: 'Apache-2.0',
  },
  denoise: {
    label: 'AI denoise', file: 'rawnind_bayer.onnx', minBytes: 20_000_000,
    source: 'https://github.com/darktable-org/darktable-ai/releases/download/release-5.6.0/rawdenoise-nind.dtmodel',
    sha256: 'd71b5f1e727c85a359e6f74dca9e2016c9d8fc3e2f7ac3e9b347d80ceca969af',
    member: 'model_bayer.onnx', // the source is a zip
    license: 'GPL-3.0',
  },
  inpaint: {
    label: 'Remove', file: 'migan_pipeline_v2.onnx', minBytes: 20_000_000,
    source: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    license: 'MIT',
  },
}
