# Architecture

albedo is a single HTML document with no server component. Vite builds it to static files; everything that touches pixels, files or the database runs in dedicated workers, and the main thread only runs React and forwards messages.

```
                         main thread (React UI, stores)
          ┌──────────────┬──────────────┬──────────────┬──────────────┐
          │              │              │              │              │
   decode.worker   render.worker  catalog.worker   ai.worker     canvas.worker
   libraw-wasm     WebGPU/WebGL2  sqlite-wasm     onnxruntime-web 2D compositor
   (own nested     OffscreenCanvas OPFS files     WebGPU | wasm   OffscreenCanvas
    wasm worker)         ▲                              │
                         └────── MessageChannel ────────┘  AI denoise tiles
```

| worker | owns | file |
|---|---|---|
| decode | LibRaw. Turns RAW bytes into a mosaic or RGB payload | `src/workers/decode.worker.js` |
| render | the GPU device, the Develop canvas, histogram, auto adjustments, export rendering | `src/workers/render.worker.js` |
| catalog | the SQLite connection and all OPFS file I/O | `src/workers/catalog.worker.js` |
| ai | the local models (masks, object selection, removal, denoise), loaded on first use | `src/workers/ai.worker.js` |
| canvas | the layered raster documents of the Canvas surface | `src/workers/canvas.worker.js` |

## Messages

`src/workers/protocol.js` is the contract for decode, render, catalog and AI; `src/workers/canvasProtocol.js` is the separate contract for the canvas worker. Every request is `{ id, type, ...payload }` and every reply `{ re: id, ok, ...payload }`. Pixel buffers, file bytes and blobs always cross as transferables.

Each worker has a thin client on the main thread (`src/state/*Client.js`, `catalogStore.js`) that turns requests into promises. `renderClient` coalesces `PARAMS` sends to one per animation frame, so a slider drag produces at most one render per frame regardless of pointer rate.

## Flow of a photo

1. **Import.** The UI reads the dropped files and transfers their bytes to the catalog worker (`CAT_IMPORT`). For each file it writes `originals/<id>.<ext>` with a sync access handle and flushes it, parses EXIF in JS (`src/io/exif.js`), takes the largest embedded JPEG of a RAW (or the file itself for JPEG/PNG), writes a 512 px thumbnail, then inserts the `photos` row. A file that fails does not stop the batch. Progress streams back as `CAT_PROGRESS`.
2. **Thumbnail fallback.** A RAW with no usable embedded preview gets `thumb_state = 2`; the main thread then runs a half-size LibRaw decode (`quality: 'proxy'`) and hands the thumbnail back with `CAT_SAVE_THUMB`.
3. **Library views.** The grid queries `CAT_QUERY` and loads thumbnails lazily. Compare, survey and cull use a cached 2048 px preview (`CAT_GET_PREVIEW`, stored under `previews/`), so they never wake the GPU.
4. **Open in Develop.** `src/state/openPhoto.js` loads the original and its saved edit document in parallel, decodes the RAW at full quality, sends any DCP profile the document names (`PROFILE`), and sends source and document to the render worker (`OPEN`). While the GPU demosaics, the worker looks the lens up in lensfun, so the first frame carries the saved edit and the lens profile. AI-mask weights (`MASKTEX`) and removal patches (`PATCH`) are replayed afterwards, and an AI denoise the document asks for starts (see below).
5. **Edit.** A slider drag updates the DOM directly and streams `PARAMS` with `gesture: true`; React and the edit store commit once when the gesture ends, adding one undo entry. The committed document is saved through a 500 ms write-behind (`CAT_SAVE_DOC`), flushed before a version switch and on `beforeunload`.
6. **AI denoise.** The render worker no longer holds the mosaic, so `src/state/denoiseClient.js` decodes the file again and hands it to the AI worker together with one end of a MessageChannel; the render worker gets the other end (`DN_PORT`). Denoised tiles flow worker to worker and are placed on the GPU as they arrive, outside the render worker's message queue, so an export waiting for them cannot block them.
7. **Export.** The render worker re-renders the retained source at full or reduced resolution and encodes a blob (`EXPORT`). The main thread copies the original's EXIF into JPEG output, applies any remaining resize and writes the file into a chosen directory (File System Access API) or downloads it.

## State on the main thread

Stores are plain modules with `useSyncExternalStore` hooks; there is no state library.

| store | holds |
|---|---|
| `viewStore` | surface (library, develop, canvas), library mode (grid, compare, survey, cull), selection, zoom, thumbnail size, theme |
| `catalogStore` | query results, sidebar data, debounced document saves, catalog worker proxy |
| `editStore` | the open photo, its edit document, the undo history (one entry per gesture), snapshots |
| `versionStore` | the versions of the open photo |
| `presetStore` | user and built-in presets, preset import, XMP sidecar pairing |
| `toastStore` | transient messages |
| `lensStore` | the lens profile found for the open RAW |
| `profileStore` | imported DCP camera profiles |
| `denoiseClient` | the AI denoise of the open photo and its progress |

`src/state/commands.js` is the single command registry. The `⌘K` palette and the `?` cheat sheet both read it, so a command and its shortcut are declared once.

## UI scale

`--ui-scale` in `src/styles/tokens.css` (shipped at `1.25`) is the one dial for chrome size. Type, controls, spacing and the fixed lengths in the component sheets derive from it; panel widths grow at half the rate. The image stage and its overlays are outside the scale: crop, masks, heal, sliders and the curve editor convert pointer positions through `getBoundingClientRect`, so they stay in plain CSS pixels, which is why the dial is a set of tokens and not `zoom` on the root. Layouts that compute geometry in JS (filmstrip slots, crop toolbar, the grid's badge threshold) read the dial through `src/ui/uiScale.js`. Below 760 px wide, `src/styles/narrow.css` sets the dial to 1, hides the navigator, metadata and preset rail, and stacks Develop vertically.

Chrome colors are strict neutral grays (R = G = B) so the surround does not bias color judgement; the single amber accent stays away from the image.

## Concurrency guards

- The SQLite VFS (`opfs-sahpool`) holds exclusive sync access handles, so only one connection per origin can exist. The catalog worker takes the Web Lock `albedo-catalog` with `ifAvailable`; a second tab gets a clear error instead of a corrupted database.
- Every catalog write path that creates a file finishes the file before inserting the row that points to it. Deletion removes rows first in one transaction and files afterwards; an orphaned file is invisible.
- Saves pending for a photo being deleted are dropped so they cannot recreate its `edits` row.
- The render and AI workers process messages strictly in order. Two exceptions jump the queue: a denoise cancel (it must reach the job it stops) and denoise tiles (an export waiting in the queue for them would otherwise block them).

## Source layout

```
src/
  App.jsx, main.jsx      shell, topbar, global keys, drop handling
  ui/                    Library, Grid, Cull, Compare, Survey, Develop and its panels,
                         overlays (crop, mask, heal), dialogs, palette, cheat sheet
  edit/                  the Canvas surface: layers panel, tool options, history, recent docs
  state/                 stores and worker clients
  engine/                edit document model, curve LUT, geometry, history labels
  engine/gpu/            device selection, WebGPU and WebGL2 backends
  engine/gpu/shaders/    wgsl/ and glsl/ twins: demosaic, develop, blur, nr, finish, stamp
  engine/                (also) lensfun matching, DCP colour math, highlight chroma
  io/                    OPFS helpers, EXIF reader, XMP read and write, DCP parser,
                         TIFF and DNG writers, zip, export helpers
  workers/               the five workers and both protocols
  styles/                tokens, one sheet per area, narrow.css last
test/                    Playwright end-to-end suites, node:test unit tests
scripts/fetch-models.mjs AI models (checked by SHA-256) and the onnxruntime wasm
scripts/fp16.py          half-precision weights for the larger models
scripts/build-lensfun.mjs the lensfun database as JSON (public/lensfun/)
deploy/albedo.service    systemd user unit serving dist/
```

## Further reading

- [PIPELINE.md](PIPELINE.md): what the render worker does to a pixel
- [CATALOG.md](CATALOG.md): the schema, OPFS layout and edit document
- [PRESETS.md](PRESETS.md): preset files and Lightroom XMP
- [DEVELOPMENT.md](DEVELOPMENT.md): tests and hosting
- [MODELS.md](MODELS.md): the AI models, their sources and licenses
- [BENCHMARKS.md](BENCHMARKS.md): speed, memory and quality measurements
