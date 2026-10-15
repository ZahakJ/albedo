# Lightroom and other programs

## Bringing edits in

Drop a Lightroom or Camera Raw `.xmp` sidecar with its photo, and the edit applies: exposure and tone, white balance, the tone curve, HSL, B&W, colour grading, clarity, texture, dehaze, vignette, grain, crop and angle, perspective, sharpening, noise reduction and lens settings. A line after the import names anything that could not be carried over.

Lightroom presets (`.xmp`) dropped on their own become presets in albedo.

## Taking edits out

- Export **Original** to get the untouched file with an XMP sidecar, or tick **XMP sidecar** for any format.
- Export **DNG** to get a raw file Lightroom opens with the edit already applied.
- In the preset rail, a preset's menu has *Export for Lightroom…*.

Masks, removals, heal spots and the look are albedo's own; they travel inside the sidecar in albedo's namespace, so albedo reads its own files back exactly while other programs read what they understand.

## Camera profiles

Adobe's camera profiles (`.dcp`) work in albedo; see [Profiles and lenses](profiles.md).
