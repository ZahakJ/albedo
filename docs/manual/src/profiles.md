# Profiles and lenses

## Looks

A RAW starts with the **AgX** look: a filmic tone curve that rolls highlights off toward white instead of clipping each channel, after a half stop of baseline exposure. *Baseline* and *Look Sat.* adjust it. **Linear** clamps instead, the way a JPEG is shown.

## Camera profiles

Drop `.dcp` files (Adobe's, RawTherapee's, or any profile following the DNG specification) on the window. The Profile section then offers the ones made for the photo's camera under *Camera profile…*. A profile replaces the colour matrix, applies its hue and saturation tables, and its tone curve replaces the look's.

## Lens corrections

When a RAW opens, albedo looks its lens up in the [lensfun](https://lensfun.github.io) database and corrects distortion, lateral chromatic aberration and vignetting. The Lens section names the lens it found; *Profile Dist.* and *Profile Vign.* scale the corrections, and the PROFILE switch turns them off. Fisheye lenses are not corrected.

## Highlights

Clipped highlights are rebuilt from the channels that did not clip, so a blown sky turns white instead of magenta. The HL switch in the Lens section turns this off.
