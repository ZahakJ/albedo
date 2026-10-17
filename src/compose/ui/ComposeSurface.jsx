import { useRef, useEffect, useState, useCallback } from 'react'
import LayersPanel from './LayersPanel.jsx'
import PropertiesPanel from './PropertiesPanel.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import StartScreen from './StartScreen.jsx'
import OptionsBar from './OptionsBar.jsx'
import { Icon } from './icons.jsx'
import { TOOLS, toolById, toolForKey } from './tools/index.js'
import {
  useCompose, getCompose, setStage, setView, fit, zoomAt, actualPixels, toDoc,
  setTool, undo, redo, op, swapColors, resetColors, setColors, saveDocument, closeDocument, refreshDocs, setPaintTarget,
} from '../../state/composeClient.js'
import { Swatch } from './PropertiesPanel.jsx'
import { openExport } from './ExportMenu.jsx'
import { toast } from '../../state/toastStore.js'

// COMPOSE — the layered editor. Tool rail on the left, the stage (drawn by
// the render worker at view resolution) in the middle, Properties, Layers
// and History on the right. Keys follow Photoshop's.

export default function ComposeSurface({ canvasRef, active }) {
  const st = useCompose()
  const { doc, tool, view, ready, error } = st
  const stageRef = useRef(null)
  const sess = useRef(null)
  const [space, setSpace] = useState(false)
  const [hover, setHover] = useState(null) // pointer in stage px
  const [, force] = useState(0)
  const T = toolById(space ? 'hand' : tool)

  // stage size → worker
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const push = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 2) return
      const bg = getComputedStyle(el).backgroundColor.match(/\d+/g)?.slice(0, 3).map((v) => v / 255)
      setStage(r.width, r.height, bg)
    }
    const obs = new ResizeObserver(push)
    obs.observe(el)
    push()
    return () => obs.disconnect()
  }, [ready])
  useEffect(() => { if (doc && view.fitted) fit() }, [doc?.id, doc?.width, doc?.height])
  useEffect(() => { if (active && !doc) refreshDocs().catch(() => {}) }, [active, doc?.id])

  // ── keys ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    const onKey = (e) => {
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select, [contenteditable="true"]'))) return
      const k = e.key
      const mod = e.metaKey || e.ctrlKey
      const s = getCompose()
      const handled = () => { e.preventDefault(); e.stopPropagation() }
      if (mod) {
        if (k === 'z' || k === 'Z') { handled(); (e.shiftKey ? redo : undo)(); return }
        if (k === 'y') { handled(); redo(); return }
        if (!s.doc) return
        if (k === '0') { handled(); fit(); return }
        if (k === '1') { handled(); actualPixels(); return }
        if (k === '=' || k === '+') { handled(); zoomAt(1.25, stageW() / 2, stageH() / 2); return }
        if (k === '-') { handled(); zoomAt(0.8, stageW() / 2, stageH() / 2); return }
        if (k === 'j' || k === 'J') { handled(); op('duplicate', {}); return }
        if ((k === 'g' || k === 'G') && e.altKey) { handled(); const n = activeNode(); if (n) op('props', { nodeId: n.id, patch: { clip: !n.clip }, label: 'Clipping Mask' }); return }
        if (k === 'g' || k === 'G') { handled(); e.shiftKey ? op('ungroup', {}) : op('group', {}); return }
        if (k === 'e' || k === 'E') {
          handled()
          if (e.shiftKey && e.altKey) op('stampVisible')
          else if (e.shiftKey) op('mergeVisible')
          else op('mergeDown', {})
          return
        }
        if ((k === 'n' || k === 'N') && e.shiftKey) { handled(); op('addLayer', { kind: 'pixel' }); return }
        if (k === 's' || k === 'S') { handled(); saveDocument().then(() => toast('Saved')); return }
        if (k === 'a' || k === 'A') { handled(); op('selectAll'); return }
        if (k === 'd' || k === 'D') { handled(); e.shiftKey ? op('reselect') : op('deselect'); return }
        if ((k === 'i' || k === 'I') && e.shiftKey) { handled(); op('invertSelection'); return }
        if (k === 'i' || k === 'I') { handled(); invertActive(); return }
        if (k === 't' || k === 'T') { handled(); setTool('transform'); return }
        if (k === 'u' || k === 'U') { handled(); op('addAdjust', { type: 'huesat' }); return }
        if (k === 'm' || k === 'M') { handled(); op('addAdjust', { type: 'curves' }); return }
        if (k === 'l' || k === 'L') { handled(); op('addAdjust', { type: 'levels' }); return }
        if (k === 'Backspace' || k === 'Delete') { handled(); op('fillSelection', { color: s.bg }); return }
        if (k === 'w' || k === 'W') { handled(); closeDocument(); return }
        if (k === '[' || k === ']') { handled(); moveActive(k === ']' ? 1 : -1, e.shiftKey); return }
        return
      }
      if (!s.doc) return
      if (e.altKey && (k === 'Backspace' || k === 'Delete')) { handled(); op('fillSelection', { color: s.fg }); return }
      if (k === 'Backspace' || k === 'Delete') { handled(); op('clearSelection'); return }
      if (k === 'Escape') { if (T?.cancel?.()) { handled(); return } }
      if (k === 'Enter') { if (T?.commit?.()) { handled(); return } }
      if (k === 'x' || k === 'X') { handled(); swapColors(); return }
      if (k === 'd' || k === 'D') { handled(); resetColors(); return }
      if (k === '[' || k === ']') { handled(); T?.bracket?.(k === ']' ? 1 : -1, e.shiftKey); return }
      if (/^[0-9]$/.test(k)) {
        handled()
        const v = k === '0' ? 1 : Number(k) / 10
        const n = activeNode()
        if (T?.opacityKey) T.opacityKey(v)
        else if (n) op('props', { nodeId: n.id, patch: { opacity: v }, label: 'Opacity' })
        return
      }
      if (k === '\\') { handled(); setPaintTarget(s.paintTarget === 'mask' ? 'pixels' : 'mask'); return }
      const nt = toolForKey(k, e.shiftKey, tool)
      if (nt) { handled(); setTool(nt); return }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [active, tool, T])

  useEffect(() => {
    if (!active) { setSpace(false); return }
    const down = (e) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      e.preventDefault()
      setSpace(true)
    }
    const up = (e) => { if (e.code === 'Space') setSpace(false) }
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up) }
  }, [active])

  const stageW = () => stageRef.current?.getBoundingClientRect().width ?? 0
  const stageH = () => stageRef.current?.getBoundingClientRect().height ?? 0
  const activeNode = () => {
    const d = getCompose().doc
    if (!d?.activeId) return null
    let hit = null
    const walk = (l) => { for (const n of l) { if (n.id === d.activeId) hit = n; if (n.children) walk(n.children) } }
    walk(d.nodes)
    return hit
  }
  const invertActive = () => op('addAdjust', { type: 'invert' })
  const moveActive = (dir, extreme) => {
    const d = getCompose().doc
    const n = activeNode()
    if (!n) return
    const find = (l, parent = null) => { for (let i = 0; i < l.length; i++) { if (l[i].id === n.id) return { list: l, i, parent }; if (l[i].children) { const r = find(l[i].children, l[i]); if (r) return r } } return null }
    const h = find(d.nodes)
    if (!h) return
    const to = extreme ? (dir > 0 ? h.list.length : 0) : Math.max(0, Math.min(h.list.length, h.i + (dir > 0 ? 2 : -1)))
    op('move', { nodeId: n.id, parentId: h.parent?.id ?? null, index: to })
  }

  // ── pointer on the stage ─────────────────────────────────────────────────
  const local = (e) => {
    const r = stageRef.current.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const ctx = (e) => {
    const [sx, sy] = local(e)
    const [dx, dy] = toDoc(sx, sy)
    return { e, sx, sy, dx, dy, pressure: e.pointerType === 'mouse' ? 1 : (e.pressure || 0.5), tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0, doc: getCompose().doc, state: getCompose(), redraw: () => force((n) => n + 1) }
  }
  const onDown = (e) => {
    if (!doc) return
    if (e.button === 1 || (e.button === 0 && space)) {
      sess.current = { pan: true, x0: e.clientX, y0: e.clientY, ox: view.offX, oy: view.offY }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    sess.current = { tool: T }
    T?.down?.(ctx(e))
  }
  const onMove = (e) => {
    const [sx, sy] = local(e)
    setHover([sx, sy])
    const s = sess.current
    if (!s) { T?.hover?.(ctx(e)); return }
    if (s.pan) { setView({ offX: s.ox + e.clientX - s.x0, offY: s.oy + e.clientY - s.y0, fitted: false }); return }
    // coalesced events carry every sample of a fast stroke
    const evs = e.getCoalescedEvents?.() ?? [e]
    for (const ev of evs.length ? evs : [e]) s.tool?.move?.(ctx(ev))
  }
  const onUp = (e) => {
    const s = sess.current
    sess.current = null
    if (!s || s.pan) return
    s.tool?.up?.(ctx(e))
  }
  const onWheel = useCallback((e) => {
    if (!getCompose().doc) return
    e.preventDefault()
    const r = stageRef.current.getBoundingClientRect()
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    if (e.ctrlKey || e.metaKey || e.altKey) {
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002)), cx, cy)
    } else {
      const v = getCompose().view
      setView({ offX: v.offX - (e.shiftKey ? e.deltaY : e.deltaX), offY: v.offY - (e.shiftKey ? 0 : e.deltaY), fitted: false })
    }
  }, [])
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  const cursor = !doc ? '' : space ? 'grab' : T?.cursor?.(st) ?? 'default'
  const zoomPct = Math.round(view.zoom * devicePixelRatio * 100)

  return (
    <div className="compose" data-active={active ? '1' : undefined}>
      <OptionsBar />
      <div className="compose-body">
        <nav className="co-rail" aria-label="Tools">
          {TOOLS.filter((t) => !t.hidden).map((t) => (
            <button
              key={t.id}
              type="button"
              className={`co-tool${tool === t.id || t.group?.includes(tool) ? ' is-on' : ''}`}
              data-tool={t.id}
              aria-pressed={tool === t.id}
              data-tip={t.label}
              data-tip-key={t.key?.toUpperCase()}
              disabled={!doc}
              onClick={() => setTool(t.group?.includes(tool) ? tool : t.id)}
            ><Icon name={t.icon} /></button>
          ))}
          <div className="co-rail-gap" />
          <div className="co-colors" aria-label="Colours">
            <span className="co-color-bg"><Swatch color={st.bg} label="Background colour" onChange={(bg) => setColors({ bg })} /></span>
            <span className="co-color-fg"><Swatch color={st.fg} label="Foreground colour" onChange={(fg) => setColors({ fg })} /></span>
            <button type="button" className="co-color-swap" data-tip="Swap colours" data-tip-key="X" onClick={swapColors}><Icon name="swap" size={10} /></button>
            <button type="button" className="co-color-reset" data-tip="Default colours" data-tip-key="D" onClick={resetColors}><Icon name="reset" size={9} /></button>
          </div>
        </nav>
        <div
          className="co-stage"
          ref={stageRef}
          data-cursor={cursor}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => setHover(null)}
          onContextMenu={(e) => { if (T?.menu) { e.preventDefault(); T.menu(ctx(e)) } }}
        >
          <canvas ref={canvasRef} className="co-view" />
          {doc && T?.Overlay && <T.Overlay hover={hover} state={st} />}
          {doc && <SelectionAnts sel={st.selection} view={view} />}
          {!doc && ready && <StartScreen />}
          {error && (
            <div className="co-error">
              <p className="co-error-hero">Compose needs WebGPU</p>
              <p className="co-hint">{error}. Chrome, Edge, Safari 26 and Firefox 141 or later have it; on Linux, Chrome needs it enabled under chrome://flags.</p>
            </div>
          )}
          {doc && (
            <div className="co-status mono" aria-live="off">
              <button type="button" className="co-zoom" data-tip="Fit (⌘0) · 100% (⌘1)" onClick={() => (st.view.fitted ? actualPixels() : fit())}>{zoomPct}%</button>
              <span>{doc.width} × {doc.height}</span>
              <span>{doc.depth}-bit</span>
              {st.stats && <span data-tip="GPU memory held by this document and its history">{(st.stats.vram / 2 ** 20).toFixed(0)} MB</span>}
              <button type="button" className="co-export-btn" onClick={(e) => openExport(e)}>Export</button>
            </div>
          )}
        </div>
        <aside className="co-panel" aria-label="Compose panels">
          {doc ? (
            <>
              <div className="co-props-wrap"><PropertiesPanel /></div>
              <div className="co-layers-wrap"><LayersPanel /></div>
              <HistoryPanel />
            </>
          ) : <div className="co-panel-empty" />}
        </aside>
      </div>
    </div>
  )
}

// marching ants: the selection's outline (document px), drawn in SVG
function SelectionAnts({ sel, view }) {
  if (!sel?.outline) return null
  return (
    <svg className="co-overlay" aria-hidden="true">
      <g transform={`translate(${view.offX} ${view.offY}) scale(${view.zoom})`}>
        <path className="ants ants-under" d={sel.outline} />
        <path className="ants ants-over" d={sel.outline} />
      </g>
    </svg>
  )
}
