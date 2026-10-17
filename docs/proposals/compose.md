# Compose: the layered editor

Status: in progress (October 2026). This replaces the Canvas surface.

Compose is albedo's layered image editor, built for the work photographers do after Develop: retouching, compositing, exposure blending, type. It is judged against Photoshop 27 on the same machine, and against Photopea, GIMP 3.2, Krita 5.3, Affinity and Graphite. [COMPETITION.md](../COMPETITION.md) covers the field. [RESOURCE-LIMITS.md](../RESOURCE-LIMITS.md) lists what Compose does not do and why.

## What it must beat

Photoshop does nearly everything a retoucher needs. Retouchers complain about four things:

1. **Subscription and credits.** Generative features are metered, and some need the cloud.
2. **Speed.** Many-layer documents slow down, and PSB files run to gigabytes.
3. **The Camera Raw round trip.** A RAW smart object opens Camera Raw in a modal dialog, which is a second developer with its own UI.
4. **Type.** The World-Ready composer has to be switched on before Arabic and other complex scripts shape correctly.

The open editors each miss something fundamental:

- GIMP has no adjustment layers.
- Krita is built for painting.
- Photopea is closed and runs on ads.
- Graphite's raster tools are still experimental.

Compose wins where these meet: a fast GPU compositor with Develop as its adjustment engine and RAW smart objects that never leave the app, all running locally and free.

## Architecture

```
main thread                       render worker (one GPU device)
───────────                       ──────────────────────────────────────────
ComposeSurface (React)            compose/engine.js     document, history, GPU resources
  stage, tool rail, options  ──▶  compose/gpu.js        compositor, brush, selection, warp passes
  Layers, Properties,        ◀──  compose/text.js       HarfBuzz shaping → glyph outlines
  History, Channels               develop backend       (shared) adjustment layers, smart objects
composeClient.js (mirror, ops)    develop machinery     (shared) params, masks, aux, finish
```

- **One device.** Compose runs inside the render worker, so it shares the WebGPU device with Develop:
  - a RAW smart object is developed by the same code that runs Develop;
  - an adjustment layer is a Develop pass over the composite below it;
  - "Edit in Compose" hands over the open photo's demosaiced texture with no decode and no file in between.
- **Ownership.** The worker owns the document, every pixel and the history. The main thread keeps a JSON mirror and sends operations. This is the existing Canvas contract (`compose/protocol.js`), extended.
- **WebGPU only.** Compose needs WebGPU; the WebGL2 fallback stays Develop-only.

### Document

A document is a tree of nodes, bottom to top. Each node carries:

- name, visibility, lock, opacity, fill opacity, blend mode;
- clipping to the node below, Blend If ranges, and an optional mask.

| node | holds | non-destructive |
|---|---|---|
| pixel | premultiplied texture over its own bounds, which grow when painted | transform commits resample |
| smart object | a catalog photo (or embedded original) + its own edit document; the developed texture is a cache | edit, transform, warp, liquify, all re-editable |
| adjustment | `develop` (a subset of Develop's modules) or `levels`, `invert`, `threshold`, `gradient map`, `solid`, `gradient` | always |
| text | runs of text with font, size, tracking, features, colour, paragraph settings | always |
| shape | rectangle, ellipse, polygon, line or path; fill and stroke | always |
| group | children; pass-through or isolated blending | always |

**Layer styles.** Any node can carry layer styles (drop shadow, stroke, outer glow), drawn from its alpha at composite time.

**Bit depth.** The document's depth sets the storage format of its pixels:

| depth | storage | composite | working space |
|---|---|---|---|
| 8-bit | `rgba8unorm` | `rgba16float` | sRGB-encoded, like Photoshop |
| 16-bit | `rgba16float` | `rgba16float` | sRGB-encoded |
| 32-bit | `rgba32float` | `rgba32float` | linear, unclamped, like Photoshop's 32-bit mode |

16-bit here is half float, as in Krita. It has 11 significant bits near white and more in the shadows. Photoshop's 16-bit is a 15-bit integer.

### Compositing

The view is composited at view resolution, so the cost scales with the screen, not the document. Each frame:

1. Visible nodes are drawn bottom to top into a view-sized premultiplied accumulator.
   - **Normal layers use fixed-function blending.** Each one is a single draw over its own screen bounds.
   - **Other blend modes, clipping, Blend If and masks** copy the destination bounds into a scratch texture and blend in the shader. This covers all 27 Photoshop modes.
2. Layer textures are mipmapped, so zoomed-out views sample a pre-filtered level, as Photoshop's pyramid does.
3. The composite below the active node is cached. A brush stroke or a slider drag on one layer re-composites only that layer and the ones above it.
4. Adjustment layers render the Develop shader over the accumulator, then mix the result back through the mask and opacity. Clarity, texture and dehaze build their blur pyramid at view scale, with image-relative radii. Vignette and grain read the document frame, so they stay put when the view zooms.

Export runs the same code at full resolution, in tiles when a side exceeds the GPU's limit. This gives JPEG, PNG and 16-bit TIFF, plus PSD, layered TIFF and `.albedo` with the layers intact.

### History

Every operation is one undo entry:

- property and structure changes keep JSON;
- pixel operations keep GPU copies of the region they touched.

History is capped by a VRAM budget, oldest first, rather than by a step count.

### Files

| format | read | write |
|---|---|---|
| `.albedo` | yes | yes. A zip: `doc.json`, layer pixels as 16-bit PNG or float32, embedded originals of smart objects, so it opens anywhere |
| PSD / PSB | layers, groups, masks, blend modes, opacity, clipping, text as pixels plus its text, 8 and 16-bit | layers, groups, masks, blend modes, clipping, adjustment layers as their pixels' baked result plus albedo's own data, 8 and 16-bit |
| TIFF | Photoshop layered TIFF (layer data in tag 37724), multi-page TIFF as layers | flattened 16-bit (existing) |
| JPEG, PNG, WebP | as a layer | flattened |

## Tools

| area | tools |
|---|---|
| select | rectangle and ellipse marquee, lasso, polygon lasso, magic wand, colour range, AI subject, sky and object (the Develop mask models), refine edge (guided filter on the image for hair), feather, expand, contract, smooth, invert, to mask |
| retouch | spot heal, healing brush and clone stamp (current layer, current and below, or all layers), content-aware fill (MI-GAN, local), frequency separation (one command: a group with low and high layers), dodge and burn (tool, plus a neutral soft-light layer) |
| warp | free transform (move, scale, rotate, skew), distort and perspective (four corners), warp (a 4×4 mesh), liquify (forward warp, bloat, pucker, twirl, reconstruct, smooth; a displacement field kept per layer, so it stays editable) |
| paint | brush (size, hardness, spacing, flow, opacity, smoothing; pressure maps to size, opacity or flow through pointer events), eraser, smudge, fill, gradient |
| type | text layers shaped by HarfBuzz: bundled IBM Plex Sans and Plex Sans Arabic, installed fonts (Local Font Access) and dropped `.ttf`/`.otf` files, kerning from GPOS, tracking, OpenType features, right-to-left and bidirectional lines |
| shape | rectangle, ellipse, polygon, line; layer styles: drop shadow, stroke, outer glow |
| generative | local fill and expand only where a model with clean licensing fits the GPU; see [RESOURCE-LIMITS.md](../RESOURCE-LIMITS.md) |

## Seamless with Develop

- **Edit in Compose** (`⌘⇧E` in Develop) opens a new document whose only layer is the photo as a smart object, carrying its current edit. It uses the demosaiced texture already on the GPU.
- **Double-clicking a smart object** opens it in Develop with a "Back to Compose" bar. Edits go to the layer's own edit document, and the layer re-develops when you return.
- **Develop adjustment layers** use Develop's own panels in Compose's Properties panel.

## Milestones

1. **Core.** Model, compositor, all node kinds except text and shape, masks, clipping, blend modes, groups, view and history, OPFS autosave, Compose surface UI, Edit in Compose, flattened export.
2. **Selection.** Marquee, lasso, wand, colour range, AI select, refine edge, operations, marching ants.
3. **Retouch and paint.** Brush engine, eraser, smudge, clone and heal, content-aware fill, dodge and burn, frequency separation, transforms, warp, liquify.
4. **Type and shapes.** HarfBuzz, fonts, text editing, shapes, layer styles.
5. **Files.** `.albedo`, PSD in and out, layered TIFF in.
6. **Speed.** The 50-layer benchmark, then fixes until it meets the bar.
7. **Docs and site.** Manual chapter, landing section with real captures, README, COMPETITION targets filled with measurements.

## Bars

Each bar is proved by a test or a measurement in [BENCHMARKS.md](../BENCHMARKS.md) on the reference machine (RTX 4070 SUPER).

| bar | target |
|---|---|
| 50-layer 24 MP document (10 full-frame pixel layers, 15 partial, 15 adjustment including Develop, 3 smart objects, 4 text and shape, 3 groups with masks) | pan and zoom at display rate (< 16.7 ms GPU per frame at fit and at 100%); a brush stroke on a middle layer < 8 ms per frame; a Develop adjustment slider < 16.7 ms |
| open | a 24 MP RAW into Compose from Develop in < 100 ms (no decode) |
| memory | the 50-layer document under 4 GB of VRAM in 16-bit; history capped by budget |
| PSD | albedo → PSD → albedo keeps layer count, names, order, blend modes, opacity, masks, clipping and groups; pixels within 1/255 (8-bit) or 1/4096 (16-bit) |
| layered TIFF | a Photoshop layered TIFF opens with its layers |
| blend modes | each of the 27 matches the W3C compositing formulas (or Photoshop's documented ones where they differ) within 1/255 on a test chart |
| type | Arabic shapes with joining forms and correct order; mixed Arabic and Latin lines follow the bidi algorithm; kerning changes advances as GPOS says |
| selection | AI subject and refine edge on a portrait: hair strands kept (visual, captured), < 1 s |
| smart object | change white balance in Develop, return: the composite updates without a file written |
| no stubs | every listed tool works end to end in an e2e test or is listed in RESOURCE-LIMITS |
