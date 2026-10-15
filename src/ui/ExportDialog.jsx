import { useEffect, useRef, useState } from 'react'
import Slider from './Slider.jsx'
import { getState as getEditState } from '../state/editStore.js'
import { getViewState } from '../state/viewStore.js'
import { getCatalogState, loadOriginal, loadDoc } from '../state/catalogStore.js'
import { exportPhoto, openPhoto } from '../state/renderClient.js'
import { decode } from '../state/decodeClient.js'
import { openInDevelop } from '../state/openPhoto.js'
import { newEditDoc } from '../engine/editdoc.js'
import { exifApp1 } from '../io/exif.js'
import { writeXmp } from '../io/xmpWrite.js'
import { encodeRawDng, colorMatrixFromCamToSrgb, asShotNeutralFromCamMul } from '../io/dng.js'
import {
  resizeToLongEdge, filenameFor, stripOutputSharpen, pickExportDir, saveBlob,
  applyWatermark, attachExif,
} from '../io/exportUtil.js'

// ⌘E export dialog. Develop = the current photo + doc as rendered; Library =
// every selected photo through the same single-photo pipeline, sequentially
// (decode → open → export hijacks the render worker; the previously open
// photo is restored at the end). Post-pipeline, per file: resize → watermark
// → EXIF splice (JPEG re-attaches the original's APP1, orientation stripped).
// Settings persist as 'last used' and as named presets (localStorage).

const EDGES = [
  { id: 'off', label: 'Off' },
  { id: '2048', label: '2048' },
  { id: '3840', label: '3840' },
  { id: 'custom', label: 'Custom' },
]

const CORNERS = [
  { id: 'nw', label: '↖' }, { id: 'ne', label: '↗' }, { id: 'c', label: '·' },
  { id: 'sw', label: '↙' }, { id: 'se', label: '↘' },
]
const WM_SIZES = [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }]

const LAST_KEY = 'albedo.export.last'
const PRESETS_KEY = 'albedo.export.presets'
const loadJSON = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
const storeJSON = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* private mode */ }
}

export default function ExportDialog({ onClose }) {
  // static reads: the dialog is modal + short-lived (CopyDialog pattern)
  const [targets] = useState(() => {
    const v = getViewState()
    const es = getEditState()
    const cat = getCatalogState()
    const pick = (p, live) => ({
      id: p.id, name: p.name, isRaw: p.isRaw ?? false, live,
      takenAt: p.takenAt ?? null, importedAt: p.importedAt ?? null, rating: p.rating ?? 0,
      flag: p.flag ?? 0, colorLabel: p.colorLabel ?? null, title: p.title ?? null,
      caption: p.caption ?? null, keywords: p.keywords ?? [],
    })
    if (v.surface === 'develop' && es.photo && es.doc) {
      const rec = cat.photos.find((p) => p.id === es.photo.id)
      return [pick(rec ?? { id: es.photo.id, name: es.photo.name }, true)]
    }
    const ids = v.selection.size ? [...v.selection] : v.selectedId != null ? [v.selectedId] : []
    return ids
      .map((id) => cat.photos.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => pick(p, false))
  })
  const batch = targets.length > 1 || !targets[0]?.live

  // 'last used' settings restore on open; presets overlay on top
  const [last] = useState(() => loadJSON(LAST_KEY, null))
  const [fmt, setFmt] = useState(last?.fmt ?? 'jpeg')
  const [quality, setQuality] = useState(last?.quality ?? 92)
  const [edge, setEdge] = useState(last?.edge ?? 'off')
  const [customPx, setCustomPx] = useState(last?.customPx ?? '1600')
  const [pattern, setPattern] = useState(last?.pattern ?? '{name}-albedo')
  const [sharpen, setSharpen] = useState(last?.sharpen ?? true)
  const [sidecar, setSidecar] = useState(last?.sidecar ?? false)
  const [wmOn, setWmOn] = useState(last?.wmOn ?? false)
  const [wmText, setWmText] = useState(last?.wmText ?? `© ${new Date().getFullYear()}`)
  const [wmCorner, setWmCorner] = useState(last?.wmCorner ?? 'se')
  const [wmSize, setWmSize] = useState(last?.wmSize ?? 'm')
  const [presets, setPresets] = useState(() => loadJSON(PRESETS_KEY, []))
  const [presetSel, setPresetSel] = useState('')
  const [naming, setNaming] = useState(false)
  const [run, setRun] = useState(null) // { done, total, name } | null
  const cancelled = useRef(false)
  const running = useRef(false)

  const longEdge = edge === 'off' ? 0
    : edge === 'custom' ? Math.max(0, parseInt(customPx, 10) || 0)
    : parseInt(edge, 10)
  // rendered formats, or the capture itself: DNG (RAW mosaic + the edit as
  // XMP inside) and the untouched original; both keep every edit portable
  const rendered = fmt === 'jpeg' || fmt === 'png' || fmt === 'tiff'
  const extOf = (t) => fmt === 'png' ? 'png' : fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : fmt === 'dng' ? 'dng'
    : (t?.name?.match(/\.([^.]+)$/)?.[1] ?? 'raw').toLowerCase()
  const ext = extOf(targets[0])

  const currentSettings = () => ({
    fmt, quality, edge, customPx, pattern, sharpen, wmOn, wmText, wmCorner, wmSize, sidecar,
  })
  const applySettings = (s) => {
    if (!s) return
    setFmt(s.fmt ?? 'jpeg')
    setQuality(s.quality ?? 92)
    setEdge(s.edge ?? 'off')
    setCustomPx(s.customPx ?? '1600')
    setPattern(s.pattern ?? '{name}-albedo')
    setSharpen(s.sharpen ?? true)
    setWmOn(s.wmOn ?? false)
    setWmText(s.wmText ?? `© ${new Date().getFullYear()}`)
    setWmCorner(s.wmCorner ?? 'se')
    setWmSize(s.wmSize ?? 'm')
    setSidecar(s.sidecar ?? false)
  }
  const savePreset = (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const next = [...presets.filter((p) => p.name !== trimmed), { name: trimmed, settings: currentSettings() }]
      .sort((a, b) => a.name.localeCompare(b.name))
    setPresets(next)
    storeJSON(PRESETS_KEY, next)
    setPresetSel(trimmed)
    setNaming(false)
  }

  // filename token preview for the first file (what {seq}=001 will produce)
  const first = targets[0]
  const previewName = first
    ? filenameFor(pattern, first.name, ext,
        { seq: 1, date: first.takenAt ?? first.importedAt, rating: first.rating })
    : ''

  const close = () => { cancelled.current = true; onClose() }

  const doExport = async () => {
    if (running.current || !targets.length) return
    running.current = true
    cancelled.current = false
    storeJSON(LAST_KEY, currentSettings())
    const type = fmt === 'png' ? 'image/png' : fmt === 'tiff' ? 'image/tiff' : 'image/jpeg'
    const q = quality / 100
    // a TIFF is sized by the worker itself, at 16 bits
    const opts = { type, quality: q, ...(type === 'image/tiff' && longEdge ? { longEdge } : {}) }
    const wm = wmOn && wmText.trim() ? { text: wmText.trim(), corner: wmCorner, size: wmSize } : null
    const prevOpen = getEditState().photo?.id ?? null
    // two files per photo (or many photos) go into one chosen folder
    const dir = batch || sidecar || fmt === 'original' ? await pickExportDir() : null
    const xmpFor = (t, doc) => writeXmp(doc, {
      filename: t.name, rating: t.rating, flag: t.flag, label: t.colorLabel, title: t.title,
      caption: t.caption, keywords: t.keywords, isRaw: t.isRaw,
    })
    setRun({ done: 0, total: targets.length, name: targets[0].name })
    try {
      for (let i = 0; i < targets.length; i++) {
        if (cancelled.current) break
        const t = targets[i]
        setRun({ done: i, total: targets.length, name: t.name })
        const outName = filenameFor(pattern, t.name, extOf(t),
          { seq: i + 1, date: t.takenAt ?? t.importedAt, rating: t.rating })
        if (!rendered) {
          // the capture itself: no render, no resize, no watermark
          const [{ buffer, name }, saved] = await Promise.all([
            loadOriginal(t.id), t.live ? getEditState().doc : loadDoc(t.id).catch(() => null),
          ])
          const doc = saved ?? newEditDoc(t.id)
          let blob
          if (fmt === 'dng' && t.isRaw) {
            const p = await decode(t.id, buffer, name, 'full')
            if (p.kind !== 'mosaic') throw new Error(`${t.name}: DNG export needs a Bayer RAW`)
            const bytes = encodeRawDng({
              ...p, buffer: p.buffer, cfa: p.cfa,
              colorMatrix1: colorMatrixFromCamToSrgb(p.camToSrgb, p.preMul ?? p.camMul),
              asShotNeutral: asShotNeutralFromCamMul(p.camMul),
              make: p.exif?.make, model: p.exif?.model, uniqueCameraModel: p.exif?.camera,
              orientation: p.flip, exif: p.exif, xmp: xmpFor(t, doc),
            })
            blob = new Blob([bytes], { type: 'image/x-adobe-dng' })
          } else {
            blob = new Blob([buffer])
          }
          await saveBlob(blob, outName, dir)
          if (sidecar || fmt === 'original') {
            const xmp = new Blob([xmpFor(t, doc)], { type: 'application/rdf+xml' })
            await saveBlob(xmp, outName.replace(/\.[^.]+$/, '') + '.xmp', dir)
          }
          setRun({ done: i + 1, total: targets.length, name: t.name })
          continue
        }
        let doc
        let app1 = null // original's Exif APP1 — lifted before decode transfers the buffer
        if (t.live) {
          doc = getEditState().doc
          if (type === 'image/jpeg') {
            try { app1 = exifApp1((await loadOriginal(t.id)).buffer) } catch { /* best-effort */ }
          }
        } else {
          // pipeline hijack: decode + open this photo in the render worker
          const [{ buffer, name }, saved] = await Promise.all([
            loadOriginal(t.id),
            loadDoc(t.id).catch(() => null),
          ])
          if (type === 'image/jpeg') app1 = exifApp1(buffer)
          doc = saved ?? newEditDoc(t.id)
          const source = t.isRaw
            ? await decode(t.id, buffer, name, 'full')
            : await createImageBitmap(new Blob([buffer]))
          await openPhoto(t.id, source, doc)
        }
        const expDoc = sharpen ? doc : stripOutputSharpen(doc, t.isRaw)
        let { blob } = await exportPhoto(t.id, expDoc, opts)
        // the worker renders a long edge itself; these 8-bit canvas steps
        // would throw a TIFF's 16 bits away
        if (longEdge && type !== 'image/tiff') blob = await resizeToLongEdge(blob, longEdge, type, q)
        if (wm && type !== 'image/tiff') blob = await applyWatermark(blob, wm, type, q)
        if (app1) blob = await attachExif(blob, app1)
        await saveBlob(blob, outName, dir)
        if (sidecar) {
          const xmp = new Blob([xmpFor(t, doc)], { type: 'application/rdf+xml' })
          await saveBlob(xmp, outName.replace(/\.[^.]+$/, '') + '.xmp', dir)
        }
        setRun({ done: i + 1, total: targets.length, name: t.name })
      }
    } catch (err) {
      console.error('[export]', err)
    } finally {
      // the batch loop hijacked the render worker — restore the open photo
      if (batch && prevOpen != null) {
        const rec = getCatalogState().photos.find((p) => p.id === prevOpen)
        if (rec) await openInDevelop(rec).catch((err) => console.warn('[export] restore', err))
      }
      running.current = false
      onClose()
    }
  }

  // Enter = export, Escape = cancel — capture, like CopyDialog. Enter inside
  // the quality slider's type-in, a select, or the preset-name field must
  // keep its local meaning instead.
  const runRef = useRef(doExport)
  runRef.current = doExport
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof Element &&
          (e.target.closest('button') || e.target.closest('.slider') ||
           e.target.closest('select') || e.target.closest('.exp-own-keys'))) return
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runRef.current() }
      else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelled.current = true
        if (!running.current) onClose()
      }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [onClose])

  // nothing to export (empty selection) — close instead of a dead dialog
  useEffect(() => { if (!targets.length) onClose() }, [targets, onClose])
  if (!targets.length) return null

  return (
    <div
      className="overlay-scrim scrim-palette"
      onPointerDown={(e) => { if (e.target === e.currentTarget && !run) close() }}
    >
      <div className="exportdlg" role="dialog" aria-label="Export">
        {run ? (
          <>
            <h3 className="panel-header">EXPORTING {Math.min(run.done + 1, run.total)}/{run.total}…</h3>
            <p className="exp-file mono">{run.name}</p>
            <div className="exp-bar" role="progressbar" aria-valuenow={run.done} aria-valuemax={run.total}>
              <span style={{ transform: `scaleX(${run.total ? run.done / run.total : 0})` }} />
            </div>
            <div className="copy-actions">
              <button type="button" className="btn-ghost" onClick={() => { cancelled.current = true }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="panel-header">
              {batch ? `EXPORT ${targets.length} PHOTO${targets.length > 1 ? 'S' : ''}` : 'EXPORT'}
            </h3>
            <div className="exp-row">
              <span className="exp-label">Preset</span>
              <select
                className="sort-select exp-preset"
                aria-label="Export preset"
                value={presetSel}
                onChange={(e) => {
                  setPresetSel(e.target.value)
                  applySettings(presets.find((p) => p.name === e.target.value)?.settings)
                }}
              >
                <option value="">Last used</option>
                {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              {naming ? (
                <input
                  className="exp-input exp-preset-name exp-own-keys"
                  placeholder="Preset name"
                  autoFocus
                  spellCheck={false}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') { e.preventDefault(); savePreset(e.currentTarget.value) }
                    else if (e.key === 'Escape') { e.preventDefault(); setNaming(false) }
                  }}
                  onBlur={(e) => { if (e.target.value.trim()) savePreset(e.target.value); else setNaming(false) }}
                />
              ) : (
                <button type="button" className="btn-ghost exp-preset-save"
                  data-tip="Save the current settings as a preset"
                  onClick={() => setNaming(true)}>Save…</button>
              )}
            </div>
            <div className="exp-row">
              <span className="exp-label">Format</span>
              <div className="exp-seg" role="radiogroup" aria-label="Format">
                <button type="button" className={fmt === 'jpeg' ? 'is-on' : ''} onClick={() => setFmt('jpeg')}>JPEG</button>
                <button type="button" className={fmt === 'png' ? 'is-on' : ''} onClick={() => setFmt('png')}>PNG</button>
                <button type="button" className={fmt === 'tiff' ? 'is-on' : ''}
                  data-tip="16 bits per channel, sRGB" onClick={() => setFmt('tiff')}>TIFF</button>
                <button type="button" className={fmt === 'dng' ? 'is-on' : ''} disabled={!targets.some((t) => t.isRaw)}
                  data-tip="The RAW data as DNG, with the edit inside as XMP" onClick={() => setFmt('dng')}>DNG</button>
                <button type="button" className={fmt === 'original' ? 'is-on' : ''}
                  data-tip="The original file, untouched, with an XMP sidecar" onClick={() => setFmt('original')}>Original</button>
              </div>
            </div>
            <label className="copy-check exp-sidecar-check">
              <input type="checkbox" checked={sidecar || fmt === 'original'} disabled={fmt === 'original'}
                onChange={() => setSidecar(!sidecar)} />
              XMP sidecar (Lightroom, Camera Raw, darktable)
            </label>
            {fmt === 'jpeg' && (
              <Slider
                label="Quality"
                min={60}
                max={100}
                step={1}
                defaultValue={92}
                value={quality}
                onPreview={setQuality}
                onCommit={setQuality}
              />
            )}
            {rendered && (
            <div className="exp-row">
              <span className="exp-label">Long edge</span>
              <div className="exp-seg" role="radiogroup" aria-label="Long edge">
                {EDGES.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={edge === o.id ? 'is-on' : ''}
                    onClick={() => setEdge(o.id)}
                  >{o.label}</button>
                ))}
              </div>
              {edge === 'custom' && (
                <>
                  <input
                    className="exp-input exp-px mono"
                    value={customPx}
                    inputMode="numeric"
                    onChange={(e) => setCustomPx(e.target.value.replace(/\D/g, ''))}
                  />
                  <span className="exp-unit mono">px</span>
                </>
              )}
            </div>
            )}
            <div className="exp-row">
              <span className="exp-label">Filename</span>
              <input
                className="exp-input exp-name mono"
                value={pattern}
                spellCheck={false}
                data-tip="Tokens: {name} {seq} {date} {rating}"
                onChange={(e) => setPattern(e.target.value)}
              />
            </div>
            <p className="exp-preview mono" aria-label="Filename preview">→ {previewName}</p>
            {rendered && (
              <>
            {fmt !== 'tiff' && (
            <label className="copy-check exp-wm-check">
              <input type="checkbox" checked={wmOn} onChange={() => setWmOn(!wmOn)} />
              Watermark
            </label>
            )}
            {wmOn && (
              <>
                <div className="exp-row">
                  <span className="exp-label">Text</span>
                  <input
                    className="exp-input exp-wmtext mono"
                    value={wmText}
                    spellCheck={false}
                    onChange={(e) => setWmText(e.target.value)}
                  />
                </div>
                <div className="exp-row">
                  <span className="exp-label">Position</span>
                  <div className="exp-seg exp-corners" role="radiogroup" aria-label="Watermark position">
                    {CORNERS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        aria-label={`Corner ${o.id}`}
                        className={wmCorner === o.id ? 'is-on' : ''}
                        onClick={() => setWmCorner(o.id)}
                      >{o.label}</button>
                    ))}
                  </div>
                  <div className="exp-seg" role="radiogroup" aria-label="Watermark size">
                    {WM_SIZES.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className={wmSize === o.id ? 'is-on' : ''}
                        onClick={() => setWmSize(o.id)}
                      >{o.label}</button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <label className="copy-check exp-sharpen">
              <input type="checkbox" checked={sharpen} onChange={() => setSharpen(!sharpen)} />
              Output sharpen
            </label>
              </>
            )}
            <div className="copy-actions">
              <button type="button" className="btn-ghost" onClick={close}>Cancel</button>
              <button
                type="button"
                className="btn-primary"
                disabled={longEdge === 0 && edge === 'custom'}
                onClick={doExport}
              >Export ↵</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
