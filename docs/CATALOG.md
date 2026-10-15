# Catalog and storage

Everything albedo keeps lives in the browser's Origin Private File System (OPFS) for the page's origin: the original files, derived images, edit documents, presets and a SQLite database. The catalog worker is the only code that reads or writes it (`src/workers/catalog.worker.js`, helpers in `src/io/opfs.js`). Writes use sync access handles, which exist only in dedicated workers.

## OPFS layout

```
/
├── originals/<photoId>.<ext>        imported files, byte-for-byte
├── thumbs/<photoId>.jpg             ≤512 px JPEG, quality 0.85
├── previews/<photoId>.jpg           ≤2048 px JPEG, built on first use by compare/survey/cull
├── edits/<photoId>/<versionId>.json edit documents, one file per version
├── masks/<photoId>/<maskId>.png     AI-mask weights (quarter resolution, grayscale) and
│                                    removal patches (rm_…: RGBA, rgb = sRGB of linear ÷ scale,
│                                    alpha = feathered hole)
├── profiles/<profileId>.dcp         imported DCP camera profiles, byte for byte
├── presets/<presetId>.json          user and imported presets
├── canvasdocs/<docId>/              Canvas documents: doc.json, one PNG per layer, thumb.png
└── albedo/.sahpool/                 SQLite's opfs-sahpool VFS files (catalog.db and journal)
```

IDs are a prefix plus 16 hex characters from `crypto.randomUUID()` (`ph_…` for photos, `imp_…` for imports).

Edit documents and presets are written atomically: the bytes go to `<name>.tmp`, then the handle is moved over the target. Where `FileSystemHandle.move` is missing, the fallback writes twice and leaves the temporary copy recoverable.

On startup the worker asks for persistent storage (`navigator.storage.persist()`), which keeps the browser from evicting the catalog under storage pressure.

## Sidecars are the source of truth

Edit documents and presets exist twice: as JSON files in OPFS and as rows in SQLite. The files are authoritative. The rows are a mirror for queries, and loading a document falls back to the row only when the file is missing. A rebuilt database can be repopulated from the files, and the backup archive carries only files.

## Schema

```sql
photos(
  id TEXT PRIMARY KEY, opfs_path TEXT, filename TEXT, ext TEXT, bytes INT,
  iso INT, shutter REAL, aperture REAL, focal REAL, camera TEXT, lens TEXT,
  taken_at INT, imported_at INT, width INT, height INT, is_raw INT,
  rating INT DEFAULT 0,          -- 0..5
  flag INT DEFAULT 0,            -- 1 pick, 0 none, -1 reject
  color_label TEXT,              -- red | yellow | green | blue | NULL
  folder_id TEXT, import_id TEXT,
  thumb_state INT DEFAULT 0,     -- 0 pending, 1 written, 2 needs main-thread decode
  proxy_state INT DEFAULT 0,
  title TEXT, caption TEXT,
  keywords TEXT                  -- JSON array of strings
)
folders(id TEXT PRIMARY KEY, name TEXT, parent_id TEXT)
albums(id TEXT PRIMARY KEY, name TEXT)
album_photos(album_id TEXT, photo_id TEXT, PRIMARY KEY(album_id, photo_id))
edits(photo_id TEXT, version_id TEXT, doc TEXT, updated_at INT, PRIMARY KEY(photo_id, version_id))
presets(id TEXT PRIMARY KEY, name TEXT, modules TEXT, updated_at INT,
        grp TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'user', created_at INT)
imports(id TEXT PRIMARY KEY, at INT, source TEXT, count INT)
smart_collections(id TEXT PRIMARY KEY, name TEXT, filter TEXT, created_at INT)

INDEX idx_photos_taken_at ON photos(taken_at)
INDEX idx_photos_folder_rating_flag ON photos(folder_id, rating, flag)
```

Times are milliseconds since the epoch. `taken_at` comes from EXIF; where it is missing, sorting and the date tree use `imported_at` instead (`COALESCE(taken_at, imported_at)`), so every photo has exactly one place in time.

### Migrations

The schema is created with `CREATE TABLE IF NOT EXISTS`. The `title`, `caption` and `keywords` columns are added in place when absent. Later changes are numbered migrations in the `MIGRATIONS` array, tracked in `PRAGMA user_version`, each run once inside a transaction:

1. `presets` gains `grp` (rail group), `source` (`user`, `import` or `xmp`) and `created_at`.
2. Indexes matching the Library's sorts: `COALESCE(taken_at, imported_at)`, `filename COLLATE NOCASE` and `imported_at`, each with `imported_at, id` as tie-breakers, so sorting 10,000 photos walks an index.

## Queries

`CAT_QUERY` takes a filter and a sort and returns the rows the Library uses, read as arrays.

- `folderId`, `minRating`, `flag`: equality or lower bound.
- `search`: case-insensitive `LIKE` over filename, camera, lens, title, caption and the keywords JSON.
- `keyword`: exact keyword, matched as the quoted JSON token.
- `source`: `all`, `recent` (the latest import), `album`, or `date` with year and optional month in local time.
- Sort by capture time, import time, name (`NOCASE`) or rating, ascending or descending, with `imported_at` and `id` as tie-breakers in the same direction.

Import writes four files at a time and inserts each group's rows in one transaction. Import times strictly increase in file order, so photos dropped together keep their order.

A smart collection stores the same filter object as JSON. `CAT_SIDEBAR` returns everything the library sidebar shows in one reply: totals, the reject count, the last import, the year/month tree, albums with counts, smart collections and the keyword list.

## The edit document

An edit is a JSON document, typically a few kilobytes, defined in `src/engine/editdoc.js`:

```json
{
  "schema": 1,
  "photoId": "ph_…",
  "versionId": "v_default",
  "modules": {
    "exposure": { "ev": 0.45, "black": 0 },
    "tone": { "contrast": 22, "highlights": -35, "shadows": 30, "whites": 12, "blacks": -14 },
    "curve": { "points": [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]] }
  },
  "masks": [],
  "snapshots": [{ "name": "Before grading", "at": 1760000000000, "modules": {}, "masks": [] }]
}
```

A module is present only when it differs from its defaults; `setParam` deletes a module as soon as it returns to all-default values, so "has edits" is a structural question. The render worker treats an absent module as its defaults, and most stages skip themselves when their module is neutral.

| module | fields (defaults) |
|---|---|
| `wb` | `temp 0, tint 0` (−100…100, relative to as-shot) |
| `exposure` | `ev 0` (stops), `black 0` |
| `tone` | `contrast, highlights, shadows, whites, blacks` (all 0, −100…100) |
| `curve` | `points [[0,0],[1,1]]`, display-referred, 0…1 |
| `colormix` | per band `red orange yellow green aqua blue purple magenta`: `{ h, s, l }` |
| `vibsat` | `vibrance 0, saturation 0` |
| `localcontrast` | `clarity 0, texture 0, dehaze 0` |
| `vignette` | `amount 0, midpoint 50, roundness 0, feather 50` |
| `grading` | `shadows/midtones/highlights { h, s }`, `blending 50, balance 0` |
| `bw` | `on 0`, `mix` per band |
| `grain` | `amount 0, size 25, roughness 50` |
| `geometry` | `crop { x 0, y 0, w 1, h 1 }`, `angle 0`, `flipH 0`, `persp { v 0, h 0 }` |
| `detail` | `sharpenAmount 40, sharpenRadius 1.0, sharpenMasking 0, lumaNR 0, chromaNR 25, aiDenoise 0` |
| `heal` | `spots []`: `{ mode, dx, dy, sx, sy, r, feather }` |
| `remove` | `patches []`: `{ id, x, y, w, h, scale }`, pixels in `masks/<photoId>/<id>.png` |
| `lens` | `distortion 0, caRed 0, caBlue 0, defringe 0, profile 1, profDistortion 100, profVignette 100` |
| `look` | `profile 'agx'` (`'agx'`, `'linear'` or `'dcp:<profileId>'`), `baseline 0.5`, `saturation 110`; RAW only by default |
| `recon` | `on 1` (highlight reconstruction) |

Coordinates (crop, masks, heal spots, removal patches) are source-normalised with y pointing down. Crop and masks are expressed before mirroring; heal spots and patches are in final source space, after keystone and lens distortion, so each stays attached to image content when other geometry changes.

AI masks carry their kind in `model` (`subject`, `sky`, `background` or `object`; an object mask keeps its `points` or `box`); their weights live in OPFS, not in the doc.

`masks` is a list of `{ id, name, kind, enabled, invert, geom, adjust, range? }`; see [PIPELINE.md](PIPELINE.md#masks). `adjust` holds `ev, temp, contrast, highlights, shadows, saturation, clarity`.

### History, snapshots, versions

- **Undo history** is in memory only: one entry per committed gesture, labelled by `src/engine/docDiff.js` (for example "Exposure +0.45", "Mask: Sky moved", "3 modules").
- **Snapshots** are named copies of `modules` and `masks` stored inside the document. Saving and restoring one are ordinary commits, so both are undoable.
- **Versions** are separate documents for the same photo, keyed by `versionId`, each a self-contained file under `edits/<photoId>/` with its name in `versionName`. `v_default` always exists. Switching versions swaps parameters only; the decoded source stays on the GPU.

### Copy, paste and presets

Copy settings (`⌘C`) picks a subset of modules; paste (`⌘V`) and presets both merge a module subset into each target document, replacing exactly the modules they carry and leaving the rest. See [PRESETS.md](PRESETS.md).

## Deleting photos

`CAT_DELETE_PHOTOS` deletes the `photos`, `album_photos` and `edits` rows in one transaction, then removes the original, thumbnail, preview, edit directory and mask directory. File removal is best-effort; a file whose row is gone is never shown.

## Backup and restore

**Back up catalog** writes an uncompressed (STORE) zip:

```
edits/<photoId>/<versionId>.json   every edit document
presets/<presetId>.json            every user and imported preset
smarts.json                        [{ id, name, filter }]
manifest.json                      { app: "albedo", kind: "catalog-backup", version: 1, at,
                                     photos: [{ id, filename }], counts: { sidecars, presets, smarts } }
```

Originals are not included. **Restore** writes each document back to the photo with the same ID; for a catalog whose photos were imported again (and so have new IDs), the manifest's filename list maps old IDs to current photos by filename. Presets and smart collections are restored as they were.
