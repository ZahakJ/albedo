# Render pipeline

The render worker turns a decoded source plus an edit document into pixels. Every pass is a fragment shader drawing a fullscreen triangle into a render target; there are no compute shaders and no storage textures, so WebGPU and WebGL2 share one pass graph. Each WGSL shader in `src/engine/gpu/shaders/wgsl/` has a GLSL twin in `glsl/` with the same math, and the end-to-end suites render the same documents on both backends and compare them.

```
RAW bytes ──decode worker──▶ raw frame (u16) │ RGB
                                   │
                 raw front end, tile by tile         once per open
      (black, white balance, highlight inpainting, RCD or X-Trans demosaic,
                         camera matrix)
                                   ▼
                     linear rgba16f source ──▶ blur pyramid (local contrast, heal, defringe)
                                   │       ──▶ wavelet denoise | AI-denoised copy
                                   ▼
                              develop pass              every PARAMS
                                   ▼
                               finish pass              sharpen, grain, mask wash, split view
                                   ▼
                          canvas  /  export blob
```

## Backend selection

`src/engine/gpu/device.js` tries WebGPU on the high-performance adapter and falls back to WebGL2; `?backend=webgl2` skips WebGPU. The WebGPU device asks for the adapter's full `maxTextureDimension2D` (16384 on current GPUs), so 45–100 MP sensors fit in one texture; WebGL2 uses `MAX_TEXTURE_SIZE`.

A hardware WebGPU device renders, reads back and exports by itself. A software adapter (SwiftShader) cannot read back reliably; then scopes and exports run on a second, WebGL2 "scratch" context that renders the retained source with the same shaders.

## Decode

`src/workers/decode.worker.js` wraps libraw-wasm 1.6.0 (pinned), whose wasm runs in its own nested worker.

- **Bayer.** A 2×2 CFA with a camera matrix sends the raw frame as LibRaw unpacked it, masked borders included, with the margins that locate the visible area, the black and white levels, the camera white balance (normalised to green), the camera→sRGB matrix, the CFA phase as an offset onto RGGB, the daylight multipliers and the orientation. Nothing is cropped or copied on the CPU.
- **X-Trans.** The same frame plus its 6×6 layout, read from the RAF header (tag 0x131) and checked against the data, and the black level from the FujiIFD (tag 0xF00A), which this LibRaw build does not report.
- **Black level.** Where LibRaw reports none and the frame has optical-black margins, their median.
- **Other sensors.** Foveon, sRAW and anything whose mosaic cannot be read go through LibRaw's own demosaic at 16 bits; the payload is marked BT.709-encoded and the GPU undoes the curve.

JPEG and PNG skip the decode worker and arrive as an `ImageBitmap`.

## Raw front end

`rcd.wgsl` (Bayer) and `xtrans.wgsl` run once per opened photo. The image is cut into 2048 px tiles with a 16 px apron; for each tile the mosaic is uploaded straight from the raw frame through the margins, the chain runs in tile-sized intermediates, and the tile's core is drawn into the full-size rgba16f output. GPU memory is the output plus a few tile buffers, whatever the sensor size.

| pass | Bayer | X-Trans |
|---|---|---|
| prep | black subtract, normalise, white balance | same, with the 6×6 colour lookup |
| highlights | inpaint opposed | same, red or blue may be absent from a 3×3 |
| interpolation | RCD: V/H and P/Q discrimination, low-pass, green, red/blue at blue/red sites, red/blue at green sites | green from four directional estimates weighted by their gradients; red and blue by colour differences over 7×7, guided by green |
| final | camera matrix into the working space | same |

**Highlight inpainting** follows darktable's "inpaint opposed": a clipped photosite becomes the larger of its value and the cube-root mean of the other two colours in its 3×3 neighbourhood plus a per-channel chrominance offset. The offset is measured once on the CPU (`src/engine/hlchroma.js`) from the unclipped photosites around clipped areas, at most ~30 000 cells of them. Toggling reconstruction (`modules.recon`) is the only edit that re-runs the front end.

**RCD** is Luis Sanz Rodríguez's Ratio Corrected Demosaicing as implemented in RawTherapee.

## Develop pass

`develop.wgsl` / `develop.frag` evaluate the whole edit per output pixel:

| step | operation |
|---|---|
| 0 | Geometry, an inverse map from output to source: un-crop, rotate about the crop centre, divide by the inscribed auto-zoom, mirror. Then keystone (a 3×3 homography), manual distortion, and the lens profile's distortion, innermost. |
| 0.5 | The source tap: lateral CA as per-channel radial scales (lens profile × manual), removal patches composited, vignetting divided out, the AI-denoised copy blended by its amount, and a DCP profile's matrix and HSV table. |
| 0.7 | Heal and clone spots (up to 32). |
| 1–3 | White balance, exposure (`2^ev`), parametric tone in stops around middle grey. |
| 3.5 | Local contrast: texture, clarity and dehaze against a blurred copy of the source; defringe. |
| 4.5 | Local masks (up to 8), each re-applying white balance, exposure, tone, clarity and saturation by its weight. |
| 5–6.3 | HSL mixer in OKLCh, vibrance and saturation, B&W mix, three-way grading in OKLab. |
| 6.5 | Vignette, a radial exposure gain in the cropped frame. |
| 7 | Display transform: the profile's tone curve (DCP), AgX, or a clamp; sRGB encode. |
| 8 | Point curve, a 512-entry LUT. |
| 9 | Clip overlay. |

All scalar parameters travel as one `Float32Array(128)`, documented verbatim at the top of both develop shaders and built by `paramsFrom` in the render worker. Masks, heal spots and removal patches each have their own uniform block. Sliders arrive in their UI units; scaling to shader units happens in the shaders. Each optional stage has an "on" flag, so a document without that module leaves pixels bit-identical to the stage being absent.

## Looks and profiles

- **AgX** (default for RAW): Troy Sobotka's AgX in Benjamin Wrensch's minimal fit: inset matrix, log2 encoding over [−12.47, +4.03] stops around 0.18, a sixth-order sigmoid, outset matrix. A baseline exposure (default +0.5 EV) and a chroma scale (default 110 %) are part of the look.
- **Linear**: clamp and encode. JPEG and PNG use it unless a look is set; they are display-referred already.
- **DCP camera profiles**, imported as `.dcp` files (`src/io/dcp.js`, `src/engine/dcpColor.js`), apply as the DNG SDK orders them. The profile's matrix, built for the photo's white balance by the SDK's white-point iteration and inverse-CCT interpolation, corrects LibRaw's matrix. HueSatMap and LookTable act as one table over the HSV of linear ProPhoto (a 3D texture whose hue axis wraps). The tone curve, applied hue-preserving on ProPhoto, replaces the display transform.

## Lens profiles

On open, the render worker matches the RAW's EXIF camera and lens against the lensfun database (`public/lensfun/`, CC BY-SA 3.0) with lensfun's own rules and interpolates the calibration for the focal length, aperture and distance (`src/engine/lensfun.js`, `src/engine/lensProfile.js`). Distortion, lateral CA and vignetting become polynomials in the radius, normalised to the source half-diagonal, and are applied as in step 0 and 0.5. The crop's auto-zoom includes them. Fisheyes are skipped.

## Blur pyramid

Local contrast, heal and defringe sample a blurred copy of the source: σ 3 px at full resolution and σ 40 px at quarter resolution. It is built the first time an edit needs it and cached for the open photo.

## Noise reduction

- **Wavelet.** Three levels of an à-trous B3 spline, soft-thresholding luma and chroma residuals. The denoised texture replaces the develop input and is cached per `(lumaNR, chromaNR)`.
- **AI Denoise.** RawNIND denoises and demosaics the Bayer mosaic in one pass. The AI worker tiles the mosaic (1024 px windows, 32 px overlap, edges mirrored without changing the CFA colour), matches each tile's output gain to its input, and posts each tile's core to the render worker over a MessageChannel; the render worker applies white balance and the camera matrix and draws it into a second rgba16f image. Clipped photosites keep the regular demosaic and its highlight inpainting. The Amount slider blends the two in the develop pass and turns the wavelet NR off; the model runs once per opened photo.

## Finish pass

`finish.wgsl` runs on the develop output when sharpening, grain, the mask wash or split view is active: unsharp mask on luma with an edge mask, grain attached to source coordinates, the selected mask's weight as a red wash, and the split-view divider.

## Masks

A mask is `linear`, `radial`, `brush` or `ai`, in source-normalised coordinates before mirroring, so masks stay attached to the image through crop and rotation.

- Linear and radial weights are analytic in the shader.
- Brush strokes replay into a quarter-resolution rgba8 texture, one channel per mask.
- AI masks are computed by the AI worker on the photo's preview: subject (ISNet, 1024²), sky (U²-Net, 320²), background (the inverted subject) and object (MobileSAM from a click or a box). The weights are stored as quarter-resolution PNGs and share the brush texture's channels; brush and AI masks together are limited to four.
- Any mask can be refined by a luma window and an OKLCh colour range.

## Removal patches

The Remove tool reads the capture inside a rectangle around the hole (develop pass with no edits, no lens profile, 1 EV down for headroom), fills the hole with MI-GAN in the AI worker, and stores the result as a patch: rgb is the fill as sRGB of linear ÷ scale, alpha the feathered hole. Patches live in OPFS; the doc holds their rectangles (`modules.remove`). The render worker packs patch images into one 2048² atlas and the develop pass composites the patches the doc lists as it reads the source, so removing one is an ordinary undo.

## Scopes, auto and sampling

After every frame the worker renders the developed image small and returns a 256-bin RGB+luma histogram and clipped fractions; during gestures at most 15 per second. `AUTO` measures the photo with the relevant modules removed and returns replacement values for tone or white balance. `SAMPLE` maps a click through the geometry and returns a 5×5 average.

## Export

`EXPORT` renders the source at the size the crop and auto-zoom imply, or directly at a requested long edge with blur radii, sharpening and grain scaled to stay image-relative. The canvas encodes JPEG or PNG; the main thread (`src/io/exportUtil.js`) applies any further downscale, the watermark and the original's EXIF. An export waits for an AI denoise in flight.

A 16-bit TIFF renders develop and finish into half-float targets, reads them back in strips, and is written with Deflate and an embedded sRGB profile (`src/io/tiff.js`).

DNG export repackages the RAW mosaic (`src/io/dng.js`) with a colour matrix derived from LibRaw's and the edit as XMP inside. Original export copies the file untouched. Any export can write a Lightroom-compatible XMP sidecar (`src/io/xmpWrite.js`).

## Compose

Compose reuses the develop pass twice.

- A **smart object** is a photo developed at full resolution into a half-float texture by the same code as Develop's view: geometry, lens, colour, masks, heal, removal, noise reduction and sharpening. It is redeveloped only when its edit changes.
- A **Develop adjustment layer** runs the develop pass over a straight-colour copy of the composite below it, at view resolution.
  - The input is display-encoded, so `inputIsLinear` is 0 and the display transform clamps.
  - The blur pyramid is built at view scale with image-relative radii.
  - Params `[14..15, 75, 95]` give the view's place in the document, so the vignette and grain stay with the document as the view zooms.
  - The result goes back through the layer's mask, blend mode and Blend If.

Everything else in Compose is its own set of passes in `src/compose/gpu/`: layer meshes, the 27 blend modes, adjustments, selections, the brush engine, liquify and layer styles. [ARCHITECTURE.md](ARCHITECTURE.md#compose) describes them.
