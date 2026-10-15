import { useState, useEffect, useRef } from 'react'
import {
  useCatalog, getCatalogState, setFilter, applySmart,
  albumCreate, albumRename, albumDelete, albumAdd, smartSave, smartDelete,
  backupCatalog, restoreCatalog,
} from '../state/catalogStore.js'
import { useViewState, toggleNav, setNavEdit } from '../state/viewStore.js'
import { openContextMenu } from './ContextMenu.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import { saveBlob } from '../io/exportUtil.js'
import { toast } from '../state/toastStore.js'

// Left navigator: CATALOG / FOLDERS (capture-date tree) / ALBUMS / SMART /
// KEYWORDS, plus the catalog backup/restore footer. Collapses to a 4px rib.
// All data arrives via the sidebar snapshot the catalog worker recomputes
// after every mutation.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const smUid = (prefix) => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 12)

// ── flows shared with the ⌘K palette (App routes host calls here) ──────────

export async function createAlbumFlow() {
  const album = await albumCreate('New Album')
  setNavEdit({ kind: 'album', id: album.id })
}

export async function saveSmartFlow() {
  const f = getCatalogState().filter
  const saved = {
    flag: f.flag ?? null, minRating: f.minRating ?? null,
    colorLabel: f.colorLabel ?? null, search: f.search ?? null,
  }
  const n = (getCatalogState().sidebar?.smarts?.length ?? 0) + 1
  const smart = { id: smUid('sm_'), name: `Smart ${n}`, filter: saved }
  await smartSave(smart)
  applySmart(smart)
  setNavEdit({ kind: 'smart', id: smart.id })
}

// inline rename field for album/smart rows
function NameEdit({ name, onCommit }) {
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const commit = () => {
    const v = ref.current?.value.trim()
    setNavEdit(null)
    if (v && v !== name) onCommit(v)
  }
  return (
    <input
      ref={ref}
      className="nav-edit"
      defaultValue={name}
      spellCheck={false}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') setNavEdit(null)
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  )
}

function Row({ label, count, on, depth = 0, tick, onClick, onContextMenu, trailing,
  dropId, onDropPhotos }) {
  const [over, setOver] = useState(false)
  const dndProps = onDropPhotos ? {
    onDragOver: (e) => {
      if (![...e.dataTransfer.types].includes('application/x-albedo-photos')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      e.preventDefault()
      setOver(false)
      try {
        const ids = JSON.parse(e.dataTransfer.getData('application/x-albedo-photos'))
        if (Array.isArray(ids) && ids.length) onDropPhotos(ids)
      } catch { /* not ours */ }
    },
  } : {}
  return (
    <div
      className={`nav-row${on ? ' is-on' : ''}${over ? ' is-drop' : ''}`}
      style={depth ? { paddingLeft: 10 + depth * 14 } : undefined}
      data-nav={dropId}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick?.() }}
      onContextMenu={onContextMenu}
      {...dndProps}
    >
      {tick}
      <span className="nav-label">{label}</span>
      {trailing}
      {count != null && <span className="nav-count mono">{count}</span>}
    </div>
  )
}

export default function Navigator({ onClearRejects }) {
  const { sidebar, filter } = useCatalog()
  const { navCollapsed, navEdit } = useViewState()
  const [closedYears, setClosedYears] = useState(() => new Set())
  const [backupAsk, setBackupAsk] = useState(false)
  const [busy, setBusy] = useState(false) // one backup/restore at a time

  const runBackup = async () => {
    setBackupAsk(false)
    if (busy) return
    setBusy(true)
    try {
      const { buffer, counts } = await backupCatalog()
      const d = new Date()
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      await saveBlob(new Blob([buffer], { type: 'application/zip' }), `albedo-backup-${stamp}.zip`, null)
      toast(`Backed up ${counts.sidecars} edit${counts.sidecars === 1 ? '' : 's'}, ` +
        `${counts.presets} preset${counts.presets === 1 ? '' : 's'}, ${counts.smarts} smart`)
    } catch (err) {
      console.error('[backup]', err)
      toast('Backup failed — see console')
    } finally { setBusy(false) }
  }

  const runRestore = async (file) => {
    if (!file || busy) return
    setBusy(true)
    try {
      const res = await restoreCatalog(await file.arrayBuffer())
      toast(`Restored ${res.restored} edit${res.restored === 1 ? '' : 's'} + ` +
        `${res.presets} preset${res.presets === 1 ? '' : 's'}, skipped ${res.skipped}`)
    } catch (err) {
      console.error('[restore]', err)
      toast('Restore failed — not an albedo backup?')
    } finally { setBusy(false) }
  }

  // on-demand input: a mounted <input type=file> here would shadow the app's
  // import input for anything selecting on the bare tag (e2e suites included)
  const pickRestoreFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.onchange = () => runRestore(input.files?.[0])
    input.click()
  }

  if (navCollapsed) {
    return (
      <button
        className="navigator is-rib"
        title="Expand navigator"
        aria-label="Expand navigator"
        onClick={toggleNav}
      />
    )
  }

  const sb = sidebar ?? { total: 0, rejected: 0, lastImport: null, dates: [], albums: [], smarts: [] }
  const src = filter.source ?? { kind: 'all' }
  const rejectedOn = filter.flag === -1

  // dates → Year ▸ Month tree (already y-desc, m-desc from the worker)
  const years = []
  for (const d of sb.dates) {
    let y = years[years.length - 1]
    if (!y || y.y !== d.y) { y = { y: d.y, count: 0, months: [] }; years.push(y) }
    y.count += d.count
    y.months.push(d)
  }

  const setSource = (source, extra = {}) => setFilter({ source, ...extra })

  const albumMenu = (a) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', run: () => setNavEdit({ kind: 'album', id: a.id }) },
      { label: 'Delete Album', danger: true, run: () => albumDelete(a.id) },
    ])
  }

  const smartMenu = (s) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', run: () => setNavEdit({ kind: 'smart', id: s.id }) },
      { label: 'Update to Current Filter', run: () => {
        const f = getCatalogState().filter
        smartSave({ ...s, filter: {
          flag: f.flag ?? null, minRating: f.minRating ?? null,
          colorLabel: f.colorLabel ?? null, search: f.search ?? null,
        } })
      } },
      { label: 'Delete Smart Collection', danger: true, run: () => smartDelete(s.id) },
    ])
  }

  return (
    <aside className="navigator" aria-label="Navigator">
      <div className="nav-scroll">
        <div className="nav-sec">
          <div className="nav-head">
            <span className="panel-header">Catalog</span>
            <button className="nav-fold" data-tip="Collapse navigator" aria-label="Collapse navigator"
              onClick={toggleNav}>
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <path d="M5.5 0.8L2 4l3.5 3.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          </div>
          <Row label="All Photos" count={sb.total}
            on={src.kind === 'all' && !rejectedOn && !filter.smartId}
            onClick={() => setSource({ kind: 'all' }, rejectedOn ? { flag: null } : {})} />
          {sb.lastImport && (
            <Row label="Recent Import" count={sb.lastImport.count}
              on={src.kind === 'recent'}
              onClick={() => setSource({ kind: 'recent' }, rejectedOn ? { flag: null } : {})} />
          )}
          <Row label="Rejected" count={sb.rejected} on={rejectedOn}
            onClick={() => setFilter({ flag: rejectedOn ? null : -1, source: { kind: 'all' } })}
            trailing={sb.rejected > 0 && (
              <button
                className="nav-sweep"
                data-tip="Delete every rejected photo"
                onClick={(e) => { e.stopPropagation(); onClearRejects() }}
              >Clear</button>
            )} />
        </div>

        {years.length > 0 && (
          <div className="nav-sec">
            <div className="nav-head"><span className="panel-header">Folders</span></div>
            {years.map((y) => {
              const open = !closedYears.has(y.y)
              return (
                <div key={y.y}>
                  <Row
                    label={String(y.y)} count={y.count} depth={0}
                    on={src.kind === 'date' && src.y === y.y && src.m == null}
                    tick={(
                      <button
                        className={`nav-caret${open ? ' is-open' : ''}`}
                        aria-label={open ? 'Collapse year' : 'Expand year'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setClosedYears((s) => {
                            const n = new Set(s)
                            n.has(y.y) ? n.delete(y.y) : n.add(y.y)
                            return n
                          })
                        }}
                      >
                        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                          <path d="M2 0.8l4 3.2-4 3.2z" fill="currentColor" />
                        </svg>
                      </button>
                    )}
                    onClick={() => setSource({ kind: 'date', y: y.y })}
                  />
                  {open && y.months.map((m) => (
                    <Row key={m.m}
                      label={MONTHS[m.m - 1] ?? `M${m.m}`} count={m.count} depth={1}
                      on={src.kind === 'date' && src.y === y.y && src.m === m.m}
                      onClick={() => setSource({ kind: 'date', y: y.y, m: m.m })}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}

        <div className="nav-sec">
          <div className="nav-head">
            <span className="panel-header">Albums</span>
            <button className="nav-add" data-tip="New album" aria-label="New album"
              onClick={() => createAlbumFlow()}>+</button>
          </div>
          {sb.albums.length === 0 && <p className="nav-none">Drag photos onto an album</p>}
          {sb.albums.map((a) => (
            navEdit?.kind === 'album' && navEdit.id === a.id ? (
              <div key={a.id} className="nav-row is-editing">
                <NameEdit name={a.name} onCommit={(name) => albumRename(a.id, name)} />
              </div>
            ) : (
              <Row key={a.id} label={a.name} count={a.count}
                on={src.kind === 'album' && src.albumId === a.id}
                dropId={`album-${a.id}`}
                onClick={() => setSource({ kind: 'album', albumId: a.id })}
                onContextMenu={albumMenu(a)}
                onDropPhotos={(ids) => albumAdd(a.id, ids)}
              />
            )
          ))}
        </div>

        <div className="nav-sec">
          <div className="nav-head">
            <span className="panel-header">Smart</span>
            <button className="nav-add" data-tip="Save the current filter as a smart collection"
              aria-label="Save smart collection" onClick={() => saveSmartFlow()}>+</button>
          </div>
          {sb.smarts.length === 0 && <p className="nav-none">+ saves the current filter</p>}
          {sb.smarts.map((s) => (
            navEdit?.kind === 'smart' && navEdit.id === s.id ? (
              <div key={s.id} className="nav-row is-editing">
                <NameEdit name={s.name} onCommit={(name) => smartSave({ ...s, name })} />
              </div>
            ) : (
              <Row key={s.id} label={s.name}
                on={filter.smartId === s.id}
                onClick={() => applySmart(s)}
                onContextMenu={smartMenu(s)}
              />
            )
          ))}
        </div>

        {(sb.keywords?.length ?? 0) > 0 && (
          <div className="nav-sec" data-nav-sec="keywords">
            <div className="nav-head"><span className="panel-header">Keywords</span></div>
            {sb.keywords.map(({ kw, count }) => (
              <Row key={kw} label={kw} count={count}
                on={filter.keyword === kw}
                onClick={() => setFilter({ keyword: filter.keyword === kw ? null : kw })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="nav-footer">
        <button className="nav-io" disabled={busy}
          data-tip="Download edits, presets and smart collections as a zip"
          onClick={() => setBackupAsk(true)}>Back up catalog…</button>
        <button className="nav-io" disabled={busy}
          data-tip="Re-import edits and presets from a backup zip"
          onClick={pickRestoreFile}>Restore backup…</button>
      </div>

      {backupAsk && (
        <ConfirmDialog
          title="Back up catalog"
          body={'Downloads a zip of your edit sidecars, presets and smart collections. ' +
            'Original photo files are NOT included — back those up separately.'}
          confirmLabel="Back up"
          onConfirm={runBackup}
          onClose={() => setBackupAsk(false)}
        />
      )}
    </aside>
  )
}
