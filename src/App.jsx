import { useRef, useEffect, useState, useCallback } from 'react'
import Develop from './ui/Develop.jsx'
import Library, { matchesFilter, isFilterActive, CLEAR_FILTER } from './ui/Library.jsx'
import Filmstrip from './ui/Filmstrip.jsx'
import Palette from './ui/Palette.jsx'
import CheatSheet from './ui/CheatSheet.jsx'
import CopyDialog from './ui/CopyDialog.jsx'
import ExportDialog from './ui/ExportDialog.jsx'
import ConfirmDialog from './ui/ConfirmDialog.jsx'
import ToastHost from './ui/Toast.jsx'
import { ContextMenuHost, openContextMenu } from './ui/ContextMenu.jsx'
import { createAlbumFlow, saveSmartFlow } from './ui/Navigator.jsx'
import { evictThumbs } from './ui/useThumb.js'
import { toast } from './state/toastStore.js'
import { initRender, exportPhoto } from './state/renderClient.js'
import { getDenoiseState } from './state/denoiseClient.js'
import { loadProfiles, importProfiles } from './state/profileStore.js'
import { useEditState, getState as getEditState, setBackend, undo, redo, applyModules, commitParam, resetAll } from './state/editStore.js'
import { getParam, hasEdits } from './engine/editdoc.js'
import TooltipHost from './ui/Tooltip.jsx'
import {
  useViewState, getViewState, setSurface, setMode, select, bumpThumb, setCropMode, toggleZoom,
  toggleTheme, cycleLightsOut, setLightsOut, cycleInfoOverlay,
} from './state/viewStore.js'
import {
  useCatalog, initCatalog, importFiles, setMeta, setFilter, loadDoc, loadDocVersion,
  listDocs, getCatalogState, loadOriginal, loadPreviewBlob, deletePhotos, getRejectedIds,
  albumAdd, albumRemove, rebuildThumb, loadThumbBlob,
} from './state/catalogStore.js'
import { evictPreviews } from './state/usePreview.js'
import {
  getClipboard, pasteToPhotos, getPresetState, setClipboard, pickGroups, nonDefaultGroupIds,
  allPresets, applyPresetToPhotos, applyXmpSidecars, importPresetFiles, loadPresets,
} from './state/presetStore.js'
import { xmpSummary } from './io/xmp.js'
import { setCommandHost } from './state/commands.js'
import { openInDevelop } from './state/openPhoto.js'
import CanvasSurface from './edit/CanvasSurface.jsx'
import { initCanvas, canvasE2e, dropImageFiles, useCanvasState } from './state/canvasClient.js'
import { toggleBefore, toggleClipOverlay } from './ui/devFlags.js'
import { getMaskUi, toggleMaskMode, handleMaskKey } from './ui/MaskPanel.jsx'

const IMPORT_RE = /\.(jpe?g|png|webp|avif|gif|bmp|tiff?|cr2|cr3|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|raw|erf|kdc|3fr|mrw|iiq|rwl|x3f)$/i
const ACCEPT = 'image/*,.cr2,.cr3,.nef,.nrw,.arw,.dng,.raf,.orf,.rw2,.pef,.srw,.xmp,.dcp'
const COLOR_KEYS = { 6: 'red', 7: 'yellow', 8: 'green', 9: 'blue' }

export default function App() {
  const canvasRef = useRef(null)
  const cvCanvasRef = useRef(null) // canvas-surface display canvas (own worker)
  const fileRef = useRef(null)
  const { photo, backend } = useEditState()
  const { doc: cvDoc } = useCanvasState()
  const { surface, selectedId, zoom, theme, lightsOut } = useViewState()
  const { photos, filter, importing } = useCatalog()
  const [dragOver, setDragOver] = useState(false)
  const [overlay, setOverlay] = useState(null) // null | 'palette' | 'cheatsheet' | 'copy'
  const [confirm, setConfirm] = useState(null) // { ids, title } — pending photo deletion
  const inited = useRef(false)

  useEffect(() => {
    if (inited.current) return
    inited.current = true
    // ?backend=webgl2 forces the fallback — kept forever for parity testing
    const pref = new URLSearchParams(location.search).get('backend') ?? 'webgpu'
    initRender(canvasRef.current, pref).then(({ backend }) => setBackend(backend))
    initCanvas(cvCanvasRef.current).catch((err) => console.error('[canvas init]', err))
    initCatalog()
    loadPresets()
    loadProfiles()
    // e2e hook. Tests must reach the app's OWN module instances through this:
    // a dynamic import() from the page can resolve to a second copy of a store.
    window.__albedo = { edit: getEditState, loadDoc, loadDocVersion, listDocs, catalog: getCatalogState, presets: getPresetState, view: getViewState, maskUi: getMaskUi, loadOriginal, preview: loadPreviewBlob, canvas: canvasE2e, exportPhoto, rebuildThumb, loadThumbBlob, deletePhotos, denoise: getDenoiseState }
  }, [])

  const visible = photos.filter((p) => matchesFilter(p, filter))
  const selPhoto = photos.find((p) => p.id === selectedId) ?? null
  const catalogEmpty = photos.length === 0 && !importing && !isFilterActive(filter)

  // first arrival (or restored catalog): something must be selected
  useEffect(() => {
    if (selectedId == null && photos.length) select(photos[0].id)
  }, [photos, selectedId])

  const openFor = useCallback((p) => {
    if (!p) return
    select(p.id)
    setSurface('develop')
    if (getEditState().photo?.id !== p.id)
      openInDevelop(p).catch((err) => console.warn('[open]', err))
  }, [])

  // Photos import; .xmp sidecars dropped with them apply to their photo;
  // any other .xmp or preset .json becomes a preset.
  const doImport = useCallback((fileList) => {
    const all = [...fileList]
    const files = all.filter((f) => /^image\//.test(f.type) || IMPORT_RE.test(f.name))
    const xmps = all.filter((f) => /\.xmp$/i.test(f.name))
    const presetFiles = all.filter((f) => /\.json$/i.test(f.name))
    const dcps = all.filter((f) => /\.dcp$/i.test(f.name))
    const run = async () => {
      const imported = files.length ? await importFiles(files, { names: true }) : []
      const side = await applyXmpSidecars(xmps, imported)
      if (imported.length) {
        const extra = side.applied ? ` · ${side.applied} with Lightroom edits` : ''
        const miss = xmpSummary(side.unmapped)
        toast(`Imported ${imported.length} photo${imported.length === 1 ? '' : 's'}${extra}${miss ? ` · ${miss}` : ''}`, {
          action: { label: 'View', run: () => setFilter({ ...CLEAR_FILTER, source: { kind: 'recent' } }) },
          timeout: miss ? 7000 : 4000,
        })
      }
      if (dcps.length) {
        const r = await importProfiles(dcps)
        toast(`${r.added} camera profile${r.added === 1 ? '' : 's'} imported${r.skipped ? ` · ${r.skipped} unreadable` : ''}`)
      }
      const rest = [...side.rest, ...presetFiles]
      if (rest.length) {
        const r = await importPresetFiles(rest)
        toast(r.message, { timeout: 7000 })
      }
    }
    if (files.length || xmps.length || presetFiles.length || dcps.length)
      run().catch((err) => console.error('[import]', err))
  }, [])

  // installed app: files opened from the desktop ("Open with albedo")
  useEffect(() => {
    if (!('launchQueue' in window)) return
    window.launchQueue.setConsumer(async ({ files }) => {
      if (files?.length) doImport(await Promise.all(files.map((h) => h.getFile())))
    })
  }, [doImport])

  // ── delete: one confirmed path for ⌫, context menu and Clear rejects ─────
  const requestDelete = useCallback((ids, title = 'Delete photos') => {
    if (ids?.length) setConfirm({ ids, title })
  }, [])

  const clearRejects = useCallback(() => {
    getRejectedIds().then((ids) => {
      if (ids.length) setConfirm({ ids, title: 'Clear rejects' })
    }).catch((err) => console.error('[rejects]', err))
  }, [])

  const runDelete = useCallback((ids) => {
    setConfirm(null)
    const going = new Set(ids)
    // never leave Develop pointed at a dead photo
    if (getEditState().photo && going.has(getEditState().photo.id)) setSurface('library')
    // focus the nearest survivor so the grid never strands the keyboard
    const vis = ctx.current.visible
    const at = vis.findIndex((p) => p.id === getViewState().selectedId)
    let next = null
    for (let i = Math.max(0, at); i < vis.length; i++)
      if (!going.has(vis[i].id)) { next = vis[i]; break }
    if (!next) for (let i = Math.min(at, vis.length - 1); i >= 0; i--)
      if (!going.has(vis[i].id)) { next = vis[i]; break }
    select(next?.id ?? null)
    evictThumbs(ids)
    evictPreviews(ids)
    deletePhotos(ids)
      .then(() => toast(`Removed ${ids.length} photo${ids.length === 1 ? '' : 's'}`))
      .catch((err) => { console.error('[delete]', err); toast('Delete failed — see console') })
  }, [])

  const focusSearch = useCallback(() => {
    if (getViewState().surface !== 'library') setSurface('library')
    requestAnimationFrame(() => document.querySelector('.search-input')?.focus())
  }, [])

  // ── context menu for grid + filmstrip cells ──────────────────────────────
  const onCellMenu = useCallback((e, p) => {
    e.preventDefault()
    const v = getViewState()
    if (!v.selection.has(p.id)) select(p.id)
    const ids = getViewState().selection.size ? [...getViewState().selection] : [p.id]
    const many = ids.length > 1
    const cat = getCatalogState()
    const albums = cat.sidebar?.albums ?? []
    const inAlbum = cat.filter.source?.kind === 'album' ? cat.filter.source.albumId : null
    const each = (patch) => { for (const id of ids) setMeta(id, patch) }
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Open in Develop', key: 'D', run: () => openFor(p) },
      { sep: true },
      { stars: p.rating ?? 0, onStars: (n) => each({ rating: n }) },
      { colors: p.colorLabel ?? null, onColor: (c) => each({ colorLabel: c }) },
      { sep: true },
      { label: 'Pick', key: 'P', run: () => each({ flag: 1 }) },
      { label: 'Reject', key: 'X', run: () => each({ flag: -1 }) },
      { label: 'Unflag', key: 'U', run: () => each({ flag: 0 }) },
      { sep: true },
      { label: many ? `Add ${ids.length} to Album` : 'Add to Album',
        items: albums.length
          ? albums.map((a) => ({ label: a.name, run: () => albumAdd(a.id, ids) }))
          : [{ label: 'No albums yet', disabled: true }] },
      inAlbum && { label: 'Remove from Album', run: () => albumRemove(inAlbum, ids) },
      { sep: true },
      { label: 'Copy Settings', run: async () => {
        const doc = getEditState().photo?.id === p.id ? getEditState().doc : await loadDoc(p.id)
        const groups = doc ? nonDefaultGroupIds(doc) : []
        if (!groups.length) return toast('No edits to copy')
        setClipboard(pickGroups(doc, groups))
        toast(`Copied settings from ${p.name}`)
      } },
      { label: 'Paste Settings', key: '⌘V', disabled: !getClipboard(), run: () => pasteSettings() },
      { label: many ? `Apply Preset to ${ids.length}` : 'Apply Preset',
        items: allPresets().map((ps) => ({
          label: ps.name,
          run: () => {
            applyPresetToPhotos(ps, ids)
            toast(`${ps.name} applied to ${ids.length} photo${ids.length === 1 ? '' : 's'}`)
          },
        })) },
      { sep: true },
      { label: 'Export…', key: '⌘E', run: () => setOverlay('export') },
      { label: many ? `Delete ${ids.length} Photos…` : 'Delete Photo…', key: '⌫', danger: true,
        run: () => requestDelete(ids) },
    ])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘V: develop = current doc, one history entry; library = whole selection
  const pasteSettings = useCallback(() => {
    const clip = getClipboard()
    if (!clip) return
    const v = getViewState()
    if (v.surface === 'develop') {
      if (getEditState().doc) applyModules(clip)
      return
    }
    const ids = v.selection.size ? [...v.selection] : v.selectedId != null ? [v.selectedId] : []
    if (!ids.length) return
    pasteToPhotos(ids, clip)
    // paste stamp: transient class, direct DOM — no React round-trip for 120ms
    for (const id of ids) {
      const el = document.querySelector(`.gcell[data-id="${CSS.escape(String(id))}"]`)
      if (!el) continue
      el.classList.add('paste-flash')
      setTimeout(() => el.classList.remove('paste-flash'), 120)
    }
  }, [])

  // commands reach App-owned machinery (file input, overlays, paste) via host
  useEffect(() => {
    setCommandHost({
      openFiles: () => fileRef.current?.click(),
      openFor,
      openOverlay: setOverlay,
      paste: pasteSettings,
      focusSearch,
      requestDelete: () => {
        const v = getViewState()
        const ids = v.selection.size ? [...v.selection] : v.selectedId != null ? [v.selectedId] : []
        requestDelete(ids)
      },
      clearRejects,
      newAlbum: createAlbumFlow,
      saveSmart: saveSmartFlow,
    })
  }, [openFor, pasteSettings, focusSearch, requestDelete, clearRejects])

  // ── keyboard router — the whole culling language lives here ──────────────
  const ctx = useRef(null)
  ctx.current = { visible, photos, surface, overlay, confirm }
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented) return // sliders own their arrow keys
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      if (ctx.current.overlay || ctx.current.confirm) return // overlays own the keyboard while open
      const { visible, photos, surface } = ctx.current
      const v = getViewState()

      if (e.metaKey || e.ctrlKey) {
        const k = e.key.toLowerCase()
        if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
        if (k === 'k') { e.preventDefault(); setOverlay('palette'); return }
        if (k === 'r' && e.shiftKey && surface === 'develop') {
          const d = getEditState().doc
          if (d && hasEdits(d)) { e.preventDefault(); resetAll(); toast('Reset to original — ⌘Z to undo') }
          return
        }
        if (k === 'e') {
          // canvas export is handled by the surface's own capture handler
          if (surface === 'canvas') return
          // develop: current photo; library: the selection (batch)
          const can = surface === 'develop'
            ? !!getEditState().doc
            : v.selection.size > 0 || v.selectedId != null
          if (can) { e.preventDefault(); setOverlay('export') }
          return
        }
        if (k === 'z' && surface === 'canvas') return // canvas history only
        if (k === 'c' && surface === 'develop' && getEditState().doc && getSelection().isCollapsed) {
          e.preventDefault()
          setOverlay('copy')
          return
        }
        if (k === 'v' && getClipboard()) { e.preventDefault(); pasteSettings(); return }
        if (k === 'f' && surface === 'library') { e.preventDefault(); focusSearch(); return }
        return
      }
      if (e.altKey) {
        if (e.code === 'Backslash') { e.preventDefault(); setFilter({ ...CLEAR_FILTER }) }
        return
      }

      // mask mode owns its key language (L/⇧M/K/O/[ ]/⌫/Esc…); unhandled keys
      // fall through to the normal router
      if (surface === 'develop' && getMaskUi().on && !v.cropMode) {
        if (handleMaskKey(e)) { e.preventDefault(); return }
      }

      const ids = v.selection.size ? [...v.selection] : v.selectedId != null ? [v.selectedId] : []
      const sel = photos.find((p) => p.id === v.selectedId) ?? null

      // canvas surface owns its keys (capture handler in CanvasSurface runs
      // first); only surface switching + lights-out pass through here
      if (surface === 'canvas') {
        switch (e.key) {
          case 'g': case 'G': setMode('grid'); setSurface('library'); return
          case 'd': case 'D': if (sel) openFor(sel); return
          case 'l': case 'L': cycleLightsOut(); return
          case 'Escape': if (getViewState().lightsOut) setLightsOut(0); return
          case '?': e.preventDefault(); setOverlay('cheatsheet'); return
        }
        return
      }
      const nav = (d) => {
        if (!visible.length) return
        const at = visible.findIndex((p) => p.id === v.selectedId)
        const next = visible[at < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, at + d))]
        if (!next || next.id === v.selectedId) return
        surface === 'develop' ? openFor(next) : select(next.id)
      }

      switch (e.key) {
        // G: grid mode first, then Library from Develop
        case 'g': case 'G': setMode('grid'); setSurface('library'); return
        case 'd': case 'D': if (sel) openFor(sel); return
        // E: the Canvas surface (layer editor) — recent docs grid if none open
        case 'e': case 'E': setSurface('canvas'); return
        // view modes (library only); each view owns its keys in capture phase
        case 'c':
          if (surface === 'library' && visible.length >= 2) setMode('compare')
          return
        case 'C':
          if (surface === 'library' && visible.length) setMode('cull')
          return
        case 'n': case 'N':
          if (surface === 'library' && visible.length) setMode('survey')
          return
        case 'Enter':
          if (sel && !(t instanceof Element && t.closest('button'))) { e.preventDefault(); openFor(sel) }
          return
        case 'o': case 'O': fileRef.current?.click(); return
        case 'ArrowLeft': e.preventDefault(); nav(-1); return
        case 'ArrowRight': e.preventDefault(); nav(1); return
        case 'ArrowUp': e.preventDefault(); nav(surface === 'library' ? -v.gridCols : -1); return
        case 'ArrowDown': e.preventDefault(); nav(surface === 'library' ? v.gridCols : 1); return
        case '+': case '=': bumpThumb(1); return
        case '-': case '_': bumpThumb(-1); return
        case 'p': case 'P': for (const id of ids) setMeta(id, { flag: 1 }); return
        case 'x': case 'X': for (const id of ids) setMeta(id, { flag: -1 }); return
        case 'u': case 'U': for (const id of ids) setMeta(id, { flag: 0 }); return
        case 'j': case 'J': if (surface === 'develop') toggleClipOverlay(); return
        case 'v': case 'V': {
          if (surface !== 'develop') return
          const doc = getEditState().doc
          if (doc) commitParam('bw', 'on', getParam(doc, 'bw', 'on') ? 0 : 1)
          return
        }
        case 'r': case 'R':
          // enter only — the crop overlay owns exit (commit/cancel) in capture
          if (surface === 'develop' && getEditState().doc) setCropMode(true)
          return
        case 'm': case 'M':
          // enter masking; exit + ⇧M (radial) are handled by handleMaskKey above
          if (surface === 'develop' && !v.cropMode && getEditState().doc) toggleMaskMode()
          return
        case 'z': case 'Z':
          if (surface === 'develop' && !v.cropMode && getEditState().doc) toggleZoom()
          return
        case '\\': if (surface === 'develop') { e.preventDefault(); toggleBefore() } return
        // lights-out: L cycles normal → dim → black (mask mode owns its L above)
        case 'l': case 'L': cycleLightsOut(); return
        case 'i': case 'I': if (surface === 'develop') cycleInfoOverlay(); return
        case 'Escape': if (getViewState().lightsOut) setLightsOut(0); return
        case '?': e.preventDefault(); setOverlay('cheatsheet'); return
        case '/':
          if (surface === 'library') { e.preventDefault(); focusSearch() }
          return
        case 'Delete': case 'Backspace':
          // library-only: develop's ⌫ belongs to masks (handled above)
          if (surface === 'library' && ids.length) { e.preventDefault(); requestDelete(ids) }
          return
      }
      if (/^[0-5]$/.test(e.key)) {
        for (const id of ids) setMeta(id, { rating: +e.key })
        return
      }
      const color = COLOR_KEYS[e.key]
      if (color) {
        for (const id of ids) {
          const p = photos.find((q) => q.id === id)
          setMeta(id, { colorLabel: p?.colorLabel === color ? null : color })
        }
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [openFor, pasteSettings, focusSearch, requestDelete])

  return (
    <div
      className="shell"
      data-surface={surface}
      data-lights={lightsOut === 1 ? 'dim' : lightsOut === 2 ? 'out' : undefined}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        // canvas surface: an image drop becomes a new doc (or a new layer)
        if (getViewState().surface === 'canvas')
          dropImageFiles(e.dataTransfer.files).catch((err) => console.error('[canvas drop]', err))
        else doImport(e.dataTransfer.files)
      }}
    >
      <header className="topbar">
        <span className="wordmark">albedo</span>
        <span className="topbar-sep" aria-hidden="true" />
        <span className="topbar-file mono">
          {surface === 'develop' ? photo?.name ?? ''
            : surface === 'canvas' ? cvDoc?.name ?? ''
            : selPhoto?.name ?? ''}
        </span>
        <nav className="seg surface-seg" role="tablist" aria-label="Surface">
          <span className="seg-thumb" aria-hidden="true" />
          <button
            role="tab"
            aria-selected={surface === 'library'}
            className={`seg-btn${surface === 'library' ? ' is-on' : ''}`}
            data-tip="Library" data-tip-key="G"
            onClick={() => setSurface('library')}
          >Library</button>
          <button
            role="tab"
            aria-selected={surface === 'develop'}
            className={`seg-btn${surface === 'develop' ? ' is-on' : ''}`}
            data-tip="Develop" data-tip-key="D"
            disabled={!selPhoto && !photo}
            onClick={() => (selPhoto ? openFor(selPhoto) : setSurface('develop'))}
          >Develop</button>
          <button
            role="tab"
            aria-selected={surface === 'canvas'}
            className={`seg-btn${surface === 'canvas' ? ' is-on' : ''}`}
            data-tip="Canvas" data-tip-key="E"
            onClick={() => setSurface('canvas')}
          >Canvas</button>
        </nav>
        <span className="topbar-flex" aria-hidden="true" />
        {importing && (
          <span className="topbar-import mono">importing {importing.done}/{importing.total}</span>
        )}
        {surface === 'develop' && photo && (
          <button
            type="button"
            className="topbar-zoom mono"
            data-tip="Zoom 100% / fit" data-tip-key="Z"
            onClick={toggleZoom}
          >
            {zoom === 'fit' ? 'FIT' : zoom === 2 ? '200%' : '100%'}
          </button>
        )}
        <span className="topbar-sep" aria-hidden="true" />
        <button
          type="button"
          className="icon-btn theme-toggle"
          data-tip={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? (
            // sun — invite to daylight
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M7 0.5v2M7 11.5v2M0.5 7h2M11.5 7h2M2.4 2.4l1.4 1.4M10.2 10.2l1.4 1.4M11.6 2.4l-1.4 1.4M3.8 10.2l-1.4 1.4"
                stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : (
            // moon — back to the darkroom
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M11.8 8.6A5.3 5.3 0 0 1 5.4 2.2a5.3 5.3 0 1 0 6.4 6.4z"
                fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <span className="topbar-backend mono">{backend ?? ''}</span>
        {importing && (
          <span
            className="import-line"
            style={{ transform: `scaleX(${importing.total ? importing.done / importing.total : 0})` }}
            aria-hidden="true"
          />
        )}
      </header>

      <main className="surface">
        {/* canvas must stay mounted: its control transfers to the worker once */}
        <div className={surface === 'develop' ? 'fill' : 'hidden'}>
          <Develop canvasRef={canvasRef} />
        </div>
        <div className={surface === 'library' && !catalogEmpty ? 'fill' : 'hidden'}>
          <Library
            photos={photos}
            visible={visible}
            filter={filter}
            onOpen={openFor}
            onMenu={onCellMenu}
            onClearRejects={clearRejects}
          />
        </div>
        {/* canvas display element also stays mounted: its control transfers once */}
        <div className={surface === 'canvas' ? 'fill' : 'hidden'}>
          <CanvasSurface
            canvasRef={cvCanvasRef}
            active={surface === 'canvas' && !overlay && !confirm}
          />
        </div>
        {catalogEmpty && surface !== 'canvas' && (
          <div className={`dropzone${dragOver ? ' is-over' : ''}`}>
            <button className="dropzone-frame" onClick={() => fileRef.current?.click()}>
              <p className="dropzone-hero">Drop photos here</p>
              <p className="dropzone-sub">or press O to open — JPEG, PNG or RAW</p>
            </button>
            <p className="dropzone-privacy">Everything stays on this machine.</p>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => { doImport(e.target.files); e.target.value = '' }}
        />
      </main>

      {!catalogEmpty && surface !== 'canvas' && (
        <Filmstrip photos={visible} onOpen={openFor} onMenu={onCellMenu} />
      )}

      {overlay === 'palette' && <Palette onClose={() => setOverlay(null)} />}
      {overlay === 'cheatsheet' && <CheatSheet onClose={() => setOverlay(null)} />}
      {overlay === 'copy' && <CopyDialog onClose={() => setOverlay(null)} />}
      {overlay === 'export' && <ExportDialog onClose={() => setOverlay(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={`Remove ${confirm.ids.length === 1 ? 'this photo' : `${confirm.ids.length} photos`} from albedo? ` +
            "Files and edits are removed from the app's storage. This cannot be undone."}
          confirmLabel="Delete"
          onConfirm={() => runDelete(confirm.ids)}
          onClose={() => setConfirm(null)}
        />
      )}
      <ContextMenuHost />
      <ToastHost />
      <TooltipHost />
    </div>
  )
}
