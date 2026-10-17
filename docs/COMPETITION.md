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

## Photoshop and the layered editors

### What retouchers and compositors do every day

- **Portrait retouching.** Pros dodge and burn on pairs of Curves layers with black masks. They paint at 1–10% flow with a pen, sometimes with a Luminosity-mode layer to keep colour steady. They heal and clone onto empty layers with "Current & Below" sampling, and grade last ([Dunbar](https://dennisdunbar.substack.com/p/retouching-secrets-of-the-pros-portrait), [CreativeLive](http://www.creativelive.com/blog/dodging-burning-images-photo-editing)).
- **Frequency separation.** Retouchers call it "the most abused" technique, yet it stays a standard step: a blurred Low layer and a High layer in Linear Light ([Fstoppers](https://fstoppers.com/photoshop/common-frequency-separation-mistakes-which-will-ruin-your-retouching-results-30913)).
- **Compositing.**
  - A Curves layer clipped to the subject, matched to the background with eyedroppers sampling all layers ([PiXimperfect via Kelby](https://scottkelby.com/guest-blog-photoshop-and-lightroom-instructor-unmesh-dinda-of-piximperfect/)).
  - Select Subject and hair refinement, then masks.
- **Landscape.**
  - Exposure blending and luminosity masks.
  - Blend If, preferred because it stays live as the layers below change and keeps files small. Pixel luminosity masks go stale after edits and bloat the file ([Stephen Bay](https://stephenbayphotography.com/blog/blend-if-vs-luminosity-masks/), [Greg Benz](https://gregbenzphotography.com/exposure-blending-luminosity-masks)).

### What they hate about Photoshop

- **Price and credits.**
  - Creative Cloud Pro has cost $69.99 a month since June 2025 ([The Register](https://www.theregister.com/2025/05/20/adobe_price_hikes/)).
  - Generative Fill costs 1 to 40 credits a generation, depending on the model ([Glyn Dewis](https://glyndewis.com/blog/adobe-credit-crunch)).
  - The Photography plan's 250 credits do not roll over ([thread](https://community.adobe.com/t5/photoshop-ecosystem-discussions/p-you-don-t-have-enough-credits/m-p/15382048)). One user lost all 250 to a single partner-model generation that an in-app tutorial offered, with no cost warning ([thread](https://community.adobe.com/questions-712/has-anyone-else-have-their-generative-credits-stolen-1633378)).
- **Generative Fill output.**
  - It was capped at 1024 × 1024 per generation in 2025 ([Adobe](https://community.adobe.com/t5/photoshop-ecosystem-discussions/what-is-the-max-resolution-for-generative-fill-in-photoshop-in-2025/m-p/15417958)).
  - The 2026 Fill & Expand model reaches 2048², but large selections are still stretched and soft ([PhotoshopCAFE](https://photoshopcafe.com/photoshop-firefly-fill-and-expand-model-new-features-and-comparision/)).
  - The "violates user guidelines" false-positive thread runs to about 1,400 replies ([thread](https://community.adobe.com/t5/photoshop-beta-bugs/p-generated-images-violate-user-guidelines/idi-p/13811808/page/40)).
- **Stability.**
  - "Photoshop 2026 is the worst version so far": crashes, wiped actions, near-daily crashes on an RTX 5090 machine, and users rolling back to 2025 ([thread](https://community.adobe.com/questions-712/photoshop-2026-is-the-worst-version-so-far-1561263)).
  - Large layered documents slow down over a session ([thread](https://community.adobe.com/questions-712/question-for-the-photoshop-community-handling-large-psd-files-1182514)).
- **File size.** An 11-layer 3000 × 1000 PSD saved at about 1 GB ([thread](https://community.adobe.com/questions-712/psd-size-1095917)).
- **Arabic and other right-to-left type.**
  - It needs the Middle Eastern composer switched on and a restart ([noqta](https://noqta.tn/en/blog/ecrire-arabe-photoshop-illustrator)).
  - In February 2026 a user reported Arabic coming out reversed and unreadable ([thread](https://community.adobe.com/questions-712/i-have-a-problem-with-unified-text-engine-1551690)).

### The other layered editors

- **GIMP 3.2** ([notes](https://gimp.org/release-notes/gimp-3.2.html), [3.2](http://www.gimp.org/news/2026/03/14/gimp-3-2-released/)).
  - Has: non-destructive filters attached to a layer, link layers and vector layers.
  - Lacks: adjustment layers and a layer-effects system; crops and transforms are destructive.
  - Raw goes out to plug-ins, and its UX is a standing complaint ([forum](https://discuss.pixls.us/t/gimp-is-falling-behind-where-is-the-ux/48708)).
  - **PhotoGIMP** remaps it to Photoshop's keys. Its 3.0 configuration does not load in GIMP 3.2 ([#200](https://github.com/Diolinux/PhotoGIMP/issues/200)).
- **Krita 5.3 / 6.0** ([Linuxiac](https://linuxiac.com/krita-5-3-and-6-0-released-with-new-text-engine-and-wayland-hdr-support/)).
  - Has: a new text engine, 16/32-bit float and faster Liquify.
  - Lacks: a healing brush. PSD exchange has limits, and AI needs a ComfyUI plug-in with 6 GB of VRAM ([krita-ai-diffusion](https://github.com/Acly/krita-ai-diffusion)).
- **Photopea** ([5.6](https://blog.photopea.com/photopea-5-6-advanced-color-depth.html)).
  - Has: strong PSD fidelity in a browser, and 16/32-bit since 2024.
  - Drawbacks: it is closed source and runs on ads. Large files hit browser memory limits ("Need 3043MB", [guide](https://www.superchargebrowser.com/library/fix-photopea-not-enough-ram-chrome/)).
- **Affinity** (free since October 2025, [80.lv](https://80.lv/articles/affinity-returns-as-free-all-in-one-design-suite)).
  - Requires: a Canva account.
  - Paywalled: Generative Fill, Select Subject and Super Resolution need Canva Premium ([TutKit](https://www.tutkit.com/en/comparison/image-editing/affinity)).
  - PSD: smart objects are rasterised on import by default ([help](https://affinity.help/photo2/en-US.lproj/pages/GetStarted/importAdobe.html)).
- **Pixelmator Pro** is Apple-only, and since January 2026 part of Apple's Creator Studio subscription ([Wikipedia](https://en.wikipedia.org/wiki/Pixelmator_Pro)).
- **Graphite** is vector-first, with node compositing. Its raster tools are "still experimental" and it does not import PSD ([LWN](https://lwn.net/Articles/1051242)).

## Open-source Adobe clones of 2025–2026

Facts as of 16 October 2026, from the projects' pages, issue trackers and Hacker News. The issues quoted are the projects' own, most-commented first.

| project | kind, stack | licence | where it stands | most-reported problems |
|---|---|---|---|---|
| [RapidRAW](https://github.com/CyberTimon/RapidRAW) | Lightroom-like; Rust, wgpu, Tauri | AGPL-3.0 | v1.6.5, 10.5k stars | memory: "16GB or more is highly recommended" (README); 45 browsed files used 5.5–12 GB and 22 Fuji files 15 GB ([#521](https://github.com/CyberTimon/RapidRAW/issues/521)); launch failures after updates ([#1490](https://github.com/CyberTimon/RapidRAW/issues/1490)); edits kept in its own `.rrdata`, not XMP ([#597](https://github.com/CyberTimon/RapidRAW/issues/597)); TIFF exports without EXIF ([#1750](https://github.com/CyberTimon/RapidRAW/issues/1750)) |
| [LightCraft](https://github.com/storytold/lightcraft) | Lightroom-like; Rust | Apache-2.0 (README: MIT or Apache) | v0.5, 13.2k stars | colour against Lightroom: median ΔL* +3.2 over 1,917 files ([#523](https://github.com/storytold/lightcraft/issues/523)); formats that open as the embedded preview ([#556](https://github.com/storytold/lightcraft/issues/556)); a 38.5k-photo catalog import that stalls ([#832](https://github.com/storytold/lightcraft/issues/832)) |
| [PhotoCraft](https://github.com/storytold/photocraft) | Photoshop-like; Rust, wgpu | Apache-2.0 | 0.8.2, 64.9k stars, 2,462 open issues | PSB/PSD round trips that Photoshop then refuses ([#2717](https://github.com/storytold/photocraft/issues/2717)); 50–70 ms cursor lag ([#1343](https://github.com/storytold/photocraft/issues/1343)); no tablet pressure ([#759](https://github.com/storytold/photocraft/issues/759)); clone stamp and layer-effect toggles that do nothing ([#1658](https://github.com/storytold/photocraft/issues/1658), [#2083](https://github.com/storytold/photocraft/issues/2083)); GPU device-lost launches ([#1461](https://github.com/storytold/photocraft/issues/1461)) |
| [Rembrandt](https://github.com/thesnarkitecht/rembrandt) | Lightroom-like; JS WebGPU, LibRaw, Tauri | GPL-3.0 | 146 stars | unsigned builds; questions about longevity ([HN](https://news.ycombinator.com/item?id=50012199)) |
| [redlamp](https://github.com/pdcgomes/redlamp) | Lightroom-like; Swift, Metal | MPL-2.0 | pre-alpha | no Library yet; macOS only |
| [Patchy](https://github.com/SethRobinson/Patchy) | Photoshop-like, in the browser | MIT | 599 stars | handled adjustment layers and smart objects in a third-party PSD test |
| [Graphite](https://github.com/GraphiteEditor/Graphite) | node-based 2D; Rust, WASM | Apache-2.0 | no numbered releases | idle CPU use ([#3686](https://github.com/GraphiteEditor/Graphite/issues/3686)); Vulkan and out-of-memory panics ([#3546](https://github.com/GraphiteEditor/Graphite/issues/3546), [#3611](https://github.com/GraphiteEditor/Graphite/issues/3611)) |

Commentary on the wave: "Attack of the Vibe Coded Photoshop Clones" ([HN](https://news.ycombinator.com/item?id=50052156)) and [andreklein.net's PSD tests](https://news.ycombinator.com/item?id=49983780).

## Their problems, our answers

Each row is a complaint that recurs across the projects above, and what albedo has to show for it. A row counts only when a test or a measurement backs it; where albedo has no proof yet, the row says so.

| complaint | albedo | proof |
|---|---|---|
| memory grows until the app dies (RapidRAW #521: 15 GB for 22 files) | thumbnails and previews are files in OPFS, not memory; only the open photo is decoded | [scale.mjs](../test/scale.mjs): a 10,000-photo catalog, grid scrolled end to end twice, whole browser peaks at 1.5 GB ([BENCHMARKS](BENCHMARKS.md#memory)) |
| one heavy document exhausts memory (PhotoCraft #1015, #3360) | Compose draws at screen resolution; layers are GPU textures sized to their content; history is capped by a VRAM budget | [compose-bench.mjs](../test/compose-bench.mjs): 50 layers on a 24 MP RAW hold 3.2 GB of VRAM, history included; the browser's resident memory, summed over its processes, is 3.3 GB ([BENCHMARKS](BENCHMARKS.md#compose)) |
| slow previews and imports (RapidRAW #456, #620; LightCraft #832) | GPU pipeline; LibRaw in WebAssembly | open a 45 MP RAW in 1.2 s; import 63 photos/s ([BENCHMARKS](BENCHMARKS.md)) |
| input lag (PhotoCraft #1343 cursor lag, #2138 straight brush segments) | slider changes coalesce to one frame; brushes take every coalesced pointer event and pressure | Develop: 2.4 ms a frame; Compose, 50 layers on 24 MP: a brush stroke 6.7 ms a frame, a Develop adjustment slider 4.6 ms ([BENCHMARKS](BENCHMARKS.md#compose)) |
| no tablet pressure (PhotoCraft #759) | pointer events: pressure drives size, opacity or flow | brush options; `compose.e2e.mjs` strokes |
| colour unlike Lightroom (LightCraft #523) | Adobe's own DCP profiles import and apply as in the DNG SDK | DCP tests (`test/unit/dcp.test.mjs`); no Lightroom on the reference machine, so no ΔE table yet |
| "supported" formats that open as the embedded JPEG (LightCraft #556, #769) | every RAW is decoded by LibRaw at full sensor resolution | `raw.e2e.mjs`, `rawthumb.e2e.mjs` |
| XMP that doesn't travel (RapidRAW #597) | Lightroom XMP read and write, `.xmp` presets in and out | `test/unit/xmp*.test.mjs` |
| PSD files that break on the way back (PhotoCraft #2717, #3360, #4758) | PSD written to the specification, 8/16/32-bit, with a merged image | `compose.e2e.mjs`: albedo → PSD → albedo keeps names, groups, modes, opacity, masks, depth and pixels; Photoshop itself is not on the reference machine |
| lost work on a crash (RapidRAW #362, #1229) | every write is atomic; Develop saves 500 ms after an edit, Compose 2.5 s | `durability.e2e.mjs`: crash the tab after edits in Develop and Compose, reopen, nothing lost |
| exports without metadata (RapidRAW #1750) | EXIF copied into JPEG, written into TIFF and DNG | `meta.e2e.mjs`, `export.e2e.mjs` |
| GPU or driver failure means a blank window (PhotoCraft #1461; Graphite #3546) | WebGPU, else WebGL2, for Library and Develop | `parity.e2e.mjs` renders both backends; Compose needs WebGPU and says so instead of failing silently |
| features in the UI that do nothing (PhotoCraft #1658, #2083) | every Compose tool is exercised by an end-to-end test; what isn't built is listed in [RESOURCE-LIMITS](RESOURCE-LIMITS.md), not shown | `compose.e2e.mjs` (45 checks, on a real GPU) |
| install friction, unsigned binaries (RapidRAW, Rembrandt) | a web page: nothing to install, an installable PWA that works offline | [the app](https://zahakj.github.io/albedo/app/) |
| unclear licence or provenance (LightCraft #1339, PhotoCraft #341) | AGPL-3.0 in the repository, the README and package.json; bundled code and models listed with their licences | [README](../README.md#license), [MODELS](MODELS.md) |

## What nobody does well

1. **Speed that holds.** Lightroom and Capture One slow down as the catalog and session grow. RawTherapee re-renders in seconds, and darktable's OpenCL speed depends on tuning.
2. **Many masks without lag.** Adobe acknowledges the problem.
3. **Local AI that just works.** It is cloud or metered at Adobe. darktable gates it behind a build flag, ART and Krita need external tools, and RapidRAW asks for 16 GB.
4. **Portable edits.** Capture One edits stay trapped, and darktable reads only 10 Lightroom steps.
5. **A good first render.** darktable starts flat, and Lightroom's adaptive profiles hide their decisions.
6. **Zero install.** No open developer runs in a browser with a real raw pipeline. Photopea is closed and runs on ads.
7. **RAW inside the composite.** Photoshop keeps a RAW smart object, but editing it opens Camera Raw in a dialog; GIMP and Krita hand RAW to other programs. Nobody lets the same developer drive both.
8. **Type for everyone's script.** Photoshop needs a composer switch for Arabic; Affinity doesn't document right-to-left; Canvas-based web editors can't control OpenType features.
9. **Local fill without credits or a content filter.** Adobe meters it, Affinity puts it behind Canva Premium, Krita needs ComfyUI.

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

## Compose targets

Judged against Photoshop 27 on the same tasks. Measured in [BENCHMARKS.md](BENCHMARKS.md#compose).

| category | Photoshop | target | measured |
|---|---|---|---|
| a 50-layer 24 MP document | slows as layers and smart objects pile up | display rate (< 16.7 ms GPU a frame) at fit and at 100%, still and panning | pans and zooms present the cached composite; a full redraw is 6.7 ms at fit, 17.9 ms at 100% with the panning margin (2.25 × the screen); panning at 100% has a 95th percentile of 7.0 ms |
| painting in the middle of the stack | | < 8 ms a frame | 6.7 ms median, 9.3 ms 95th percentile at fit; 6.4 ms at 100% |
| a Develop adjustment slider | Camera Raw filter re-renders on OK | < 16.7 ms a frame | 4.6 ms |
| RAW into a layered document | Open as Smart Object, Camera Raw in a dialog | from Develop with no decode, Develop's own panels to edit it again | 21 ms from the key press, no decode; round trip tested |
| memory | 1 GB PSDs, slowdowns | the 50-layer document under 4 GB of VRAM | 3.2 GB, history included |
| blend modes | 27 | the same 27, matching the formulas | 26 of 26 tested within 2/255, plus Dissolve |
| PSD | native | 8/16/32-bit layers, groups, masks, modes, clipping and Blend If both ways | round trip tested |
| right-to-left type | composer switch and restart | correct by default | HarfBuzz: Arabic joining, lam-alef, bidi, fallback (unit tests) |
| fill | metered, cloud, content filter | local, unmetered | MI-GAN, 0.1–0.3 s; prompted generation: see [RESOURCE-LIMITS](RESOURCE-LIMITS.md) |

Out of scope: print, book, map, tethering, prompted generative fill (see [RESOURCE-LIMITS](RESOURCE-LIMITS.md)), CMYK and vector illustration.
