import { useState, useEffect, useRef } from 'react'
import PanelSection from './PanelSection.jsx'
import { useCatalog, setTextMeta, backupCatalog, restoreCatalog, saveDocNow, loadDoc } from '../state/catalogStore.js'
import { useViewState } from '../state/viewStore.js'

// Library right panel: file info + EXIF for the selection, editable
// title/caption, and a keyword token input. Batch-aware: title/caption show
// 'Mixed' when values differ (typing overwrites all); keyword chips carried by
// only part of the selection render half-lit and still add/remove across the
// whole selection. Collapses to a 4px rib (navigator pattern), persisted.

const KEY = 'albedo.metapanel'

// e2e hook — the library-wave twin of window.__albedo (App owns that object)
if (typeof window !== 'undefined') {
  window.__albedoMeta = { setTextMeta, backupCatalog, restoreCatalog, saveDocNow, loadDoc }
}

const fmtBytes = (b) => b == null ? '—'
  : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB`
  : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`
const fmtShutter = (s) => s == null ? null : s >= 1 ? `${+s.toFixed(1)}s` : `1/${Math.round(1 / s)}s`
const fmtDate = (t) => t == null ? '—' : new Date(t).toLocaleString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

const MIXED = Symbol('mixed')
const uniform = (sel, pick) => {
  if (!sel.length) return null
  const v0 = pick(sel[0]) ?? null
  return sel.every((p) => (pick(p) ?? null) === v0) ? v0 : MIXED
}

function Row({ k, v }) {
  if (v == null || v === '') return null
  return (
    <div className="meta-row">
      <span className="meta-k">{k}</span>
      <span className="meta-v mono">{v === MIXED ? 'mixed' : v}</span>
    </div>
  )
}

// controlled text field re-seeded per selection; commit on blur/Enter
function TextField({ id, value, placeholder, multiline, onCommit }) {
  const [text, setText] = useState(value === MIXED ? '' : value ?? '')
  useEffect(() => { setText(value === MIXED ? '' : value ?? '') }, [value, id])
  const commit = () => {
    const v = text.trim()
    if (value === MIXED ? v === '' : v === (value ?? '')) return // no-op edit
    onCommit(v)
  }
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      className={`meta-input${multiline ? ' meta-area' : ''}`}
      value={text}
      rows={multiline ? 3 : undefined}
      placeholder={value === MIXED ? 'Mixed' : placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation() // the app keyboard router must never see these
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); commit(); e.currentTarget.blur() }
        else if (e.key === 'Escape') { setText(value === MIXED ? '' : value ?? ''); e.currentTarget.blur() }
      }}
    />
  )
}

export default function MetadataPanel() {
  const { photos } = useCatalog()
  const { selectedId, selection } = useViewState()
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(KEY) === '0' } catch { return false }
  })
  const kwRef = useRef(null)

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(KEY, next ? '0' : '1') } catch { /* private mode */ }
  }

  if (collapsed) {
    return (
      <button
        className="metapanel is-rib"
        title="Expand metadata panel"
        aria-label="Expand metadata panel"
        onClick={toggle}
      />
    )
  }

  const ids = selection.size ? [...selection] : selectedId != null ? [selectedId] : []
  const sel = ids.map((id) => photos.find((p) => p.id === id)).filter(Boolean)
  const one = sel.length === 1 ? sel[0] : null
  const selKey = ids.join(',')

  // keyword → how many of the selection carry it
  const kwCounts = new Map()
  for (const p of sel) for (const k of p.keywords ?? []) kwCounts.set(k, (kwCounts.get(k) ?? 0) + 1)
  const chips = [...kwCounts].sort((a, b) => a[0].localeCompare(b[0]))

  const addKeyword = () => {
    const v = kwRef.current?.value.trim()
    if (!v || !sel.length) return
    setTextMeta(ids, { addKeywords: [v] })
    kwRef.current.value = ''
  }

  const title = uniform(sel, (p) => p.title)
  const caption = uniform(sel, (p) => p.caption)

  return (
    <aside className="metapanel" aria-label="Metadata">
      <div className="meta-head">
        <button className="nav-fold meta-fold" data-tip="Collapse metadata panel"
          aria-label="Collapse metadata panel" onClick={toggle}>
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2.5 0.8L6 4l-3.5 3.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <span className="panel-header">Metadata</span>
        {sel.length > 1 && <span className="meta-count mono">{sel.length} selected</span>}
      </div>
      <div className="meta-scroll">
        {sel.length === 0 ? (
          <p className="nav-none">Select a photo</p>
        ) : (
          <>
            <PanelSection id="meta-file" title="File">
              <div className="meta-rows">
                {one ? (
                  <>
                    <Row k="Name" v={one.name} />
                    <Row k="Format" v={`${(one.ext ?? '').toUpperCase()}${one.isRaw ? ' (RAW)' : ''}`} />
                    <Row k="Size" v={fmtBytes(one.bytes)} />
                    <Row k="Pixels" v={one.width && one.height ? `${one.width} × ${one.height}` : null} />
                    <Row k="Captured" v={fmtDate(one.takenAt)} />
                    <Row k="Imported" v={fmtDate(one.importedAt)} />
                  </>
                ) : (
                  <>
                    <Row k="Photos" v={String(sel.length)} />
                    <Row k="Total size" v={fmtBytes(sel.reduce((n, p) => n + (p.bytes ?? 0), 0))} />
                  </>
                )}
              </div>
            </PanelSection>
            <PanelSection id="meta-exif" title="EXIF">
              <div className="meta-rows">
                <Row k="Camera" v={uniform(sel, (p) => p.camera)} />
                <Row k="Lens" v={uniform(sel, (p) => p.lens)} />
                <Row k="ISO" v={uniform(sel, (p) => p.iso)} />
                <Row k="Shutter" v={(() => { const v = uniform(sel, (p) => p.shutter); return v === MIXED ? v : fmtShutter(v) })()} />
                <Row k="Aperture" v={(() => { const v = uniform(sel, (p) => p.aperture); return v === MIXED ? v : v != null ? `ƒ/${v}` : null })()} />
                <Row k="Focal" v={(() => { const v = uniform(sel, (p) => p.focal); return v === MIXED ? v : v != null ? `${+(+v).toFixed(1)}mm` : null })()} />
                {one && !one.camera && !one.lens && one.iso == null && one.shutter == null &&
                  one.aperture == null && one.focal == null && (
                  <p className="nav-none">No EXIF in this file</p>
                )}
              </div>
            </PanelSection>
            <PanelSection id="meta-text" title="Title & Caption">
              <div className="meta-rows">
                <TextField id={`t-${selKey}`} value={title} placeholder="Add a title…"
                  onCommit={(v) => setTextMeta(ids, { title: v })} />
                <TextField id={`c-${selKey}`} value={caption} placeholder="Add a caption…" multiline
                  onCommit={(v) => setTextMeta(ids, { caption: v })} />
              </div>
            </PanelSection>
            <PanelSection id="meta-kw" title="Keywords">
              <div className="kw-wrap">
                {chips.map(([kw, n]) => (
                  <span key={kw} className={`kw-chip${n < sel.length ? ' is-mixed' : ''}`}
                    title={n < sel.length ? `On ${n} of ${sel.length} selected` : undefined}>
                    {kw}
                    <button className="kw-x" aria-label={`Remove keyword ${kw}`}
                      onClick={() => setTextMeta(ids, { removeKeywords: [kw] })}>×</button>
                  </span>
                ))}
                <input
                  ref={kwRef}
                  className="kw-input mono"
                  placeholder={chips.length ? 'Add keyword…' : 'Type + Enter to tag…'}
                  spellCheck={false}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') { e.preventDefault(); addKeyword() }
                    else if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur() }
                  }}
                />
              </div>
            </PanelSection>
          </>
        )}
      </div>
    </aside>
  )
}
