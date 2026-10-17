# Introduction

albedo develops RAW photos in the browser and edits them in layers. It keeps a catalog, culls, develops on the GPU, masks with local AI, removes distractions, denoises, composites and retouches in 16 or 32 bits, and exports JPEG, PNG, 16-bit TIFF, DNG, PSD or the original with an XMP sidecar.

Everything happens on your machine: the photos, the catalog and the AI models stay in the browser's private storage, and nothing is uploaded. Installed as an app, albedo works offline and opens files from the desktop.

## What it needs

- A Chromium-based browser (Chrome, Edge, Brave, Arc) for WebGPU and file handling. Firefox and Safari run Library and Develop on the WebGL2 path; Compose needs WebGPU (Safari 26 and Firefox 141 have it).
- A GPU. Any integrated GPU develops; the AI tools are fastest on a discrete one.
- Disk space: the catalog stores a copy of every original you import.

## Where things are

| | |
|---|---|
| **Library** | the catalog: a grid, filters, collections, metadata |
| **Develop** | one photo: every adjustment, masks, Remove, export |
| **Compose** | layers: retouching, compositing, type, PSD in and out, RAW smart objects |
