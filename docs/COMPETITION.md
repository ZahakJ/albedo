# The field

Survey of photo developers and editors as of October 2026. Lightroom Classic is the reference for every comparison. Claims link to their source.

## Lightroom Classic 15.5 and Lightroom

- **Ships.**
  - Mask feather and edge, Render to DNG ([notes](https://helpx.adobe.com/ca/lightroom-classic/desktop/introduction-to-lightroom-classic/release-notes.html)).
  - Duplicate stacks and assisted culling by eyes and sharpness ([15.4](https://helpx.adobe.com/sa_en/lightroom-classic/desktop/introduction-to-lightroom-classic/whats-new.html)).
  - Distraction Removal for people, reflections and dust ([help](https://helpx.adobe.com/vn_en/lightroom-classic/help/distraction-removal-people.html)).
  - Adaptive profiles that change per image ([blog](https://blog.adobe.com/en/publish/2024/10/14/the-adobe-adaptive-profile)).
- **Loved.** A mature catalog that holds 200k photos ([thread](https://community.adobe.com/questions-675/tired-of-the-extreme-slowness-and-the-multiple-problems-my-lightroom-classic-has-983764)), and the widest preset and profile ecosystem.
- **Hated: Develop slows over a session.**
  - The 15.5.1 report has `.lrcat-data` at 85 GB for 20k photos, 35–50 minute optimizes and 33.9 GB of RAM in use; Adobe ties it to mask-heavy edits ([report](https://community.adobe.com/bug-reports-674/lightroom-classic-15-5-1-technical-performance-report-1644232)).
  - A 540k-photo catalog was "unusable" ([thread](https://community.adobe.com/t5/lightroom-classic-bugs/p-performance-slow-on-large-catalog-540k-images-crash-9690382/td-p/14868732)).
- **Hated: sliders lag for 1–2 s once masks pile up** ([thread](https://community.adobe.com/questions-675/1-2-second-lag-between-walking-images-or-slider-reaction-964832), [thread](https://community.adobe.com/t5/lightroom-classic-discussions/performance-on-lightroom-classic-very-poor-in-develop-module-especially-when-any-masks-are-used/m-p/12982194/highlight/true)).
- **Hated: 1:1 previews.** 460 raws take 1.5 h, and any edit invalidates them ([thread](https://community.adobe.com/t5/lightroom-classic-discussions/is-there-any-practical-way-to-speed-up-making-1-1-previews/td-p/13700684)).
- **Hated: price and lock-in.**
  - Price rises of 40–68% ([DCW](https://digitalcameraworld.com/tech/software/adobe-hikes-photoshop-prices-by-huge-50-percent-amid-stock-downturn-is-it-all-ais-fault)).
  - The cloud app counts originals against storage, while Classic syncs only 2560 px smart previews ([thread](https://community.adobe.com/t5/lightroom-classic-discussions/cloud-storage-for-lightroom-classic/m-p/12854816/highlight/true)).
  - Generative Remove needs a connection ([help](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/remove-tool.html)).
- **Speed numbers.** AI Denoise in PugetBench takes 8.8 s on an RTX 5070 and 4.4 s on an RTX 5090 ([PugetBench](https://www.pugetsystems.com/pugetbench/results/compare/Puget%20Bench%20for%20Lightroom%20Classic/29/GPU/NVIDIA%20GeForce%20RTX%204070%20SUPER/NVIDIA%20GeForce%20RTX%205070/)). Users report 20–24 s per 50 MP file on an RTX 4060 Ti ([report](https://community.adobe.com/bug-reports-674/lightroom-classic-15-5-1-technical-performance-report-1644232)).

## Photoshop 27 and Camera Raw

- **Ships.**
  - Generative Fill with partner models, Harmonize, generative upscale, and an on-device generative option in 27.7 ([notes](https://helpx.adobe.com/ca/photoshop/desktop/whats-new/photoshop-on-desktop-release-notes.html)).
  - Select Subject in device and cloud modes ([PhotoshopCAFE](https://photoshopcafe.com/on-device-select-subject-in-photoshop-improved-ai-selections-without-the-cloud/)).
  - Raw Details and Super Resolution ([help](https://helpx.adobe.com/camera-raw/using/enhance.html)), and Lens Blur from a depth map ([jkost](https://jkost.com/blog/2023/10/lens-blur-early-access-in-adobe-camera-raw.html)).
- **Hated.**
  - Generative credits have been metered since June 2025 ([PetaPixel](https://petapixel.com/2025/06/24/adobe-is-now-tracking-generative-credit-use-what-you-need-to-know)), and accounts were blocked while they still held credits ([thread](https://community.adobe.com/t5/photoshop-ecosystem-discussions/when-i-try-to-use-a-feature-like-generative-fill-i-receive-an-error-message-that-says/m-p/15553288)).
  - Harmonize alters texture ([Fstoppers](https://fstoppers.com/photoshop/best-updates-hidden-inside-photoshop-2026-715565)).

## Capture One 16.8

- **Ships.**
  - AI denoise, assisted review, and tethered previews in under 1 s ([16.8](https://www.captureone.com/explore-features/whats-new/16-8)).
  - AI subject masks at 5–10 s per image in 16.3, later GPU-accelerated ([history](https://support.captureone.com/hc/en-us/articles/360012248397-The-history-of-tools-and-features-added-to-Capture-One)).
- **Loved.** Color, skin tone tools and tethering ([DIYP](https://www.diyphotography.net/lightroom-vs-capture-one/)).
- **Hated.**
  - Perpetual licences get no new features ([thread](https://www.talkphotography.co.uk/threads/capture-one-perpetual-licences-will-no-longer-receive-new-features.744436/latest)).
  - The catalog freezes during search and keywording ([thread](https://support.captureone.com/hc/de/community/posts/9816833103645-Improved-handling-of-catalogues-i-e-faster-and-less-unresponsive)).
  - Edits never leave the app as XMP ([thread](https://support.captureone.com/hc/en-us/community/posts/360011875418-Loading-reading-xmp-files)).

## darktable 5.6

- **Ships.**
  - Demosaic: RCD by default, plus AMaZE, LMMSE, dual demosaic and Markesteijn for X-Trans ([manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/demosaic/)).
  - Highlight reconstruction: inpaint opposed, segmentation and guided laplacians ([manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/highlight-reconstruction/)).
  - Tone mapping: sigmoid by default ([5.2](https://www.darktable.org/2025/06/darktable-5.2.0-released/)) and AgX ([5.4](https://www.darktable.org/2025/12/darktable-5.4.0-released/)).
  - Color calibration with CAT16 ([manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/color-calibration/)), lensfun lens correction, and profiled denoise for more than 300 sensors.
  - Optional AI masks and denoise, which need a build flag ([5.6](https://www.darktable.org/2026/06/darktable-5.6.0-released/)) and were still getting crash fixes in 5.6.2 ([5.6.2](https://www.darktable.org/2026/10/darktable-5.6.2-released/)).
- **Loved.** Masking, OpenCL speed and highlight recovery ([forum](https://discuss.pixls.us/t/is-it-worth-migrating-to-dark-table-from-rawtherapee/53684)).
- **Hated.**
  - "Hard work", too many overlapping modules, and a flat starting image ([forum](https://discuss.pixls.us/t/is-it-worth-migrating-to-dark-table-from-rawtherapee/53684), [forum](https://discuss.pixls.us/t/improvement-suggestions/48670)).
  - No DCP support ([camicc](https://discuss.pixls.us/t/camicc-converting-adobes-dcp-profiles-to-icc-for-darktable/59588)).
  - Lightroom XMP import covers 10 steps, approximately ([manual](https://docs.darktable.org/usermanual/development/en/overview/sidecar-files/sidecar-import/)).

## RawTherapee 5.13 and ART 1.26

- **RawTherapee ships.**
  - Demosaic: AMaZE by default, plus RCD, DCB, LMMSE, dual demosaic and pixel shift ([RawPedia](https://rawpedia.pixls.us/demosaicing/)).
  - First-class DCP support ([5.11](https://rawtherapee.com/downloads/5.11/)).
  - Sigmoid tone mapping and ACES gamut compression ([5.12](https://discuss.pixls.us/t/rawtherapee-5-12-released/50494)).
- **RawTherapee is hated for.**
  - About 2 s per change, and no full-resolution preview unless zoomed in ([forum](https://discuss.pixls.us/t/is-it-worth-migrating-to-dark-table-from-rawtherapee/53684), [forum](https://discuss.pixls.us/t/art-vs-rawtherapee/32594/41)).
  - No catalog ([forum](https://discuss.pixls.us/t/what-do-you-use-for-cataloguing-with-rawtherapee/34152)) and no AI.
- **ART** is a simpler RawTherapee with masks and XMP. Its AI runs only through external scripts, and "full integration won't likely happen" ([AItools](https://artraweditor.github.io/AItools)).

## Ansel and digiKam

- **Ansel** is an alpha fork of darktable 4.0.
  - Its own benchmarks show it faster than darktable 5.0 ([repo](https://github.com/aurelienpierreeng/ansel)).
  - Users miss deleted modules and worry about it having a single developer ([forum](https://discuss.pixls.us/t/ansel-vs-darktable-thoughts/59561)).
- **digiKam 9.1** has a strong DAM, with YuNet/SFace faces and YOLO auto-tags ([8.6](https://www.digikam.org/news/2025-03-15-8.6.0_release_announcement/)).
  - Its raw development uses the LibRaw basics only ([docs](https://docs.digikam.org/en/setup_application/editor_settings.html)).
  - Its sidebars are cluttered ([bug](https://bugs.kde.org/show_bug.cgi?id=518072)).

## GIMP 3.2, PhotoGIMP, Krita, Photopea, Graphite

- **GIMP 3.2** ([notes](https://gimp.org/release-notes/gimp-3.2.html)).
  - Filters can be re-edited non-destructively, but crops and transforms are destructive and there are no adjustment layers.
  - Raw goes out to darktable, RawTherapee or ART plug-ins.
  - Its UX is a standing complaint ([forum](https://discuss.pixls.us/t/gimp-is-falling-behind-where-is-the-ux/48708)).
- **PhotoGIMP** remaps GIMP to Photoshop's shortcuts and layout. It adds no features ([repo](https://github.com/Diolinux/PhotoGIMP)).
- **Krita 5.3/6.0** handles 16- and 32-bit float images. Generative fill comes through a ComfyUI plug-in that needs 6 GB of VRAM ([krita-ai-diffusion](https://github.com/Acly/krita-ai-diffusion)), and stacks of non-destructive filters are slow.
- **Photopea** is a proprietary web editor that runs on ads. Its raw controls are limited to white balance, exposure and contrast ([Digitec](https://www.digitec.ch/en/page/photopea-open-and-edit-photoshop-files-in-the-browser-16227)), and its AI is credit-metered.
- **Graphite** is a node-based editor in alpha. Its raster tools are "limited, experimental" ([features](https://graphite.art/features)).

## Open-source Lightroom clones of 2025–2026

| project | stack | strengths | gaps |
|---|---|---|---|
| [RapidRAW](https://github.com/cybertimon/rapidraw) | Rust, wgpu, React, Tauri; AGPL | sidecars, culling, SAM 2 / U²-Net / depth masks, LaMa inpaint | "not yet as polished", 16 GB RAM advised |
| [LightCraft](https://github.com/storytold/lightcraft) | Rust, MIT/Apache | append-only catalog, f32 pipeline, CLI and MCP | heuristic masks, self-rated ~61% of Lightroom |
| [Rembrandt](https://github.com/thesnarkitecht/rembrandt) | JS WebGPU, LibRaw wasm, Tauri; GPL | XMP sidecars, Lightroom catalog import, AI masks | young; doubts on longevity ([HN](https://news.ycombinator.com/item?id=50012199)) |
| [redlamp](https://github.com/pdcgomes/redlamp) | Swift, Metal; MPL | native, AI masks | macOS only, no catalog |

## What nobody does well

1. **Speed that holds.** Lightroom and Capture One slow down as the catalog and session grow. RawTherapee re-renders in seconds, and darktable's OpenCL speed depends on tuning.
2. **Many masks without lag.** Adobe acknowledges the problem.
3. **Local AI that just works.** It is cloud or metered at Adobe. darktable gates it behind a build flag, ART and Krita need external tools, and RapidRAW asks for 16 GB.
4. **Portable edits.** Capture One edits stay trapped, and darktable reads only 10 Lightroom steps.
5. **A good first render.** darktable starts flat, and Lightroom's adaptive profiles hide their decisions.
6. **Zero install.** No open developer runs in a browser with a real raw pipeline. Photopea is closed and runs on ads.

## Targets

Each category is judged against Lightroom Classic on the same machine. A target counts as met only when it is measured in [BENCHMARKS.md](BENCHMARKS.md).

| category | Lightroom Classic | target | measured |
|---|---|---|---|
| open a 45 MP raw | embedded preview, then a render in about 1–2 s | embedded preview in < 100 ms, full render in < 1.5 s | thumbnail at once; decode + first frame 1.2 s (D850) |
| slider response, 45 MP | lags 1–2 s with masks | one frame (< 16.7 ms) at fit, < 33 ms with 8 masks | 2.3 ms GPU per frame, 8 masks included |
| culling, next photo | waits for previews | < 50 ms, never a spinner | thumbnail at once, next three previews preloaded |
| export a 45 MP JPEG | — | faster than darktable-cli with OpenCL | 0.57 s; darktable-cli 2.52 s |
| demosaic | proprietary, AI Raw Details | RCD-class on Bayer, Markesteijn-class on X-Trans | RCD; GPU X-Trans, 2–4 dB over bilinear |
| highlights | strong | no magenta, smooth roll-off; opposed-channel inpaint | inpaint opposed, AgX roll-off |
| tone and color | profiles, Adaptive | scene-referred, AgX-style default render, DCP import | AgX default; DCP import |
| lens | profiles for most lenses | lensfun database and embedded metadata | lensfun, 1,568 lenses |
| AI denoise | 8.8 s on an RTX 5070 | local, unmetered, ≤ 10 s on an RTX 4070 SUPER | 3.8 s for 45 MP |
| AI masks | subject, sky, background, people | subject, sky and background, local, < 1 s | subject, sky, background, object; 43–93 ms |
| remove | Generative Remove needs the cloud | local content-aware remove | local, 130 ms per region |
| interop | XMP in and out | Lightroom XMP read and write, `.xmp` presets, DNG and 16-bit TIFF export | XMP in and out, `.xmp` presets in and out, DNG and 16-bit TIFF export |
| scale | slows at 100k+ | 10k-photo catalog: scroll at 60 fps, filter in < 50 ms | filters 12–19 ms; steady scroll at display rate |
| install | desktop installer, subscription | static site, installable PWA, works offline | PWA, offline, opens files from the desktop |

Measurements: [BENCHMARKS.md](BENCHMARKS.md).

Out of scope: print, book, map, tethering, generative fill, and Photoshop-style compositing beyond the Canvas surface.
