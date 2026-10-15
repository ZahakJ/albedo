<p align="center"><img src="docs/media/banner.webp" width="820" alt="albedo's Develop view: a RAW photo of a tea plantation with the Profile and Tone panels"></p>

albedo is a RAW photo developer that runs in the browser: catalog, cull, develop on the GPU, mask with local AI, and export JPEG, PNG, 16-bit TIFF, DNG or the original with an XMP sidecar. Installed, it works offline and opens files from the desktop.

<p align="center">
  <img src="docs/media/library.webp" width="400" alt="Library: a grid of photos with flags and star ratings, the date tree on the left and metadata on the right">
  <img src="docs/media/masks.webp" width="400" alt="Masking: a lake at dawn with the sky selected by the AI sky mask, shown as a red wash">
</p>
<p align="center">
  <img src="docs/media/develop.webp" width="400" alt="Develop: a motorcycle on autumn leaves, the Lens panel showing the matched lens profile">
  <img src="docs/media/export.webp" width="400" alt="The export dialog with JPEG, PNG, TIFF, DNG and Original formats and the XMP sidecar option">
</p>

The photos are CC0 samples from [raw.pixls.us](https://raw.pixls.us).

**[Open albedo](https://zahakj.github.io/albedo/app/)** · [Manual](https://zahakj.github.io/albedo/manual/)

## Run

```sh
git clone https://github.com/ZahakJ/albedo.git && cd albedo
npm install
npm run setup-models   # optional: AI masks, Remove, AI Denoise
npm run dev            # http://localhost:5180
```

`npm run build` writes a static site to `dist/` that any static file server can host, at a domain root or under a path; no special headers are needed.

## Use

- **Import**: drop files on the window or press `O`. CR2, CR3, NEF, ARW, RAF (Bayer and X-Trans), ORF, RW2, PEF, DNG and the other formats LibRaw reads, plus JPEG and PNG. Lightroom `.xmp` sidecars apply to their photos, other `.xmp` files become presets, `.dcp` files become camera profiles.
- **Library** (`G`): pick, reject, unflag (`P` `X` `U`), rate `0`–`5`, label `6`–`9`, search (`⌘F`). Albums, smart collections, a capture-date tree. `⇧C` culls full screen, `C` compares, `N` surveys.
- **Develop** (`D`): profile (AgX, linear or a DCP), white balance, tone, point curve, HSL mixer, B&W, three-way grading, clarity, texture, dehaze, vignette, grain, lens profile corrections, sharpening, wavelet or AI noise reduction; crop (`R`).
- **Masks** (`M`): linear, radial, brush, and AI subject, sky, background or object (`B`, click or drag a box), each refinable by luma and colour range.
- **Remove** (`Q`): paint over anything, or click an object, and it is filled from its surroundings. **Heal** (`H`): spot heal and clone.
- **Export** (`⌘E`): JPEG, PNG, 16-bit TIFF, DNG with the edit inside, or the original, each with an optional XMP sidecar that Lightroom, Camera Raw and darktable read.

`⌘K` opens the command palette; `?` lists every shortcut.

## How it works

Five workers keep the main thread free. The decode worker runs LibRaw compiled to WebAssembly and hands the raw mosaic to the render worker, which demosaics it on the GPU (RCD for Bayer sensors, a directional method for X-Trans), inpaints clipped highlights, applies the lens profile and camera colour, and runs the whole edit as fragment passes with the same math in WGSL and GLSL. The AI worker runs ONNX models through onnxruntime-web on WebGPU, and streams AI-denoised tiles straight to the render worker. The catalog worker keeps a SQLite database in the Origin Private File System beside every original, thumbnail, edit and mask. An edit is a small JSON document; export renders the original from it.

## Documentation

- [Manual](https://zahakj.github.io/albedo/manual/)
- [Architecture](docs/ARCHITECTURE.md): threads, messages, state, source layout
- [Render pipeline](docs/PIPELINE.md): decode, demosaic, the develop pass, profiles, masks, removal, denoise, export
- [Catalog and storage](docs/CATALOG.md): SQLite schema, OPFS layout, the edit document
- [Presets and Lightroom XMP](docs/PRESETS.md): preset files, the XMP mapping in both directions
- [Models](docs/MODELS.md): the AI models, their sources and licenses
- [Benchmarks](docs/BENCHMARKS.md): speed against darktable and RawTherapee, memory, demosaic quality, a 10,000-photo catalog
- [The field](docs/COMPETITION.md): Lightroom, Photoshop, Capture One and the open-source developers
- [Development](docs/DEVELOPMENT.md): tests, measuring, building and hosting

## License

Copyright (c) 2026 ZahakJ. Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Commercial licences on other terms are available from the copyright holder.

Bundled: LibRaw (CDDL-1.0 or LGPL-2.1, via libraw-wasm, which also carries Little CMS), SQLite (public domain), onnxruntime-web (MIT), React (MIT), IBM Plex fonts (OFL-1.1, subset; `public/fonts/OFL.txt`), the lensfun database (CC BY-SA 3.0; `public/lensfun/LICENSE`). The AI models are downloaded at setup under their own licenses, listed in [MODELS.md](docs/MODELS.md).
