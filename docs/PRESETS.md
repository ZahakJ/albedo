# Presets and Lightroom XMP

A preset is a subset of an edit document's `modules`. Applying one replaces exactly the modules it contains on each target and leaves every other module, mask and heal spot alone. The same merge serves paste (`⌘V`), applying a preset to a whole selection (grid context menu → Apply Preset, or `⌘K` → Apply Preset: …), and XMP sidecars.

Code: `src/state/presetFormat.js` (pure: file format, sanitising, built-in looks), `src/state/presetStore.js` (rail state, import, sidecar pairing), `src/io/xmp.js` (pure XMP parser). Both pure modules run under `node --test` (`test/unit/`).

## Storage

User and imported presets are stored as `presets/<id>.json` in OPFS and mirrored in the `presets` table with `grp` (the rail group), `source` (`user`, `import` or `xmp`) and `created_at`. Built-in looks are code with IDs `builtin:<name>`; they are never written to the database.

Saving from the rail asks which groups to include, so a preset can carry only, say, color and grading.

## File format

```json
{
  "format": "albedo-presets",
  "version": 1,
  "presets": [
    { "name": "Dusk", "group": "Travel",
      "modules": { "vibsat": { "vibrance": 33, "saturation": 0 } } }
  ]
}
```

- **Export all** writes every user preset into `albedo-presets.json`; exporting one preset writes `<name>.albedo.json`.
- A bare `{ "name", "modules" }` object is accepted as a single preset.
- A `version` newer than the app understands is rejected with a message.
- On import every module is sanitised against `MODULE_DEFAULTS`: unknown modules and keys are dropped, values of the wrong type fall back to the default, and `heal` is never taken from a preset because spots belong to one photo. Name clashes get a numeric suffix.

## Built-in looks

Eight looks ship with the app: Punchy, Bright & Airy, Soft Matte, Warm Film, Cool Fade, Teal & Orange, B&W Classic, B&W High Contrast. Each one sets the same seven look modules (`tone`, `curve`, `vibsat`, `localcontrast`, `grading`, `bw`, `grain`), with defaults wherever the look changes nothing, so moving from one look to another never leaves part of the previous one behind. None of them touches white balance, exposure, geometry or detail, which belong to the photo rather than the look.

## Lightroom and Camera Raw XMP

`parseXmp(text)` returns `{ name, modules, unmapped, isPreset, warnings }`. It uses a small tolerant XML reader instead of `DOMParser`, so it runs in Node and in workers. It reads settings written as attributes or as child elements, spread over any number of `rdf:Description` nodes, and handles both sidecars and presets (`crs:PresetType`, with `crs:Name` and `crs:Group` as `rdf:Alt`).

### How files are routed

When files are dropped or opened together, every `.xmp` whose name matches an imported photo (`IMG_1.xmp` or `IMG_1.CR2.xmp` for `IMG_1.CR2`, case-insensitive) becomes that photo's edit. Every other `.xmp`, and any `.xmp` loaded through the rail's Import button, becomes a preset in the **Imported** group. After the import one line names everything that was set but could not be represented, for example `Not imported: Color grade luminance, Profile/Look`.

### Which modules are included

- **Sidecar**: a module is included only when the mapped values have a visible effect. For vignette, grain, grading and B&W the test is the effect switch (amount ≠ 0, amount > 0, any zone saturation > 0, grayscale on), because Lightroom writes their secondary sliders into every file.
- **Preset**: additionally, any module whose settings the preset contains is included even at neutral values. A Lightroom preset only carries the groups that were ticked when it was saved, so a ticked group at neutral means "reset this", and applying the module at defaults does that.

### Mapping

| Lightroom / ACR | albedo |
|---|---|
| `Exposure2012` | `exposure.ev`, 1:1, clamped to ±5 |
| `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012` | `tone.*`, 1:1 |
| `Temperature`, `Tint` (Kelvin, raw files) | `wb.temp`, `wb.tint` via the illuminant, see below |
| `IncrementalTemperature`, `IncrementalTint` (JPEG/TIFF) | `wb.temp`, `wb.tint`, 1:1 |
| `Vibrance`, `Saturation` | `vibsat`, 1:1 |
| `Clarity2012`, `Texture`, `Dehaze` | `localcontrast`, 1:1 |
| `ToneCurvePV2012` (0…255) | `curve.points` (÷255); PV2010 `ToneCurve` as fallback |
| `Hue/Saturation/LuminanceAdjustment<Band>` | `colormix.<band>.h/s/l`, 1:1; the eight bands are the same |
| `ConvertToGrayscale`, `GrayMixer<Band>` | `bw.on`, `bw.mix`, 1:1 |
| `ColorGrade*`, `SplitToning*` | `grading`: HSL hue converted to OKLab hue through the fully saturated sRGB color, saturation 1:1, `ColorGradeBlending` 1:1, `SplitToningBalance` × −1 |
| `PostCropVignetteAmount`, `Midpoint`, `Feather`, `Roundness` | `vignette`, 1:1 (roundness clamped to 0…100) |
| `GrainAmount`, `GrainSize`, `GrainFrequency` | `grain.amount`, `size`, `roughness`, 1:1 |
| `HasCrop`, `CropLeft/Top/Right/Bottom` | `geometry.crop`, with `tiff:Orientation` applied |
| `CropAngle` | `geometry.angle` × −1 (albedo's positive angle is counter-clockwise), clamped ±45 |
| `PerspectiveVertical`, `PerspectiveHorizontal` | `geometry.persp.v`, `.h`, 1:1 |
| `Sharpness`, `SharpenRadius`, `SharpenEdgeMasking` | `detail.sharpenAmount`, `sharpenRadius`, `sharpenMasking` |
| `LuminanceSmoothing`, `ColorNoiseReduction` | `detail.lumaNR`, `chromaNR` |
| `LensManualDistortionAmount` | `lens.distortion` × −1 |
| `DefringePurpleAmount`, `DefringeGreenAmount` (0…20) | `lens.defringe` = 5 × max(purple, green) |
| `LensProfileDistortionScale`, `LensProfileVignettingScale` | `lens.profDistortion`, `lens.profVignette`, 1:1 (the profile itself is albedo's lensfun match; `LensProfileEnable` is not read, since Lightroom writes 0 into every untouched file) |

Values outside albedo's range are clamped and reported in `warnings`.

**White balance.** albedo's `wb` is relative to the camera's as-shot multipliers, while a raw-file XMP stores an absolute illuminant. The parser maps relative to Lightroom's Daylight preset (5500 K, tint +10), so a daylight-balanced file lands at 0/0 and the map is monotonic:

1. The illuminant's chromaticity on the Planckian locus in CIE 1960 uv (Krystek's rational approximation, 2000–15000 K), offset along the locus normal by tint ÷ 3000.
2. uv → xy → XYZ → linear sRGB, divided by the reference illuminant's sRGB.
3. That patch is solved against the shader's white-balance model, `(1 + 0.25t, 1 − 0.25tᵢ, 1 − 0.25t)`, for `t` and `tᵢ`.

Temperature and tint are mapped separately, each from its own Lightroom slider, so a Kelvin-only edit never moves tint. "As Shot" leaves `wb` unset; "Auto" needs pixels and is reported.

### Reported as not imported

Auto tone, auto white balance, calibration, profile and look, legacy PV2010 tone, parametric curve, RGB channel curves, color grade luminance and global wheel, sharpen detail, noise-reduction detail, lens vignetting, profile chromatic aberration, legacy defringe, Upright, transform rotate/scale/offset, masks, spot removal, red eye, point color, lens blur and HDR editing.

## Writing XMP

`writeXmp(doc, meta)` (`src/io/xmpWrite.js`) is the parser's inverse: the same table, read right to left, plus rating, label, title, caption and keywords. A RAW gets an absolute white balance (`Temperature`, `Tint`, found by inverting the illuminant map), a JPEG or TIFF the incremental sliders. What Lightroom cannot hold (masks, heal spots, removal patches, the look, highlight reconstruction, AI denoise) stays out of `crs:` and goes, with the whole edit document, into one `albedo:EditDoc` property, so albedo reads its own sidecars back exactly and Lightroom, Camera Raw and darktable read what they understand.

The export dialog writes sidecars next to any export, and the Original and DNG formats carry the edit with the capture. `writePresetXmp(name, group, modules)` writes a preset Lightroom imports.
