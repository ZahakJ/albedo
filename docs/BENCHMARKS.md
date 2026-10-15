# Benchmarks

One machine: AMD Ryzen 7 7800X3D (8 cores), 32 GB RAM, NVIDIA RTX 4070 SUPER, Linux 7.1. albedo runs in Chromium 151 with WebGPU on the NVIDIA adapter. darktable 5.6.2 and RawTherapee 5.13 are the official x86_64 AppImages; darktable runs with OpenCL on the same GPU, RawTherapee on the CPU.

Test files are CC0 samples from [raw.pixls.us](https://raw.pixls.us):

| file | camera | pixels |
|---|---|---|
| `a7iii.arw` | Sony ILCE-7M3, 14-bit compressed | 6024 × 4024 |
| `z6.nef` | Nikon Z 6, 14-bit lossless | 6064 × 4040 |
| `xt5.raf` | Fujifilm X-T5, X-Trans, compressed | 7752 × 5178 |
| `r5.cr3` | Canon EOS R5 | 8191 × 5463 |
| `d850.nef` | Nikon D850, 14-bit lossless | 8288 × 5520 |
| `a7r4.arw` | Sony ILCE-7RM4, 14-bit compressed | 9568 × 6376 |

The tools are described in [DEVELOPMENT.md](DEVELOPMENT.md#measuring).

## Export to full-resolution JPEG

Seconds, best of two, default settings in each program.

| file | albedo | darktable-cli | darktable pipeline | rawtherapee-cli |
|---|---|---|---|---|
| a7iii.arw | 0.29 | 1.93 | 0.30 | 3.83 |
| z6.nef | 0.23 | 1.52 | 0.27 | 3.64 |
| xt5.raf | 0.46 | 2.26 | 0.60 | 4.61 |
| r5.cr3 | 0.52 | 2.19 | 0.50 | 6.56 |
| d850.nef | 0.57 | 2.52 | 0.56 | 7.19 |
| a7r4.arw | 0.72 | 2.75 | 0.74 | 8.48 |

- **albedo**: from the export request to the encoded file, with the photo open.
- **darktable-cli** and **rawtherapee-cli**: the whole command, from start to written file.
- **darktable pipeline**: darktable's own "pixel pipeline processing" time for the same run.

## Opening and editing

| file | decode | open, first frame | develop pass per frame |
|---|---|---|---|
| a7iii.arw | 0.24 s | 0.22 s | 2.4 ms |
| z6.nef | 0.57 s | 0.19 s | 2.4 ms |
| xt5.raf | 1.73 s | 0.18 s | 2.3 ms |
| r5.cr3 | 0.54 s | 0.26 s | 2.4 ms |
| d850.nef | 1.01 s | 0.20 s | 2.3 ms |
| a7r4.arw | 0.47 s | 0.61 s | 2.4 ms |

- **decode**: LibRaw in WebAssembly, file bytes to raw frame.
- **open**: demosaic, lens lookup and the first developed frame, until the GPU has finished.
- **develop pass**: GPU time for one frame of the 1600 × 1000 view during a slider drag, the median of 60. A slider change therefore lands in the next display frame. With eight radial masks the median stays at 2.3 ms (D850).

## Local AI

| task | input | first run | then |
|---|---|---|---|
| Subject mask | 1024² | 1.67 s | 93 ms |
| Sky mask | 320² | 0.73 s | 43 ms |
| Object mask, click | 1024 long side | 0.87 s | 46 ms per click |
| Remove | 1024 × 684 region | 0.54 s | 130 ms |
| AI Denoise, 24 MP | a7iii.arw | 2.2 s | |
| AI Denoise, 45 MP | d850.nef | 3.8 s | |
| AI Denoise, 61 MP | a7r4.arw | 3.8 s | |

- **First run** includes loading the model.
- **AI Denoise** includes decoding the file again, loading the model and placing every tile.

## Memory

Peak anonymous memory of the whole browser (all processes) while opening and exporting the 61 MP file: 1.0 GB. AI Denoise of the 45 and 61 MP files, including the open: 1.55 GB.

## Demosaic quality

PSNR in dB against ground truth. The truth images are 1536 × 1024 crops of the six files above, rendered and downsampled 4× so that they carry no demosaic error of their own, then sampled through a Bayer or an X-Trans pattern. Higher is better.

| image | RCD (albedo) | Malvar-He-Cutler | bilinear | X-Trans (albedo) | X-Trans bilinear |
|---|---|---|---|---|---|
| a7iii | 29.25 | 29.39 | 25.56 | 27.44 | 24.10 |
| a7r4 | 38.67 | 38.50 | 36.07 | 36.80 | 33.77 |
| d850 | 32.63 | 32.60 | 30.84 | 31.57 | 29.50 |
| r5 | 41.89 | 40.92 | 38.74 | 39.19 | 35.28 |
| xt5 | 36.17 | 33.85 | 31.14 | 34.26 | 29.05 |
| z6 | 43.77 | 41.27 | 41.16 | 40.38 | 37.37 |
| mean | 37.06 | 36.09 | 33.92 | 34.94 | 31.51 |

## A 10,000-photo catalog

10,000 JPEGs imported through the normal path into one catalog.

| operation | time |
|---|---|
| import | 63 photos/s |
| all photos, by capture date | 95 ms |
| all photos, by name | 90 ms |
| rating ≥ 3 (2,000 photos) | 19 ms |
| picks (1,429 photos) | 14 ms |
| search (1,000 matches) | 12 ms |
| navigator sidebar | 16 ms |
| first grid after launch | 0.49 s |

Scrolling the grid at 120 px per frame holds the display rate (median 16.7 ms, 95th percentile 22.9 ms). Flinging a screen and more per frame drops to a median of 37.5 ms, with thumbnails deferred until the grid slows.
