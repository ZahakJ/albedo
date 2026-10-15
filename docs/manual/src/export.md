# Export

`⌘E` exports the photo in Develop, or the selection in the Library.

| format | |
|---|---|
| **JPEG** | quality 60–100 |
| **PNG** | 8 bits per channel |
| **TIFF** | 16 bits per channel, sRGB, compressed |
| **DNG** | the RAW data, with the edit inside as XMP |
| **Original** | the file as imported, untouched, with an XMP sidecar |

For JPEG, PNG and TIFF: a long edge to resize to, output sharpening, and for JPEG and PNG a text watermark. JPEG keeps the camera's EXIF.

**XMP sidecar** writes the edit next to each file in a form Lightroom, Camera Raw and darktable read.

The filename pattern takes `{name}`, `{seq}`, `{date}` and `{rating}`. Several photos, or a format with a sidecar, go into one folder you choose.

Export settings can be saved as presets.
