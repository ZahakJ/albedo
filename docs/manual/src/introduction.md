# Introduction

albedo develops RAW photos in the browser. It keeps a catalog, culls, develops on the GPU, masks with local AI, removes distractions, denoises, and exports JPEG, PNG, 16-bit TIFF, DNG or the original with an XMP sidecar.

Everything happens on your machine: the photos, the catalog and the AI models stay in the browser's private storage, and nothing is uploaded. Installed as an app, albedo works offline and opens files from the desktop.

## What it needs

- A Chromium-based browser (Chrome, Edge, Brave, Arc) for WebGPU and file handling. Firefox and Safari run the WebGL2 path.
- A GPU. Any integrated GPU develops; the AI tools are fastest on a discrete one.
- Disk space: the catalog stores a copy of every original you import.

## Where things are

| | |
|---|---|
| **Library** | the catalog: a grid, filters, collections, metadata |
| **Develop** | one photo: every adjustment, masks, Remove, export |
| **Canvas** | layered compositing for posters and collages |
