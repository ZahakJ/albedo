import { openContextMenu } from '../../ui/ContextMenu.jsx'
import { getCompose, op, undo, redo, setTool, selectOp } from '../../state/composeClient.js'
import { ADJUSTMENTS } from '../model.js'
import { contentAwareFill } from './contentAware.js'
import { aiSelect } from './tools/select.jsx'
import { exportAs } from './ExportMenu.jsx'
import { toast } from '../../state/toastStore.js'

// Compose's menus, Photoshop's order and names. Every item is also reachable
// by its key or from a panel; the menus are for finding things.
const menus = {
  Edit: () => [
    { label: 'Undo', key: '⌘Z', run: undo },
    { label: 'Redo', key: '⇧⌘Z', run: redo },
    { sep: true },
    { label: 'Fill with Foreground', key: '⌥⌫', run: () => op('fillSelection', { color: getCompose().fg }) },
    { label: 'Fill with Background', key: '⌘⌫', run: () => op('fillSelection', { color: getCompose().bg }) },
    { label: 'Content-Aware Fill', disabled: !getCompose().selection, run: () => contentAwareFill() },
    { label: 'Clear', key: '⌫', run: () => op('clearSelection') },
    { sep: true },
    { label: 'Free Transform', key: '⌘T', run: () => setTool('transform') },
  ],
  Image: () => [
    { label: 'Mode', items: [8, 16, 32].map((d) => ({ label: `${d === getCompose().doc?.depth ? '✓ ' : ''}${d} Bits/Channel${d === 16 ? ' (half float)' : d === 32 ? ' (float, linear)' : ''}`, run: () => op('setDepth', { depth: d }).catch((e) => toast(e.message)) })) },
    { label: 'Crop', key: 'C', run: () => setTool('crop') },
    { label: 'Merge Visible', key: '⇧⌘E', run: () => op('mergeVisible') },
    { label: 'Flatten Image', run: () => op('flatten') },
    { sep: true },
    { label: 'Export', items: [
      { label: 'JPEG', run: () => exportAs('jpeg') },
      { label: 'JPEG, 2048 px long edge', run: () => exportAs('jpeg-2048') },
      { label: 'PNG', run: () => exportAs('png') },
      { label: 'TIFF, 16-bit', run: () => exportAs('tiff') },
      { label: 'Photoshop (PSD)', run: () => exportAs('psd') },
      { label: 'PSD with albedo data', run: () => exportAs('psd+') },
      { label: 'albedo document', run: () => exportAs('albedo') },
    ] },
  ],
  Layer: () => [
    { label: 'New Layer', key: '⇧⌘N', run: () => op('addLayer', { kind: 'pixel' }) },
    { label: 'New Adjustment Layer', items: ADJUSTMENTS.map(([type, label]) => ({ label, run: () => op('addAdjust', { type }) })) },
    { label: 'New Fill Layer', items: [
      { label: 'Solid Color', run: () => op('addFill', { fill: { type: 'solid', color: getCompose().fg } }) },
      { label: 'Gradient', run: () => op('addFill', { fill: { type: 'linear', stops: [{ t: 0, color: getCompose().fg }, { t: 1, color: [...getCompose().fg.slice(0, 3), 0] }] } }) },
    ] },
    { label: 'Duplicate Layer', key: '⌘J', run: () => op('duplicate', {}) },
    { label: 'Delete Layer', run: () => op('delete', {}) },
    { sep: true },
    { label: 'Layer Mask', items: [
      { label: 'Reveal All', run: () => op('addMask', { reveal: true }) },
      { label: 'Hide All', run: () => op('addMask', { reveal: false }) },
      { label: 'Reveal Selection', disabled: !getCompose().selection, run: () => op('addMask', { reveal: true, fromSelection: true }) },
      { label: 'Hide Selection', disabled: !getCompose().selection, run: () => op('addMask', { reveal: false, fromSelection: true }) },
      { label: 'Apply', run: () => op('deleteMask', { apply: true }) },
      { label: 'Delete', run: () => op('deleteMask', {}) },
    ] },
    { label: 'Create Clipping Mask', key: '⌥⌘G', run: () => { const n = active(); if (n) op('props', { nodeId: n.id, patch: { clip: !n.clip }, label: 'Clipping Mask' }) } },
    { sep: true },
    { label: 'Group Layers', key: '⌘G', run: () => op('group', {}) },
    { label: 'Ungroup Layers', key: '⇧⌘G', run: () => op('ungroup', {}) },
    { label: 'Rasterize', run: () => op('rasterize', {}) },
    { sep: true },
    { label: 'Merge Down', key: '⌘E', run: () => op('mergeDown', {}) },
    { label: 'Stamp Visible', key: '⌥⇧⌘E', run: () => op('stampVisible') },
  ],
  Select: () => [
    { label: 'All', key: '⌘A', run: () => op('selectAll') },
    { label: 'Deselect', key: '⌘D', run: () => op('deselect') },
    { label: 'Reselect', key: '⇧⌘D', run: () => op('reselect') },
    { label: 'Inverse', key: '⇧⌘I', run: () => op('invertSelection') },
    { sep: true },
    { label: 'Subject', run: () => aiSelect('subject') },
    { label: 'Sky', run: () => aiSelect('sky') },
    { label: 'Color Range (foreground)', run: () => selectOp({ op: 'colorRange', colors: [getCompose().fg.slice(0, 3)], fuzziness: 40 }) },
    { sep: true },
    { label: 'Refine Edge', disabled: !getCompose().selection, run: () => selectOp({ op: 'refine', radius: 10 }) },
    { label: 'Modify', items: [
      ...['expand', 'contract', 'feather', 'smooth', 'border'].flatMap((k) => [2, 8, 24].map((a) => ({ label: `${k[0].toUpperCase()}${k.slice(1)} ${a} px`, run: () => selectOp({ op: 'modify', kind: k, amount: a }) }))),
    ] },
  ],
  Filter: () => [
    { label: 'Gaussian Blur', items: [1, 2, 4, 8, 16, 32].map((r) => ({ label: `${r} px`, run: () => op('gaussianBlur', { radius: r }) })) },
    { label: 'Frequency Separation', items: [3, 6, 10, 16].map((r) => ({ label: `${r} px`, run: () => op('frequencySeparation', { radius: r }) })) },
    { label: 'New Dodge & Burn Layer', run: () => op('dodgeBurnLayer') },
    { label: 'Liquify', key: 'Q', run: () => setTool('liquify') },
  ],
}

const active = () => {
  const d = getCompose().doc
  if (!d?.activeId) return null
  let hit = null
  const walk = (l) => { for (const n of l) { if (n.id === d.activeId) hit = n; if (n.children) walk(n.children) } }
  walk(d.nodes)
  return hit
}

export default function Menus() {
  return (
    <nav className="co-menus" aria-label="Compose menus">
      {Object.keys(menus).map((m) => (
        <button key={m} type="button" className="co-menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openContextMenu(r.left, r.bottom + 2, menus[m]()) }}>{m}</button>
      ))}
    </nav>
  )
}
