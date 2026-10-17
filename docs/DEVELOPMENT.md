# Development

## Setup

```sh
npm install
npm run dev               # vite on :5180
npm run setup-models      # AI masks, object selection, Remove, AI Denoise
```

`setup-models` downloads the models listed in [MODELS.md](MODELS.md) into `public/models/`, checking each against its SHA-256, and copies the onnxruntime-web wasm into `public/ort/`. Downloads are cached in `.cache/models` (`ALBEDO_MODEL_CACHE` moves it). With Python's `onnx` and `numpy` installed (`PYTHON` picks the interpreter), the two large segmentation models are stored at half precision. Both directories are gitignored and served by the app; without them the AI tools say the model is not installed.

The lensfun database ships as JSON in `public/lensfun/` (CC BY-SA 3.0, see its `LICENSE`). `npm run setup-lensfun` rebuilds it from lensfun's master branch.

The development server needs no special headers: sqlite-wasm uses the `opfs-sahpool` VFS and onnxruntime runs single-threaded on the CPU, so neither needs `SharedArrayBuffer` or cross-origin isolation.

`vite.config.js` keeps `@sqlite.org/sqlite-wasm`, `libraw-wasm` and `onnxruntime-web` out of dependency pre-bundling: each locates its wasm relative to `import.meta.url`. Workers build as ES modules.

## Tests

```sh
npm test                  # unit tests, then every end-to-end suite in sequence
npm run test:unit         # node:test only: XMP, presets, lensfun, DCP, TIFF, DNG, Compose outlines and type
node test/<name>.e2e.mjs  # one end-to-end suite
```

The end-to-end suites drive headless Chromium through Playwright. Each starts its own Vite server on a fixed port in the 5180–5195 range (`test/server.mjs`), or reuses one already listening there, and stops it on exit. Most suites generate synthetic images into `test/fixtures/` (gitignored); `raw`, `rawthumb`, `grade` and `denoise` also need real RAW samples there: `sample.dng`, `sample.cr2` and `sample.raf`. The AI suites skip when the models are not installed.

`compose.e2e.mjs` needs a GPU-backed browser, so run it as `xvfb-run -a node test/compose.e2e.mjs`; without a display it skips. It checks every blend mode against the reference formulas, adjustments, masks, clipping, groups, selections, the brushes, transforms, type, frequency separation, PSD round trips, saving and liquify, all by readback. `TEST_URL=<url>` points it (and `compose-bench.mjs`) at a static build instead of a dev server, so editing source during a long run doesn't reload the page.

Headless Chromium renders on SwiftShader, which cannot composite a worker-owned WebGPU canvas into a screenshot and runs models on one CPU thread. Suites therefore assert on export readback rather than screenshots wherever colour matters, and run the WebGPU and WebGL2 backends side by side.

`test/tone.html`, `test/raw.html` and `test/catalog.html` are harness pages that drive a single worker directly, without the UI.

## Measuring

Real-GPU numbers need a GPU-backed browser. Headless Chromium falls back to a software adapter; a headed Chromium under `xvfb-run` gets the hardware one.

| command | measures |
|---|---|
| `xvfb-run -a node test/bench.mjs <dir> [webgpu,webgl2] [masks]` | decode, open, frame time, export for every RAW in `dir`; `DN=100` adds AI denoise, `DCP=<file>` a camera profile, `SAVE=<dir>` keeps the exports |
| `xvfb-run -a node test/ai-bench.mjs <photo.jpg> [x y] [outdir]` | subject, sky, object click and Remove timings, cold and warm |
| `xvfb-run -a node test/scale.mjs [n]` | an n-photo catalog: import rate, Library queries, grid scrolling |
| `xvfb-run -a node test/compose-bench.mjs [raw]` | a 50-layer Compose document on a 24 MP RAW: frame times at fit and 100%, panning, a Develop adjustment slider, a brush stroke, VRAM and browser memory |
| `node test/demosaic.mjs <dir of PNGs>` | demosaic PSNR against bilinear and Malvar-He-Cutler on synthetic mosaics |

Results are in [BENCHMARKS.md](BENCHMARKS.md).

## Build and host

```sh
npm run build             # static site in dist/
npm run preview           # serve dist/ locally
```

`dist/` is a complete static site with relative URLs, so it works at a domain root or under any path: `index.html`, hashed JS and CSS, the workers as ES modules, the wasm for SQLite, LibRaw and onnxruntime, the lensfun data, the models if they were installed, and `sw.js`. Any static server works if it serves `.wasm` as `application/wasm` and `.js` as JavaScript; no routing fallback is needed.

The service worker precaches everything but the models, which it caches the first time they load, so a visited site keeps working offline. The manifest makes the app installable and registers it as a handler for RAW, JPEG, PNG, TIFF and XMP files; files opened from the desktop arrive through the launch queue.

`deploy/albedo.service` is a systemd user unit that serves `dist/` with Python's threaded `http.server`. The server must answer requests in parallel: on first load the workers fetch their wasm concurrently.

The project site is built by `docs/build-site.sh`: the landing page from `docs/site/`, the manual (mdBook) from `docs/manual/`, and the app under `app/`. `.github/workflows/pages.yml` runs it on every push to `main`.

Each visitor's catalog lives in their own browser's OPFS; nothing is stored on the server.

## Browser support

- WebGPU where available, WebGL2 otherwise; `?backend=webgl2` forces WebGL2. Compose needs WebGPU. AI Denoise needs a GPU that reads back by itself, which every hardware WebGPU or WebGL2 device does.
- OPFS with sync access handles in workers, `OffscreenCanvas`, module workers and `Float16Array` are required.
- Export into a folder uses the File System Access API (`showDirectoryPicker`) where available and falls back to downloads.
- One tab per origin at a time; the catalog's Web Lock refuses a second.

## Desktop

The installed web app is the desktop app: in Chromium-based browsers it runs the same GPU pipeline on every OS, offline, and opens files from the system. A webview shell such as Tauri would lose WebGPU on Linux, where WebKitGTK has none.
