import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { MSG } from './protocol.js'
import { writeFile, writeFileAtomic, readFile, readFileBlob, getDir, deleteFile, deleteDir } from '../io/opfs.js'
import { parseExif, biggestPreview } from '../io/exif.js'
import { zipWrite, zipRead } from '../io/zip.js'

// The catalog worker owns sqlite (opfs-sahpool VFS — works without COOP/COEP)
// and all OPFS file traffic: originals/, thumbs/, edits/. sahpool takes
// exclusive sync-access handles on its pool files, so exactly one connection
// may exist per origin — a Web Lock turns the second tab's corruption into a
// clean error instead.

const RAW_EXTS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf',
  'rw2', 'pef', 'srw', 'raw', 'erf', 'kdc', '3fr', 'mrw', 'iiq', 'rwl', 'x3f',
])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos(
  id TEXT PRIMARY KEY, opfs_path TEXT, filename TEXT, ext TEXT, bytes INT,
  iso INT, shutter REAL, aperture REAL, focal REAL, camera TEXT, lens TEXT,
  taken_at INT, imported_at INT, width INT, height INT, is_raw INT,
  rating INT DEFAULT 0, flag INT DEFAULT 0, color_label TEXT,
  folder_id TEXT, import_id TEXT,
  thumb_state INT DEFAULT 0, proxy_state INT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT, parent_id TEXT);
CREATE TABLE IF NOT EXISTS albums(id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS album_photos(album_id TEXT, photo_id TEXT, PRIMARY KEY(album_id, photo_id));
CREATE TABLE IF NOT EXISTS edits(photo_id TEXT, version_id TEXT, doc TEXT, updated_at INT, PRIMARY KEY(photo_id, version_id));
CREATE TABLE IF NOT EXISTS presets(id TEXT PRIMARY KEY, name TEXT, modules TEXT, updated_at INT);
CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, at INT, source TEXT, count INT);
CREATE TABLE IF NOT EXISTS smart_collections(id TEXT PRIMARY KEY, name TEXT, filter TEXT, created_at INT);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_folder_rating_flag ON photos(folder_id, rating, flag);
`

let db = null
let initPromise = null

// Numbered migrations, tracked in PRAGMA user_version. Each runs once, in
// order, inside a transaction; a catalog from before this list is version 0.
// (The photos text columns above predate it and stay pragma-guarded.)
const MIGRATIONS = [
  // 1: presets grow a group (rail folder), a source (user | import | xmp) and
  //    a created_at; existing rows become ungrouped user presets.
  (db) => {
    const have = new Set(db.selectObjects('PRAGMA table_info(presets)').map((c) => c.name))
    if (!have.has('grp')) db.exec("ALTER TABLE presets ADD COLUMN grp TEXT NOT NULL DEFAULT ''")
    if (!have.has('source')) db.exec("ALTER TABLE presets ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
    if (!have.has('created_at')) db.exec('ALTER TABLE presets ADD COLUMN created_at INT')
    db.exec('UPDATE presets SET created_at = updated_at WHERE created_at IS NULL')
  },
  // 2: indexes that match the Library's sorts exactly, so a 10k-photo grid
  //    query walks an index instead of sorting
  (db) => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_photos_when ON photos(COALESCE(taken_at, imported_at), imported_at, id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_photos_name ON photos(filename COLLATE NOCASE, imported_at, id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_photos_imported ON photos(imported_at, id)')
  },
]

function migrate() {
  const at = db.selectValue('PRAGMA user_version') ?? 0
  for (let v = at; v < MIGRATIONS.length; v++) {
    db.transaction((t) => {
      MIGRATIONS[v](t)
      t.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

// presets: sidecar JSON in OPFS is the source of truth (survives a rebuilt
// DB, rides in the backup zip); the table mirrors it.
const presetRow = (p) => ({
  id: p.id, name: p.name, group: p.group ?? '', source: p.source ?? 'user',
  createdAt: p.createdAt ?? null, modules: p.modules,
})
function mirrorPreset(p, now = Date.now()) {
  db.exec({
    sql: 'INSERT OR REPLACE INTO presets(id, name, modules, updated_at, grp, source, created_at) VALUES(?,?,?,?,?,?,?)',
    bind: [p.id, p.name, JSON.stringify(p.modules), now, p.group ?? '', p.source ?? 'user', p.createdAt ?? now],
  })
}

const post = (msg, transfer) => self.postMessage(msg, transfer ?? [])
const uid = (prefix) => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 16)

// Hold the lock for the worker's lifetime (released on tab close). ifAvailable
// so a second tab fails fast instead of deadlocking on a lock that never frees.
const acquireLock = () => new Promise((resolve) => {
  if (!navigator.locks) return resolve(true)
  navigator.locks.request('albedo-catalog', { ifAvailable: true }, (lock) => {
    resolve(!!lock)
    if (lock) return new Promise(() => {})
  }).catch(() => resolve(false))
})

async function init() {
  if (db) return
  if (!(await acquireLock())) throw new Error('catalog is open in another tab')
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} })
  // pool dir is VFS-private; capacity ≥ 2×(db+journal) with headroom
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'albedo-sahpool', directory: '/albedo/.sahpool', initialCapacity: 6,
  })
  db = new pool.OpfsSAHPoolDb('/catalog.db')
  db.exec(SCHEMA)
  // additive text-metadata columns — pragma-guarded so existing catalogs
  // migrate in place (ALTER TABLE ADD COLUMN is instant in sqlite)
  const cols = new Set(db.selectObjects('PRAGMA table_info(photos)').map((c) => c.name))
  if (!cols.has('title')) db.exec('ALTER TABLE photos ADD COLUMN title TEXT')
  if (!cols.has('caption')) db.exec('ALTER TABLE photos ADD COLUMN caption TEXT')
  if (!cols.has('keywords')) db.exec('ALTER TABLE photos ADD COLUMN keywords TEXT') // JSON array
  migrate()
  // best-effort: persist() is Window-only in some engines; store also asks
  try { await navigator.storage.persist?.() } catch { /* non-fatal */ }
}

// ── import ──────────────────────────────────────────────────────────────────

// ≤512px JPEG from any decodable bytes; null when undecodable.
async function encodeThumb(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' })
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
  const dims = { width: bmp.width, height: bmp.height }
  bmp.close()
  return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }), dims }
}

// ≤2048px JPEG from any decodable bytes — the compare/survey/cull preview.
async function encodePreview(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' })
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
}

// import times strictly increase in file order, even for files imported in
// the same millisecond: the grid's order within an import is the drop order
let lastImportAt = 0
const nextImportAt = () => (lastImportAt = Math.max(Date.now(), lastImportAt + 1))

async function importOne(name, buffer, importId) {
  const importedAt = nextImportAt()
  const ext = (name.includes('.') ? name.split('.').pop() : 'bin').toLowerCase()
  const id = uid('ph_')
  const opfsPath = `originals/${id}.${ext}`
  await writeFile(opfsPath, buffer)

  const exif = parseExif(buffer)
  const isRaw = RAW_EXTS.has(ext) ? 1 : 0

  // RAW: cheapest preview is the biggest embedded JPEG stream, re-encoded
  // small. Non-RAW: the file itself is the thumb source.
  let src = null
  if (isRaw) {
    const p = biggestPreview(exif)
    if (p) src = buffer.slice(p.offset, p.offset + p.length)
  } else {
    src = buffer
  }

  let thumbState = 2
  let width = exif.width ?? null
  let height = exif.height ?? null
  if (src) {
    try {
      const { blob, dims } = await encodeThumb(src)
      await writeFile(`thumbs/${id}.jpg`, new Uint8Array(await blob.arrayBuffer()))
      thumbState = 1
      if (!isRaw) { width ??= dims.width; height ??= dims.height } // preview dims ≠ sensor dims
    } catch { thumbState = 2 }
  }

  // the row is inserted by the caller, a batch per transaction
  const row = [
    id, opfsPath, name, ext, buffer.byteLength,
    exif.iso ?? null, exif.shutter ?? null, exif.aperture ?? null, exif.focal ?? null,
    [exif.make, exif.model].filter(Boolean).join(' ') || null, exif.lens ?? null,
    exif.takenAt ?? null, importedAt, width, height, isRaw, importId, thumbState,
  ]
  return { id, thumbReady: thumbState === 1, row }
}

const INSERT_PHOTO = `INSERT INTO photos(id, opfs_path, filename, ext, bytes, iso, shutter,
  aperture, focal, camera, lens, taken_at, imported_at, width, height,
  is_raw, import_id, thumb_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

// ── query ───────────────────────────────────────────────────────────────────

// capture-date sorts and the date tree both treat imported_at as the capture
// time when EXIF had none — one photo, one place in time, always
const WHEN = 'COALESCE(taken_at, imported_at)'
const PHOTO_COLS = `id, filename, ext, bytes, is_raw, width, height, rating, flag, color_label,
  taken_at, imported_at, camera, lens, iso, shutter, aperture, focal, folder_id, import_id,
  thumb_state, proxy_state, title, caption, keywords`
const SORT_COLS = { takenAt: WHEN, importedAt: 'imported_at', name: 'filename COLLATE NOCASE', rating: 'rating' }

const likeEscape = (s) => s.replace(/[\\%_]/g, '\\$&')

function queryPhotos(filter = {}, sort) {
  const where = []
  const bind = []
  if (filter.folderId != null) { where.push('folder_id = ?'); bind.push(filter.folderId) }
  if (filter.minRating != null) { where.push('rating >= ?'); bind.push(filter.minRating) }
  if (filter.flag != null) { where.push('flag = ?'); bind.push(filter.flag) }
  if (filter.search) {
    where.push(`(filename LIKE ? ESCAPE '\\' OR camera LIKE ? ESCAPE '\\' OR lens LIKE ? ESCAPE '\\'
      OR title LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')`)
    const q = `%${likeEscape(String(filter.search))}%`
    bind.push(q, q, q, q, q, q)
  }
  if (filter.keyword) {
    // keywords is a JSON array — matching the quoted token is an exact-keyword hit
    where.push(`keywords LIKE ? ESCAPE '\\'`)
    bind.push(`%${likeEscape(JSON.stringify(String(filter.keyword)))}%`)
  }
  const src = filter.source
  if (src?.kind === 'recent') {
    where.push('import_id = (SELECT id FROM imports ORDER BY at DESC LIMIT 1)')
  } else if (src?.kind === 'album' && src.albumId != null) {
    where.push('id IN (SELECT photo_id FROM album_photos WHERE album_id = ?)')
    bind.push(src.albumId)
  } else if (src?.kind === 'date' && src.y != null) {
    where.push(`CAST(strftime('%Y', ${WHEN}/1000, 'unixepoch', 'localtime') AS INT) = ?`)
    bind.push(src.y)
    if (src.m != null) {
      where.push(`CAST(strftime('%m', ${WHEN}/1000, 'unixepoch', 'localtime') AS INT) = ?`)
      bind.push(src.m)
    }
  }
  const by = SORT_COLS[typeof sort === 'string' ? sort : sort?.by] ?? WHEN
  const dir = (typeof sort === 'object' && sort?.dir === 'asc') ? 'ASC' : 'DESC'
  // tie-breakers follow the sort direction, so one index serves both ways;
  // arrays, not objects: at 10k rows the per-row object churn dominates
  const rows = db.selectArrays(
    `SELECT ${PHOTO_COLS} FROM photos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${by} ${dir}, imported_at ${dir}, id ${dir}`, bind)
  return rows.map((r) => ({
    id: r[0], name: r[1], ext: r[2], bytes: r[3], isRaw: !!r[4],
    width: r[5], height: r[6], rating: r[7], flag: r[8],
    colorLabel: r[9], takenAt: r[10], importedAt: r[11],
    camera: r[12], lens: r[13], iso: r[14], shutter: r[15],
    aperture: r[16], focal: r[17], folderId: r[18],
    importId: r[19], thumbState: r[20], proxyState: r[21],
    title: r[22] ?? null, caption: r[23] ?? null, keywords: parseKeywords(r[24]),
  }))
}

function parseKeywords(json) {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

// ── navigator sidebar: one message, everything the left panel shows ─────────

function sidebar() {
  const total = db.selectValue('SELECT COUNT(*) FROM photos')
  const rejected = db.selectValue('SELECT COUNT(*) FROM photos WHERE flag = -1')
  const imp = db.selectObjects('SELECT id, at, count FROM imports ORDER BY at DESC LIMIT 1')[0]
  const dates = db.selectObjects(
    `SELECT CAST(strftime('%Y', ${WHEN}/1000, 'unixepoch', 'localtime') AS INT) AS y,
            CAST(strftime('%m', ${WHEN}/1000, 'unixepoch', 'localtime') AS INT) AS m,
            COUNT(*) AS count
     FROM photos GROUP BY y, m ORDER BY y DESC, m DESC`)
  const albums = db.selectObjects(
    `SELECT a.id, a.name, COUNT(ap.photo_id) AS count
     FROM albums a LEFT JOIN album_photos ap ON ap.album_id = a.id
     GROUP BY a.id ORDER BY a.name COLLATE NOCASE`)
  const smarts = db.selectObjects(
    'SELECT id, name, filter FROM smart_collections ORDER BY name COLLATE NOCASE')
    .map((r) => {
      try { return { id: r.id, name: r.name, filter: JSON.parse(r.filter) } }
      catch { return { id: r.id, name: r.name, filter: {} } }
    })
  // keyword browser: every keyword with its photo count (JSON arrays tallied
  // here — photo-app scale, cheap next to the strftime group-by above)
  const kwCounts = new Map()
  for (const r of db.selectObjects('SELECT keywords FROM photos WHERE keywords IS NOT NULL')) {
    for (const k of parseKeywords(r.keywords)) kwCounts.set(k, (kwCounts.get(k) ?? 0) + 1)
  }
  const keywords = [...kwCounts].map(([kw, count]) => ({ kw, count }))
    .sort((a, b) => a.kw.localeCompare(b.kw))
  return {
    total, rejected,
    lastImport: imp ? { id: imp.id, at: imp.at, count: imp.count } : null,
    dates, albums, smarts, keywords,
  }
}

// ── message loop (strictly serial, like render.worker) ─────────────────────

let chain = Promise.resolve()
self.onmessage = (e) => { chain = chain.then(() => handle(e.data)) }

async function handle(data) {
  try {
    switch (data.type) {
      case MSG.CAT_INIT: {
        initPromise ??= init()
        await initPromise
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_IMPORT: {
        const files = data.files ?? []
        const importId = uid('imp_')
        const photoIds = []
        const imported = [] // { id, name } — lets the caller pair XMP sidecars
        let done = 0
        // four files in flight (thumbnail decode and encode run off this
        // thread), rows inserted per group in one transaction; files land
        // before their rows, so a crash leaves at most invisible orphans
        const POOL = 4
        for (let g = 0; g < files.length; g += POOL) {
          const group = files.slice(g, g + POOL)
          const res = await Promise.all(group.map((f) =>
            importOne(f.name, f.buffer, importId).catch(() => null))) // one bad file must not sink the batch
          db.transaction((t) => {
            for (const r of res) if (r) t.exec({ sql: INSERT_PHOTO, bind: r.row })
          })
          res.forEach((r, k) => {
            if (r) { photoIds.push(r.id); imported.push({ id: r.id, name: group[k].name }) }
            done++
            post({ type: MSG.CAT_PROGRESS, done, total: files.length, photoId: r?.id ?? null, thumbReady: !!r?.thumbReady })
          })
        }
        db.exec({
          sql: 'INSERT INTO imports(id, at, source, count) VALUES(?,?,?,?)',
          bind: [importId, Date.now(), data.source ?? 'files', photoIds.length],
        })
        post({ re: data.id, ok: true, importId, photoIds, imported })
        break
      }

      case MSG.CAT_QUERY: {
        const t0 = performance.now()
        const photos = queryPhotos(data.filter, data.sort)
        post({ re: data.id, ok: true, photos, ms: performance.now() - t0 })
        break
      }

      case MSG.CAT_SET_META: {
        const sets = []
        const bind = []
        if (data.rating !== undefined) { sets.push('rating = ?'); bind.push(data.rating) }
        if (data.flag !== undefined) { sets.push('flag = ?'); bind.push(data.flag) }
        if (data.colorLabel !== undefined) { sets.push('color_label = ?'); bind.push(data.colorLabel) }
        if (sets.length) {
          bind.push(data.photoId)
          db.exec({ sql: `UPDATE photos SET ${sets.join(', ')} WHERE id = ?`, bind })
        }
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_SET_TEXTMETA: {
        // title/caption overwrite for every id; keyword add/remove merges into
        // each photo's own array (batch apply over a mixed selection is safe)
        const ids = data.photoIds ?? []
        db.transaction(() => {
          for (const pid of ids) {
            const sets = []
            const bind = []
            if (data.title !== undefined) { sets.push('title = ?'); bind.push(data.title || null) }
            if (data.caption !== undefined) { sets.push('caption = ?'); bind.push(data.caption || null) }
            if (data.addKeywords?.length || data.removeKeywords?.length) {
              const row = db.selectObjects('SELECT keywords FROM photos WHERE id = ?', [pid])[0]
              let kws = parseKeywords(row?.keywords)
              for (const k of data.addKeywords ?? []) if (!kws.includes(k)) kws.push(k)
              if (data.removeKeywords?.length) kws = kws.filter((k) => !data.removeKeywords.includes(k))
              sets.push('keywords = ?')
              bind.push(kws.length ? JSON.stringify(kws) : null)
            }
            if (sets.length) {
              bind.push(pid)
              db.exec({ sql: `UPDATE photos SET ${sets.join(', ')} WHERE id = ?`, bind })
            }
          }
        })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_BACKUP: {
        // catalog backup zip: edit sidecars + presets + smarts + manifest —
        // never originals (the confirm dialog says so). STORE-only (zip.js).
        const enc = new TextEncoder()
        const entries = []
        let sidecars = 0
        try {
          const editsDir = await getDir('edits', false)
          for await (const sub of editsDir.values()) {
            if (sub.kind !== 'directory') continue
            for await (const f of sub.values()) {
              if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
              entries.push({
                name: `edits/${sub.name}/${f.name}`,
                data: new Uint8Array(await (await f.getFile()).arrayBuffer()),
              })
              sidecars++
            }
          }
        } catch { /* no edits yet */ }
        let presetCount = 0
        try {
          const presetsDir = await getDir('presets', false)
          for await (const f of presetsDir.values()) {
            if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
            entries.push({
              name: `presets/${f.name}`,
              data: new Uint8Array(await (await f.getFile()).arrayBuffer()),
            })
            presetCount++
          }
        } catch { /* no presets yet */ }
        const smarts = db.selectObjects(
          'SELECT id, name, filter FROM smart_collections').map((r) => {
          try { return { id: r.id, name: r.name, filter: JSON.parse(r.filter) } }
          catch { return { id: r.id, name: r.name, filter: {} } }
        })
        entries.push({ name: 'smarts.json', data: enc.encode(JSON.stringify(smarts)) })
        const manifest = {
          app: 'albedo', kind: 'catalog-backup', version: 1, at: Date.now(),
          photos: db.selectObjects('SELECT id, filename FROM photos'),
          counts: { sidecars, presets: presetCount, smarts: smarts.length },
        }
        entries.push({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) })
        const zip = zipWrite(entries)
        post({ re: data.id, ok: true, buffer: zip.buffer, counts: manifest.counts }, [zip.buffer])
        break
      }

      case MSG.CAT_RESTORE: {
        // re-import sidecars/presets/smarts from a backup zip. Sidecars land
        // on matching photo ids; ids minted by a fresh import are covered by
        // a manifest filename remap (docs get their photoId rewritten).
        const dec = new TextDecoder()
        const entries = zipRead(new Uint8Array(data.buffer))
        let manifest = null
        try {
          const m = entries.find((e) => e.name === 'manifest.json')
          if (m) manifest = JSON.parse(dec.decode(m.data))
        } catch { manifest = null }
        const rows = db.selectObjects('SELECT id, filename FROM photos')
        const haveId = new Set(rows.map((r) => r.id))
        const idByName = new Map()
        for (const r of rows) if (!idByName.has(r.filename)) idByName.set(r.filename, r.id)
        const nameOfOld = new Map((manifest?.photos ?? []).map((p) => [p.id, p.filename]))
        const mapId = (oldId) => haveId.has(oldId) ? oldId
          : idByName.get(nameOfOld.get(oldId)) ?? null
        let restored = 0
        let skipped = 0
        let presetsN = 0
        let smartsN = 0
        for (const e of entries) {
          const m = e.name.match(/^edits\/([^/]+)\/([^/]+)\.json$/)
          if (m) {
            const target = mapId(m[1])
            if (!target) { skipped++; continue }
            let bytes = e.data
            let json = dec.decode(e.data)
            if (target !== m[1]) {
              // remapped id: keep the doc self-consistent
              try {
                const doc = JSON.parse(json)
                doc.photoId = target
                json = JSON.stringify(doc)
                bytes = new TextEncoder().encode(json)
              } catch { skipped++; continue }
            }
            await writeFileAtomic(`edits/${target}/${m[2]}.json`, bytes)
            db.exec({
              sql: 'INSERT OR REPLACE INTO edits(photo_id, version_id, doc, updated_at) VALUES(?,?,?,?)',
              bind: [target, m[2], json, Date.now()],
            })
            restored++
            continue
          }
          if (/^presets\/[^/]+\.json$/.test(e.name)) {
            try {
              const preset = presetRow(JSON.parse(dec.decode(e.data)))
              await writeFileAtomic(`presets/${preset.id}.json`, e.data)
              mirrorPreset(preset)
              presetsN++
            } catch { skipped++ }
            continue
          }
          if (e.name === 'smarts.json') {
            try {
              for (const s of JSON.parse(dec.decode(e.data))) {
                db.exec({
                  sql: `INSERT INTO smart_collections(id, name, filter, created_at) VALUES(?,?,?,?)
                        ON CONFLICT(id) DO UPDATE SET name = excluded.name, filter = excluded.filter`,
                  bind: [s.id, s.name, JSON.stringify(s.filter ?? {}), Date.now()],
                })
                smartsN++
              }
            } catch { /* torn smarts blob */ }
          }
        }
        post({ re: data.id, ok: true, restored, skipped, presets: presetsN, smarts: smartsN })
        break
      }

      case MSG.CAT_GET_FILE: {
        const row = db.selectObjects('SELECT opfs_path, filename FROM photos WHERE id = ?', [data.photoId])[0]
        if (!row) throw new Error(`unknown photo ${data.photoId}`)
        const buffer = await readFile(row.opfs_path)
        post({ re: data.id, ok: true, buffer, name: row.filename }, [buffer])
        break
      }

      case MSG.CAT_GET_THUMB: {
        let blob = null
        try { blob = await readFileBlob(`thumbs/${data.photoId}.jpg`) } catch { /* thumb_state 0/2 */ }
        post({ re: data.id, ok: true, blob })
        break
      }

      case MSG.CAT_GET_PREVIEW: {
        // cached preview, or build it once from the original (RAW: biggest
        // embedded JPEG stream — same source the import thumb used)
        let blob = null
        try { blob = await readFileBlob(`previews/${data.photoId}.jpg`) } catch { /* build below */ }
        if (!blob) {
          const row = db.selectObjects(
            'SELECT opfs_path, is_raw FROM photos WHERE id = ?', [data.photoId])[0]
          if (!row) throw new Error(`unknown photo ${data.photoId}`)
          const buffer = await readFile(row.opfs_path)
          let src = buffer
          if (row.is_raw) {
            const p = biggestPreview(parseExif(buffer))
            src = p ? buffer.slice(p.offset, p.offset + p.length) : null
          }
          if (src) {
            try {
              blob = await encodePreview(src)
              await writeFile(`previews/${data.photoId}.jpg`, new Uint8Array(await blob.arrayBuffer()))
            } catch { blob = null /* undecodable — caller falls back to the thumb */ }
          }
        }
        post({ re: data.id, ok: true, blob })
        break
      }

      case MSG.CAT_SAVE_THUMB: {
        // a photo deleted while the main-thread decode ran must not resurrect
        // its files — the row check makes this cancel-safe and idempotent
        const row = db.selectObjects('SELECT id FROM photos WHERE id = ?', [data.photoId])[0]
        if (!row) { post({ re: data.id, ok: true, saved: false }); break }
        await writeFile(`thumbs/${data.photoId}.jpg`, new Uint8Array(await data.blob.arrayBuffer()))
        const sets = ['thumb_state = 1']
        const bind = []
        if (data.width > 0 && data.height > 0) {
          sets.push('width = ?', 'height = ?')
          bind.push(data.width, data.height)
        }
        bind.push(data.photoId)
        db.exec({ sql: `UPDATE photos SET ${sets.join(', ')} WHERE id = ?`, bind })
        post({ re: data.id, ok: true, saved: true })
        break
      }

      case MSG.CAT_SAVE_DOC: {
        const versionId = data.versionId ?? data.doc?.versionId ?? 'v_default'
        const json = JSON.stringify(data.doc)
        // sidecar is the source of truth (survives a rebuilt DB); table is the mirror
        await writeFileAtomic(`edits/${data.photoId}/${versionId}.json`, new TextEncoder().encode(json))
        db.exec({
          sql: 'INSERT OR REPLACE INTO edits(photo_id, version_id, doc, updated_at) VALUES(?,?,?,?)',
          bind: [data.photoId, versionId, json, Date.now()],
        })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_LOAD_DOC: {
        const versionId = data.versionId ?? 'v_default'
        let doc = null
        try {
          doc = JSON.parse(new TextDecoder().decode(await readFile(`edits/${data.photoId}/${versionId}.json`)))
        } catch {
          const row = db.selectObjects(
            'SELECT doc FROM edits WHERE photo_id = ? AND version_id = ?', [data.photoId, versionId])[0]
          if (row?.doc) { try { doc = JSON.parse(row.doc) } catch { doc = null } }
        }
        post({ re: data.id, ok: true, doc })
        break
      }

      case MSG.CAT_SAVE_MASK: {
        // AI-mask weights (png bytes); named by ids so replay is a direct read
        await writeFile(`masks/${data.photoId}/${data.maskId}.png`, data.buffer)
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_LOAD_MASK: {
        let blob = null
        try { blob = await readFileBlob(`masks/${data.photoId}/${data.maskId}.png`) } catch { /* never saved */ }
        post({ re: data.id, ok: true, blob })
        break
      }

      case MSG.CAT_PROFILE_SAVE: {
        // an imported DCP camera profile, byte for byte
        await writeFileAtomic(`profiles/${data.profileId}.dcp`, new Uint8Array(data.buffer))
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_PROFILE_LIST: {
        const profiles = []
        try {
          const dir = await getDir('profiles', false)
          for await (const entry of dir.values()) {
            if (entry.kind !== 'file' || !entry.name.endsWith('.dcp')) continue
            profiles.push({ id: entry.name.slice(0, -4), buffer: await (await entry.getFile()).arrayBuffer() })
          }
        } catch { /* none imported yet */ }
        post({ re: data.id, ok: true, profiles }, profiles.map((p) => p.buffer))
        break
      }

      case MSG.CAT_PROFILE_DELETE: {
        try { await (await getDir('profiles', false)).removeEntry(`${data.profileId}.dcp`) } catch { /* gone */ }
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_PRESET_SAVE: {
        const preset = presetRow(data.preset)
        await writeFileAtomic(`presets/${preset.id}.json`,
          new TextEncoder().encode(JSON.stringify(preset)))
        mirrorPreset(preset)
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_PRESET_LIST: {
        const presets = []
        try {
          const dir = await getDir('presets', false)
          for await (const entry of dir.values()) {
            if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
            try {
              presets.push(presetRow(JSON.parse(new TextDecoder().decode(
                await (await entry.getFile()).arrayBuffer()))))
            } catch { /* torn sidecar — the mirror row below may still cover it */ }
          }
        } catch { /* no presets dir yet */ }
        if (!presets.length) {
          for (const r of db.selectObjects('SELECT id, name, modules, grp, source, created_at FROM presets')) {
            try {
              presets.push(presetRow({
                id: r.id, name: r.name, group: r.grp, source: r.source,
                createdAt: r.created_at, modules: JSON.parse(r.modules),
              }))
            } catch { /* skip */ }
          }
        }
        presets.sort((a, b) => a.name.localeCompare(b.name))
        post({ re: data.id, ok: true, presets })
        break
      }

      case MSG.CAT_PRESET_DELETE: {
        try { await (await getDir('presets', false)).removeEntry(`${data.presetId}.json`) } catch { /* already gone */ }
        db.exec({ sql: 'DELETE FROM presets WHERE id = ?', bind: [data.presetId] })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_LIST_DOCS: {
        // versions of one photo: sidecar dir is the source of truth (names
        // live inside each doc as doc.versionName); the table fills updated_at
        const at = new Map(db.selectObjects(
          'SELECT version_id, updated_at, doc FROM edits WHERE photo_id = ?', [data.photoId])
          .map((r) => [r.version_id, r]))
        const versions = new Map()
        try {
          const dir = await getDir(`edits/${data.photoId}`, false)
          for await (const entry of dir.values()) {
            if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
            const versionId = entry.name.slice(0, -5)
            let name = null
            try {
              const doc = JSON.parse(new TextDecoder().decode(
                await (await entry.getFile()).arrayBuffer()))
              name = doc?.versionName ?? null
            } catch { /* torn sidecar — mirror row below may cover it */ }
            versions.set(versionId, { versionId, name, updatedAt: at.get(versionId)?.updated_at ?? 0 })
          }
        } catch { /* no edits dir yet */ }
        for (const [versionId, row] of at) {
          if (versions.has(versionId)) continue
          let name = null
          try { name = JSON.parse(row.doc)?.versionName ?? null } catch { /* skip */ }
          versions.set(versionId, { versionId, name, updatedAt: row.updated_at ?? 0 })
        }
        // v_default first, then creation order (v_<timestamp> sorts lexically)
        const list = [...versions.values()].sort((a, b) =>
          (a.versionId === 'v_default' ? -1 : b.versionId === 'v_default' ? 1
            : a.versionId < b.versionId ? -1 : 1))
        post({ re: data.id, ok: true, versions: list })
        break
      }

      case MSG.CAT_SIDEBAR: {
        post({ re: data.id, ok: true, ...sidebar() })
        break
      }

      case MSG.CAT_DELETE_PHOTOS: {
        const ids = data.photoIds ?? []
        if (!ids.length) { post({ re: data.id, ok: true, deleted: 0 }); break }
        // rows first, one transaction — the catalog never points at half-gone
        // photos; file removal after is best-effort (an orphan file is invisible,
        // a dangling row is a broken cell)
        const paths = new Map(db.selectObjects(
          `SELECT id, opfs_path FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
          .map((r) => [r.id, r.opfs_path]))
        db.transaction(() => {
          for (const id of ids) {
            db.exec({ sql: 'DELETE FROM photos WHERE id = ?', bind: [id] })
            db.exec({ sql: 'DELETE FROM album_photos WHERE photo_id = ?', bind: [id] })
            db.exec({ sql: 'DELETE FROM edits WHERE photo_id = ?', bind: [id] })
          }
        })
        for (const id of ids) {
          const p = paths.get(id)
          if (p) await deleteFile(p)
          await deleteFile(`thumbs/${id}.jpg`)
          await deleteFile(`previews/${id}.jpg`)
          await deleteDir(`edits/${id}`)
          await deleteDir(`masks/${id}`)
          await deleteDir(`proxies/${id}`)
        }
        post({ re: data.id, ok: true, deleted: ids.length })
        break
      }

      case MSG.CAT_ALBUM_CREATE: {
        const album = { id: uid('al_'), name: data.name || 'Untitled Album' }
        db.exec({ sql: 'INSERT INTO albums(id, name) VALUES(?,?)', bind: [album.id, album.name] })
        post({ re: data.id, ok: true, album })
        break
      }

      case MSG.CAT_ALBUM_RENAME: {
        db.exec({ sql: 'UPDATE albums SET name = ? WHERE id = ?', bind: [data.name, data.albumId] })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_ALBUM_DELETE: {
        db.exec({ sql: 'DELETE FROM album_photos WHERE album_id = ?', bind: [data.albumId] })
        db.exec({ sql: 'DELETE FROM albums WHERE id = ?', bind: [data.albumId] })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_ALBUM_ADD: {
        for (const pid of data.photoIds ?? []) {
          db.exec({
            sql: 'INSERT OR IGNORE INTO album_photos(album_id, photo_id) VALUES(?,?)',
            bind: [data.albumId, pid],
          })
        }
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_ALBUM_REMOVE: {
        for (const pid of data.photoIds ?? []) {
          db.exec({
            sql: 'DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?',
            bind: [data.albumId, pid],
          })
        }
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_SMART_SAVE: {
        const { smart } = data
        db.exec({
          sql: `INSERT INTO smart_collections(id, name, filter, created_at) VALUES(?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, filter = excluded.filter`,
          bind: [smart.id, smart.name, JSON.stringify(smart.filter ?? {}), Date.now()],
        })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_SMART_DELETE: {
        db.exec({ sql: 'DELETE FROM smart_collections WHERE id = ?', bind: [data.smartId] })
        post({ re: data.id, ok: true })
        break
      }

      case MSG.CAT_DELETE_DOC: {
        try {
          await (await getDir(`edits/${data.photoId}`, false)).removeEntry(`${data.versionId}.json`)
        } catch { /* already gone */ }
        db.exec({
          sql: 'DELETE FROM edits WHERE photo_id = ? AND version_id = ?',
          bind: [data.photoId, data.versionId],
        })
        post({ re: data.id, ok: true })
        break
      }
    }
  } catch (err) {
    post({ re: data.id, ok: false, type: MSG.ERROR, message: String(err?.message ?? err) })
  }
}
