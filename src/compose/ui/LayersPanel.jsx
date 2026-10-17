import { useRef, useState, useEffect } from 'react'
import { BLEND_MODES, BLEND_GROUP_ENDS, ADJUSTMENTS, STYLE_DEFAULTS, adjustLabel, findNode } from '../model.js'
import { useCompose, thumbs, op, preview } from '../../state/composeClient.js'
import { openContextMenu } from '../../ui/ContextMenu.jsx'
import { Icon } from './icons.jsx'

// LAYERS — Photoshop's stack, top first. Groups indent and fold; a clipped
// layer shows the hook into the layer below. Drag a row to reorder; drop on
// the middle of a group's row to move into it. Blend mode, opacity and fill
// for the active layer sit above the list; the action strip below.

function Thumb({ id, which, gen, kind }) {
  const ref = useRef(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    const b = thumbs.get(`${id}/${which}`)
    if (b) {
      const s = Math.min(c.width / b.width, c.height / b.height)
      const w = b.width * s, h = b.height * s
      ctx.drawImage(b, (c.width - w) / 2, (c.height - h) / 2, w, h)
    }
  }, [id, which, gen])
  return <canvas ref={ref} className={`co-thumb co-thumb-${which}`} data-kind={kind} width="48" height="36" aria-hidden="true" />
}

const KIND_ICON = { adjust: 'adjust', group: 'folder', text: 'text', shape: 'shape', fill: 'fill', smart: 'smart' }

// flatten the tree to display rows (top first) with depth
function rowsOf(nodes, depth = 0, out = []) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    out.push({ n, depth, parentList: nodes, index: i })
    if (n.kind === 'group' && !n.collapsed) rowsOf(n.children ?? [], depth + 1, out)
  }
  return out
}

function NumField({ label, value, onPreview, onCommit, title }) {
  // scrub on the label, type in the field — Photoshop's opacity/fill
  const drag = useRef(null)
  const [text, setText] = useState(null)
  const v = Math.round(value * 100)
  return (
    <label className="co-num" title={title}>
      <span
        className="co-num-label"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, v, last: v }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const nv = Math.max(0, Math.min(100, Math.round(d.v + (e.clientX - d.x) / 2)))
          if (nv !== d.last) { d.last = nv; onPreview(nv / 100) }
        }}
        onPointerUp={() => { const d = drag.current; drag.current = null; if (d && d.last !== d.v) onCommit(d.last / 100) }}
      >{label}</span>
      <input
        className="co-num-input mono"
        value={text ?? `${v}%`}
        onFocus={(e) => { setText(String(v)); requestAnimationFrame(() => e.target.select()) }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const nv = parseFloat(text)
          setText(null)
          if (Number.isFinite(nv)) onCommit(Math.max(0, Math.min(100, nv)) / 100)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { setText(null); e.currentTarget.blur() }
        }}
      />
    </label>
  )
}

export function BlendSelect({ value, onChange, group = false, label = 'Blend mode' }) {
  const opts = []
  if (group) opts.push(<option key="pass" value="pass">Pass Through</option>)
  BLEND_MODES.forEach(([v, l], i) => {
    opts.push(<option key={v} value={v}>{l}</option>)
    if (BLEND_GROUP_ENDS.includes(i) && i < BLEND_MODES.length - 1) opts.push(<option key={`s${i}`} disabled>──────────</option>)
  })
  return (
    <select className="co-blend mono" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {opts}
    </select>
  )
}

export function adjustMenu(x, y, above) {
  openContextMenu(x, y, ADJUSTMENTS.map(([type, label]) => ({
    label, run: () => op('addAdjust', { type, above }),
  })).concat([
    { sep: true },
    { label: 'Solid Color…', run: () => op('addFill', { fill: { type: 'solid', color: [0.5, 0.5, 0.5, 1] }, above }) },
    { label: 'Gradient…', run: () => op('addFill', { fill: { type: 'linear', stops: [{ t: 0, color: [0, 0, 0, 1] }, { t: 1, color: [0, 0, 0, 0] }] }, above }) },
  ]))
}

export default function LayersPanel() {
  const { doc, thumbGen } = useCompose()
  const [renaming, setRenaming] = useState(null)
  const [drop, setDrop] = useState(null) // { row, where: 'before'|'after'|'into' }
  const drag = useRef(null)
  const listRef = useRef(null)
  useEffect(() => {
    // scroll the list only: scrollIntoView would move the page too
    const list = listRef.current
    const row = list?.querySelector('.co-row.is-active')
    if (!row) return
    const lr = list.getBoundingClientRect(), rr = row.getBoundingClientRect()
    if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top
    else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom
  }, [doc?.activeId])
  if (!doc) return null
  const rows = rowsOf(doc.nodes)
  const activeHit = doc.activeId ? findNode(doc.nodes, doc.activeId) : null
  const active = activeHit?.node ?? null

  const props = (n, patch, label) => op('props', { nodeId: n.id, patch, label })

  const onRowDown = (e, i) => {
    if (e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('button, input')) return
    const r = rows[i]
    if (e.altKey && i < rows.length - 1) { props(r.n, { clip: !r.n.clip }, r.n.clip ? 'Release Clipping Mask' : 'Create Clipping Mask'); return }
    if (doc.activeId !== r.n.id) op('select', { nodeId: r.n.id })
    drag.current = { i, y0: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onRowMove = (e) => {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientY - d.y0) > 4) d.moved = true
    if (!d.moved) return
    const els = [...listRef.current.querySelectorAll('.co-row')]
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (e.clientY < r.bottom) {
        const f = (e.clientY - r.top) / r.height
        const isGroup = rows[i].n.kind === 'group'
        const where = isGroup && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'before' : 'after'
        setDrop({ row: i, where })
        return
      }
    }
    setDrop({ row: els.length - 1, where: 'after' })
  }
  const onRowUp = () => {
    const d = drag.current
    drag.current = null
    const t = drop
    setDrop(null)
    if (!d?.moved || !t) return
    const src = rows[d.i].n
    const tgt = rows[t.row]
    if (tgt.n.id === src.id) return
    if (t.where === 'into') {
      op('move', { nodeId: src.id, parentId: tgt.n.id, index: tgt.n.children?.length ?? 0 })
      return
    }
    const parent = findNode(doc.nodes, tgt.n.id)?.parent ?? null
    // display order is reversed: "before" (above on screen) = higher index
    const index = t.where === 'before' ? tgt.index + 1 : tgt.index
    op('move', { nodeId: src.id, parentId: parent?.id ?? null, index })
  }

  const rowMenu = (e, n) => {
    e.preventDefault()
    op('select', { nodeId: n.id })
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Duplicate Layer', key: '⌘J', run: () => op('duplicate', { nodeId: n.id }) },
      { label: 'Delete Layer', run: () => op('delete', { nodeId: n.id }) },
      { sep: true },
      { label: n.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', key: '⌥⌘G', run: () => props(n, { clip: !n.clip }, 'Clipping Mask') },
      { label: 'Group Layers', key: '⌘G', run: () => op('group', { nodeIds: [n.id] }) },
      ...(n.kind === 'group' ? [{ label: 'Ungroup Layers', key: '⇧⌘G', run: () => op('ungroup', { nodeId: n.id }) }] : []),
      { sep: true },
      ...(n.mask
        ? [
          { label: n.mask.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', run: () => props(n, { mask: { ...n.mask, enabled: n.mask.enabled === false } }, 'Layer Mask') },
          { label: 'Invert Layer Mask', run: () => props(n, { mask: { ...n.mask, invert: !n.mask.invert } }, 'Invert Mask') },
          ...(n.kind === 'pixel' ? [{ label: 'Apply Layer Mask', run: () => op('deleteMask', { nodeId: n.id, apply: true }) }] : []),
          { label: 'Delete Layer Mask', run: () => op('deleteMask', { nodeId: n.id }) },
        ]
        : [
          { label: 'Add Layer Mask (Reveal All)', run: () => op('addMask', { nodeId: n.id, reveal: true }) },
          { label: 'Add Layer Mask (Hide All)', run: () => op('addMask', { nodeId: n.id, reveal: false }) },
        ]),
      { sep: true },
      ...(n.kind !== 'pixel' && n.kind !== 'adjust' && n.kind !== 'group' ? [{ label: 'Rasterize Layer', run: () => op('rasterize', { nodeId: n.id }) }] : []),
      { label: 'Merge Down', key: '⌘E', run: () => op('mergeDown', { nodeId: n.id }) },
      { label: 'Stamp Visible', key: '⌥⇧⌘E', run: () => op('stampVisible') },
      { label: 'Flatten Image', run: () => op('flatten') },
    ])
  }

  return (
    <section className="co-layers" aria-label="Layers">
      {active && (
        <div className="co-layer-ctl">
          <BlendSelect
            value={active.blend ?? 'normal'}
            group={active.kind === 'group'}
            onChange={(v) => props(active, { blend: v }, 'Blend Mode')}
          />
          <div className="co-ctl-row">
            <NumField
              label="Opacity" value={active.opacity} title="Opacity (number keys: 1 = 10%, 0 = 100%)"
              onPreview={(v) => preview(active.id, { opacity: v })}
              onCommit={(v) => { preview(active.id, { opacity: v }, true); props(active, { opacity: v }, 'Opacity') }}
            />
            {active.kind !== 'group' && active.kind !== 'adjust' && (
              <NumField
                label="Fill" value={active.fillOpacity ?? 1} title="Fill opacity: the layer's content, not its styles"
                onPreview={(v) => preview(active.id, { fillOpacity: v })}
                onCommit={(v) => { preview(active.id, { fillOpacity: v }, true); props(active, { fillOpacity: v }, 'Fill Opacity') }}
              />
            )}
          </div>
          <div className="co-ctl-row co-locks">
            <span className="co-ctl-label">Lock</span>
            <button type="button" className={`co-chip${active.locked ? ' is-on' : ''}`} aria-pressed={!!active.locked}
              data-tip="Lock all" onClick={() => props(active, { locked: !active.locked }, active.locked ? 'Unlock' : 'Lock')}>
              <Icon name="lock" />
            </button>
          </div>
        </div>
      )}
      <div className="co-layer-list" ref={listRef} role="tree" aria-label="Layer stack">
        {rows.map((r, i) => {
          const n = r.n
          const isActive = n.id === doc.activeId
          const dropCls = drop?.row === i ? ` drop-${drop.where}` : ''
          return (
            <div
              key={n.id}
              role="treeitem"
              aria-selected={isActive}
              aria-expanded={n.kind === 'group' ? !n.collapsed : undefined}
              className={`co-row${isActive ? ' is-active' : ''}${n.visible === false ? ' is-hidden' : ''}${n.clip ? ' is-clipped' : ''}${dropCls}`}
              style={{ '--depth': r.depth }}
              data-id={n.id}
              data-kind={n.kind}
              onPointerDown={(e) => onRowDown(e, i)}
              onPointerMove={onRowMove}
              onPointerUp={onRowUp}
              onPointerCancel={onRowUp}
              onContextMenu={(e) => rowMenu(e, n)}
              onDoubleClick={(e) => {
                if (e.target instanceof Element && e.target.closest('button, canvas')) return
                setRenaming(n.id)
              }}
            >
              <button
                type="button"
                className={`co-eye${n.visible !== false ? ' is-on' : ''}`}
                data-tip={n.visible !== false ? 'Hide' : 'Show'}
                aria-pressed={n.visible !== false}
                onClick={() => props(n, { visible: n.visible === false }, n.visible === false ? 'Show Layer' : 'Hide Layer')}
              ><Icon name={n.visible !== false ? 'eye' : 'eyeOff'} /></button>
              {n.clip && <span className="co-clip-hook" aria-label="Clipped to the layer below"><Icon name="clip" /></span>}
              {n.kind === 'group' ? (
                <button type="button" className="co-fold" aria-label={n.collapsed ? 'Expand group' : 'Collapse group'}
                  onClick={() => props(n, { collapsed: !n.collapsed }, n.collapsed ? 'Expand Group' : 'Collapse Group')}>
                  <Icon name={n.collapsed ? 'chevRight' : 'chevDown'} />
                </button>
              ) : null}
              {KIND_ICON[n.kind] && n.kind !== 'smart' && n.kind !== 'shape'
                ? <span className="co-kind" aria-hidden="true"><Icon name={KIND_ICON[n.kind]} /></span>
                : <Thumb id={n.id} which="content" gen={thumbGen} kind={n.kind} />}
              {n.mask && (
                <span
                  className={`co-mask-thumb${n.mask.enabled === false ? ' is-off' : ''}`}
                  data-tip="Layer mask: ⇧-click to disable"
                  onClick={(e) => { if (e.shiftKey) props(n, { mask: { ...n.mask, enabled: n.mask.enabled === false } }, 'Layer Mask') }}
                >
                  <Thumb id={n.id} which="mask" gen={thumbGen} />
                </span>
              )}
              {renaming === n.id ? (
                <input
                  className="co-rename mono"
                  defaultValue={n.name}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const name = e.target.value.trim()
                    setRenaming(null)
                    if (name && name !== n.name) op('rename', { nodeId: n.id, name })
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') e.target.blur()
                    else if (e.key === 'Escape') { e.target.value = n.name; e.target.blur() }
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="co-name" title={n.name}>
                  {n.name}
                  {n.kind === 'adjust' && n.name !== adjustLabel(n.adjust?.type) && <span className="co-sub"> · {adjustLabel(n.adjust?.type)}</span>}
                </span>
              )}
              {n.kind === 'smart' && <span className="co-badge" data-tip="Smart object: re-developable RAW"><Icon name="smart" /></span>}
              {n.styles?.some((s) => s.enabled !== false) && <span className="co-badge mono" data-tip="Layer styles">fx</span>}
              {n.blendIf && <span className="co-badge mono" data-tip="Blend If">BI</span>}
              {n.locked && <span className="co-badge" aria-label="Locked"><Icon name="lock" /></span>}
            </div>
          )
        })}
      </div>
      <div className="co-layer-actions">
        <button type="button" className="co-act" data-tip="Layer styles" disabled={!active}
          onClick={(e) => openStyleMenu(e, active)}><span className="mono">fx</span></button>
        <button type="button" className="co-act" data-tip="Add layer mask (⌥: hide all)" disabled={!active || !!active?.mask}
          onClick={(e) => op('addMask', { nodeId: active.id, reveal: !e.altKey, fromSelection: true })}><Icon name="mask" /></button>
        <button type="button" className="co-act" data-tip="New adjustment layer"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); adjustMenu(r.left, r.top - 4, doc.activeId) }}><Icon name="adjust" /></button>
        <button type="button" className="co-act" data-tip="New group (⌘G groups the layer)"
          onClick={() => op('addLayer', { kind: 'group' })}><Icon name="folder" /></button>
        <button type="button" className="co-act" data-tip="New layer (⇧⌘N)"
          onClick={() => op('addLayer', { kind: 'pixel' })}><Icon name="plus" /></button>
        <button type="button" className="co-act co-act-del" data-tip="Delete layer" disabled={!active}
          onClick={() => op('delete', { nodeId: active.id })}><Icon name="trash" /></button>
      </div>
    </section>
  )
}

function openStyleMenu(e, n) {
  if (!n) return
  const r = e.currentTarget.getBoundingClientRect()
  const has = (t) => n.styles?.some((s) => s.type === t)
  const add = (type) => {
    const styles = [...(n.styles ?? []).filter((s) => s.type !== type), { ...STYLE_DEFAULTS[type] }]
    op('props', { nodeId: n.id, patch: { styles }, label: 'Layer Style' })
  }
  const remove = (type) => op('props', { nodeId: n.id, patch: { styles: (n.styles ?? []).filter((s) => s.type !== type) }, label: 'Clear Layer Style' })
  openContextMenu(r.left, r.top - 4, [
    { label: has('shadow') ? '✓ Drop Shadow' : 'Drop Shadow…', run: () => (has('shadow') ? remove('shadow') : add('shadow')) },
    { label: has('stroke') ? '✓ Stroke' : 'Stroke…', run: () => (has('stroke') ? remove('stroke') : add('stroke')) },
    { label: has('glow') ? '✓ Outer Glow' : 'Outer Glow…', run: () => (has('glow') ? remove('glow') : add('glow')) },
    ...(n.styles?.length ? [{ sep: true }, { label: 'Clear Layer Style', run: () => op('props', { nodeId: n.id, patch: { styles: null }, label: 'Clear Layer Style' }) }] : []),
  ])
}
