# Compose

Compose (`E`) is albedo's layered editor, for the work that comes after Develop: retouching, compositing, exposure blending and type. It runs on the GPU and keeps every layer at 8, 16 or 32 bits per channel. Nothing leaves your machine, and nothing is metered.

## Starting a document

- **From Develop**, `⌘⇧E` (or **Edit in Compose** under Export) opens the photo as a *smart object* carrying its edit.
  - The RAW stays inside, so you can change its development at any time.
  - It opens instantly: Compose uses the image Develop already has on the GPU.
- **From the Library**, the start screen offers to open the selected photo as a smart object.
- **A new document** takes a size, a depth (8, 16 or 32-bit) and a background.
- **Opening a file** works for JPEG, PNG and TIFF (including Photoshop's layered TIFF and multi-page TIFF), PSD and `.albedo` files. You can also drop one onto Compose.
- **Dropping an image** onto an open document places it as a new layer.

Documents save themselves into the browser's storage as you work (`⌘S` saves at once). The start screen lists them.

**Image › Mode** changes a document's depth at any time: 8 bits, 16 bits (half float) or 32 bits (float, in linear light, like Photoshop's 32-bit mode).

## Layers

The Layers panel shows the stack, top first.

- **Blend mode** sits above the stack. All of Photoshop's 27 modes are there, and groups add Pass Through.
- **Opacity and Fill.** Drag the label to scrub, or type a value. Number keys set opacity: `1` is 10% and `0` is 100%.
- **Reorder** by dragging a row. Drop onto the middle of a group to move a layer into it.
- **Clip** a layer to the one below with `⌥`-click between them, or `⌥⌘G`.
- **Hide** with the eye; double-click a name to rename it.
- **The buttons along the bottom** add a style, a mask, an adjustment, a group or a layer, and delete.

| layer | what it holds |
|---|---|
| Pixel | paint, retouching, placed images |
| Smart object | a photo and its Develop edit, re-developed whenever the edit changes |
| Adjustment | Develop (every Develop control), Curves, Levels, Brightness/Contrast, Exposure, Hue/Saturation, Channel Mixer, Photo Filter, Gradient Map, Invert, Posterize, Threshold |
| Fill | a solid colour or a linear or radial gradient |
| Type | text, shaped and laid out live |
| Shape | rectangle, ellipse, polygon or star, line |
| Group | layers that blend together (Pass Through) or as one (any other mode) |

**Masks.** Every layer and group can have a mask: white shows the layer, black hides it. Add one with the mask button; `⌥`-click it to start from Hide All. With a selection active, the new mask starts from that selection. Paint on the mask with the brush by switching the brush to **Mask**, or press `\`. The Mask section of Properties sets density and inverts. **Refine edge** fits the mask's edge to the image, and **Select** loads the mask as a selection.

**Blend If.** Properties holds Photoshop's Blend If for any layer. Fade a layer by its own brightness, or by the brightness of what is below. This is a luminosity mask that never goes stale: it follows the layers under it as they change.

**Layer styles** (the **fx** button) add a drop shadow, a stroke (outside, centre or inside) and an outer glow.

## Smart objects and Develop

Select a smart object and choose **Edit in Develop** in Properties.

- Develop opens the photo with that layer's edit and shows a **Back to Compose** bar.
- Every change re-develops the layer in the document.
- Nothing is exported or saved in between.
- The catalog's own edit of the photo is left alone. The smart object keeps its own copy, so the same photo can sit in a document twice with two different developments.

A **Develop adjustment layer** shows Develop's own panels in Properties: Tone, WB, Curve, Color, B&W, Mixer, Grading, Effects, Detail. They apply to everything below the layer, through its mask and blend mode, and can be changed at any time. Use it to grade a whole composite, or to clip a white balance correction to one layer.

## Selections

| tool | key | |
|---|---|---|
| Marquee | `M` | rectangle; `⇧M` for the ellipse |
| Lasso | `L` | freehand; `⇧L` for the polygon lasso (click points, `⏎` closes) |
| Magic wand | `W` | by colour, contiguous or not, from the layer or all layers |
| AI select | `⇧W` | **Select subject**, **Select sky**, or click or drag a box around an object |

How a selection combines with the existing one:

- `⇧` adds to the selection;
- `⌥` subtracts from it;
- `⇧⌥` intersects with it;
- the mode buttons in the options bar do the same.

The Select menu holds All (`⌘A`), Deselect (`⌘D`), Reselect, Inverse (`⇧⌘I`), Color Range, and the modifiers: expand, contract, feather, smooth, border.

**Refine edge** fits a selection's edge to the image with a guided filter. It is made for hair and fur: the soft band along the edge follows the strands, and the rest stays crisp. AI select refines its result this way by default.

## Retouching

| tool | key | |
|---|---|---|
| Spot healing | `J` | paint over a blemish, a wire or a sensor spot: the local model fills it from around it, on a new layer |
| Healing brush | `⇧J` | `⌥`-click a source, then paint: texture from the source, tone and colour from the destination |
| Clone stamp | `S` | `⌥`-click a source, then paint |
| Dodge and burn | `O` | lighten or darken shadows, midtones or highlights; **New D&B layer** makes a neutral Soft Light layer to work on instead |
| Smudge | `R` | smear paint, as with a finger |

Clone and heal sample the current layer, the current layer and those below it, or all layers. Use **Current & below** on an empty layer to keep your retouching apart from the photo. **Aligned** keeps the offset from one stroke to the next.

**Content-aware fill** (Edit menu) fills the selection from its surroundings, on a new layer. It uses MI-GAN, a 28 MB model that runs on your GPU in a fraction of a second. There are no credits and no content filter. It continues what is around the hole and does not invent new things; [Resource limits](https://github.com/ZahakJ/albedo/blob/main/docs/RESOURCE-LIMITS.md) explains why there is no prompted generative fill.

**Frequency separation** (Filter menu) splits the active layer into a Low frequency layer (colour and tone) and a High frequency layer (texture, in Linear Light), grouped. Together they recombine to the original exactly in 16 and 32-bit documents. Retouch tone on Low with a soft brush or the healing brush, and texture on High with the clone stamp.

## Painting

The **brush** (`B`) and **eraser** (`E`) have:

- size `[` `]`, hardness `⇧[` `⇧]`, opacity (the number keys) and flow;
- spacing and smoothing;
- pen pressure, which can control size, opacity or flow.

Opacity caps a stroke and flow builds up within it, as in Photoshop. A stroke stays inside the active selection.

**Gradient** (`G`) drags out a gradient fill layer from the foreground colour to transparent. On a gradient fill layer, the drag moves its gradient instead.

`X` swaps the foreground and background colours, `D` resets them to white and black, and the **eyedropper** (`I`) picks a colour from the image.

## Transform and liquify

**Free transform** (`⌘T`) has three modes:

- **Free.** Drag inside to move, outside to rotate, and a handle to scale. It keeps the proportions unless you hold `⇧`.
- **Distort.** Drag the four corners, for perspective.
- **Warp.** Drag the points of a 4×4 grid.

`⏎` applies and `Esc` cancels. Transforms never resample the layer: scale it down and back up and it is as sharp as before. The pixels are re-rendered only when you paint on a transformed layer.

**Liquify** (`Q`) pushes, bloats, puckers, twirls, smooths and reconstructs the active layer. It works on pixel layers, smart objects and type. It stays editable: Reconstruct paints the original back, and **Restore all** removes the liquify entirely.

**Crop** (`C`) drags a new frame; `⏎` applies it. Layers keep the pixels outside the frame.

## Type

Click with the **type tool** (`T`) to type, or drag a box for text that wraps. Click a type layer to edit it.

- **Shaping.** Type is shaped by HarfBuzz, the engine browsers and Photoshop use. Arabic and other complex scripts join correctly with no setting to change. Lines that mix right-to-left and left-to-right text follow the Unicode bidirectional rules.
- **Fonts.** IBM Plex Sans and IBM Plex Sans Arabic are built in. Add any TTF, OTF or WOFF file, or, in Chrome and Edge, use your installed fonts. A run that the chosen font cannot show falls back to a font that can.
- **Settings in Properties:** size, weight, tracking, leading, box width, colour, alignment, direction, and the font's own kerning and ligatures.

**Shapes** (`U`) draw rectangles (with rounded corners), ellipses, polygons and stars, and lines. Each has a fill and a stroke, and stays editable.

## Export

Export (in the status bar, or the Image menu):

| format | |
|---|---|
| JPEG, PNG | flattened (JPEG on white); JPEG also at 2048 or 4096 px on the long edge |
| TIFF | flattened, 16 bits per channel |
| PSD | layers, groups, masks, blend modes, opacity, fill, clipping and Blend If. Develop adjustments, smart objects, type and styles are rendered into pixels with their mode, opacity, mask and clipping kept |
| PSD with albedo data | the same, plus the whole albedo document inside: albedo reopens it with everything editable, and Photoshop ignores the extra data |
| albedo document | everything, editable, with the smart objects' originals inside |

When albedo opens a PSD, it reads its pixel layers, groups, masks, modes, clipping, Blend If and the common adjustment layers. Anything it cannot keep live arrives as the pixels Photoshop saved.

## Speed

Compose draws at the resolution of your screen, not the document's: on the reference machine a 50-layer, 24 MP document redraws in about 7 ms. While you paint or drag a slider, everything below that layer is drawn once and reused. Panning and zooming show the last drawing again, moved or scaled, and draw afresh once you stop. Measured times are in [Benchmarks](https://github.com/ZahakJ/albedo/blob/main/docs/BENCHMARKS.md#compose).
