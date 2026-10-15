# Getting started

## Open albedo

Open [the app](https://zahakj.github.io/albedo/app/). To install it, use the browser's install button in the address bar (Chromium) or *Add to Dock* (Safari). The installed app opens RAW, JPEG, PNG, TIFF and XMP files from the file manager's *Open with* menu.

## Import

Drop files on the window, or press `O`. albedo reads the RAW formats LibRaw supports (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, DNG and many more), plus JPEG and PNG. Files dropped together keep their order.

- An `.xmp` sidecar named like a photo (`IMG_1.xmp` or `IMG_1.CR2.xmp`) applies its Lightroom edit to that photo.
- Any other `.xmp` becomes a preset.
- A `.dcp` file becomes a camera profile.

Thumbnails come from the preview the camera embedded, so a large import is browsable at once.

## Edit

Double-click a photo, or press `D`. Every slider can be dragged anywhere on its row; `Alt` drags finely, `Shift` coarsely, a double-click resets it, and a click on the value types one. Each change is one undo step (`⌘Z`).

Edits are saved as you go. The original is never changed.

## Export

Press `⌘E`. See [Export](export.md).
