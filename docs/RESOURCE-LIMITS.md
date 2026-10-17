# Resource limits

This page lists what albedo does not do, and why. None of it is stubbed in the UI: what isn't listed in the app isn't offered.

## Generative fill and expand

**What albedo has.**

- **Content-aware fill and the spot healing brush**, which use MI-GAN.
  - MI-GAN is a local inpainting model. Its code and weights are MIT, and the file is 28 MB.
  - It fills a selection or a brushed area from its surroundings, on a new layer.
  - It runs on the GPU in about 0.1–0.3 s per region, offline, with no credits and no content policy.
  - It is not generative. It continues texture and structure, so it cannot invent objects from a prompt.
- **The model's working size.** MI-GAN works at 512 px internally, and the region around the hole is read at up to 1024 px. A very large hole is therefore filled at reduced resolution and scaled up. That is fine for skies, walls and grass. It is soft for detailed areas many times the model's size.

**What albedo does not have: prompted generative fill and expand.** Nothing has both of these properties:

- the weights fit a browser on a 12 GB GPU;
- the model was trained only on licensed or public-domain data and is licensed for commercial use.

These are the models that come closest, and why each one fails ([research notes, October 2026](COMPETITION.md#photoshop-and-the-layered-editors)):

| model | why not |
|---|---|
| Stable Diffusion 1.5 inpainting | Fits (about 2 GB at fp16), but it was trained on LAION, under CreativeML OpenRAIL-M. |
| F Lite (Freepik) | Trained on licensed images, but it has 7–10 B parameters, needs 24 GB or more, and only does text-to-image. |
| CommonCanvas | Licensed CC BY-SA or non-commercial, and does text-to-image only. |
| Mitsua Likes | Non-commercial licence. |
| Public Diffusion | No public weights. |

When a model with clean data and a commercial licence fits, it will run in the same AI worker as Remove and Denoise.

## Compose

- **WebGPU is required.**
  - Compose runs only on WebGPU: Chrome and Edge 113+, Safari 26, Firefox 141+. On Linux, Chrome needs WebGPU switched on.
  - Library and Develop also run on WebGL2. Compose's compositor, brushes and selections need render passes and texture formats that WebGL2 does not have.
- **Maximum document size.**
  - A document side is limited to the GPU's maximum texture size: 16,384 px on most desktop GPUs, 8,192 px on some laptops.
  - PSB files larger than that open with their layers clipped to that size.
- **32-bit documents.**
  - These need the `float32-filterable` and `float32-blendable` WebGPU features, which every desktop GPU tested here has.
  - Without them, the New Document dialog offers 8 and 16-bit only.
- **16-bit means 16-bit half float**, as in Krita. Near white it is about 11 significant bits, and finer in the shadows. Photoshop's 16-bit mode is a 15-bit integer.
- **Colour.**
  - Documents are sRGB. There is no wide-gamut working space, no CMYK, and no soft proofing.
  - A PSD in another RGB profile opens with its numbers unchanged, as if it were sRGB.
- **Layer styles.**
  - Compose has drop shadow, stroke and outer glow.
  - Shadow and glow blend with the layer's mode, not with a mode of their own.
  - Bevel, inner shadow, pattern overlay and the other Photoshop styles are not implemented.
- **PSD export.** Adjustment layers, smart objects, type, shapes and fills are written as rendered pixel layers, with their mode, opacity, mask and clipping kept.
  - PSD has no record for Develop's adjustments, and Photoshop's own adjustment records would only approximate them.
  - Choose *PSD with albedo data* to also embed the full albedo document. albedo reopens that file with every layer editable, and Photoshop ignores the extra data.
- **PSD import.**
  - Pixel layers, groups, masks, blend modes, opacity, fill, clipping, Blend If, and the Levels, Curves, Hue/Saturation, Brightness/Contrast, Exposure, Invert, Threshold and Posterize adjustments come through.
  - Other adjustment types, smart objects, type and layer styles come in as the pixels Photoshop saved with them. The import names every layer whose live settings it could not keep.
  - Vector masks, CMYK, Lab, indexed and duotone files are not read.
- **Clipped adjustments in PSD export** are rendered against everything below them, not against the base layer alone. With an opaque base the result is identical; with a partly transparent base it can differ at the edges.
- **Smart objects.** A smart object develops its RAW with every Develop module, except AI Denoise while the photo is open in Develop for a different smart object (the denoised capture belongs to the photo Develop has open).
- **Type.**
  - The bundled faces are IBM Plex Sans and IBM Plex Sans Arabic, Regular and Bold.
  - Installed fonts work where the browser offers Local Font Access (Chrome and Edge).
  - Any TTF, OTF or WOFF file can be added; WOFF2 cannot.
  - There is no text on a path, no vertical text and no paragraph styles.
- **Liquify** has no freeze mask.

## Develop

- AI Denoise works on Bayer sensors only. X-Trans and Foveon captures use the wavelet denoise.
- DCP profiles apply their tables and tone curve. Dual-illuminant interpolation uses the photo's white balance; the profile's look table is applied after its tone curve, as in the DNG SDK.
