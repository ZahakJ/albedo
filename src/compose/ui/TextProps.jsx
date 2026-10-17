import { useEffect, useState } from 'react'
import Slider from '../../ui/Slider.jsx'
import { op } from '../../state/composeClient.js'
import { Swatch } from './PropertiesPanel.jsx'
import { toast } from '../../state/toastStore.js'

// TYPE and SHAPE properties: font, weight, size, tracking, leading,
// kerning and ligatures, alignment, direction; a shape's size, corners,
// sides, fill and stroke. Fonts: the bundled IBM Plex Sans and Plex Sans
// Arabic, any font file, and the installed fonts where the browser lets
// pages read them (Local Font Access).

let families = null
const loadFamilies = () => op('listFonts').then((r) => { families = r.families; return families })

async function addFontFile() {
  const [fh] = await (window.showOpenFilePicker?.({ types: [{ description: 'Fonts', accept: { 'font/*': ['.ttf', '.otf', '.woff'] } }] }) ?? Promise.resolve([]))
  if (!fh) return null
  const f = await fh.getFile()
  const bytes = new Uint8Array(await f.arrayBuffer())
  const r = await op('addFont', { bytes })
  families = r.families
  toast(`Added ${r.family}`)
  return r
}
async function addInstalledFont(name) {
  if (!window.queryLocalFonts) { toast('This browser does not let pages read installed fonts; add the font file instead'); return null }
  const all = await window.queryLocalFonts()
  const hits = all.filter((f) => f.family === name)
  if (!hits.length) { toast(`No installed font named ${name}`); return null }
  let r = null
  for (const f of hits.slice(0, 8)) {
    const blob = await f.blob()
    r = await op('addFont', { bytes: new Uint8Array(await blob.arrayBuffer()), family: f.family })
  }
  families = r?.families ?? families
  toast(`Added ${name} (${hits.length} style${hits.length === 1 ? '' : 's'})`)
  return r
}

export default function TextProps({ node }) {
  const [fams, setFams] = useState(families)
  const [installed, setInstalled] = useState(null)
  useEffect(() => { if (!families) loadFamilies().then(setFams).catch(() => {}) }, [])
  if (node.kind === 'shape') return <ShapeProps node={node} />
  const t = node.text
  const set = (patch, label) => op('setText', { nodeId: node.id, patch, label })
  const live = (patch) => op('setText', { nodeId: node.id, patch, live: true })
  const S = ({ k, label, min, max, step = 1, decimals = 0, def, scale = 1 }) => (
    <Slider label={label} min={min} max={max} step={step} decimals={decimals} defaultValue={def}
      value={(t[k] ?? def / scale) * scale}
      onPreview={(v) => live({ [k]: v / scale })} onCommit={(v) => set({ [k]: v / scale }, label)} />
  )
  return (
    <div className="co-type">
      <div className="co-row-ctl">
        <select className="co-blend" aria-label="Font" value={t.font} onChange={async (e) => {
          const v = e.target.value
          if (v === '__file') { const r = await addFontFile(); if (r) { setFams([...families]); set({ font: r.family }, 'Font') } return }
          if (v === '__local') {
            if (!window.queryLocalFonts) { toast('This browser does not let pages read installed fonts; add the font file instead'); return }
            const all = await window.queryLocalFonts()
            setInstalled([...new Set(all.map((f) => f.family))].sort())
            return
          }
          set({ font: v }, 'Font')
        }}>
          {(fams ?? [t.font]).map((f) => <option key={f} value={f}>{f}</option>)}
          <option value="__file">Add a font file…</option>
          <option value="__local">Use an installed font…</option>
        </select>
      </div>
      {installed && (
        <div className="co-row-ctl">
          <select className="co-blend" aria-label="Installed fonts" defaultValue="" onChange={async (e) => {
            const r = await addInstalledFont(e.target.value)
            setInstalled(null)
            if (r) { setFams([...families]); set({ font: r.family }, 'Font') }
          }}>
            <option value="" disabled>Installed fonts ({installed.length})</option>
            {installed.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      )}
      <div className="seg co-seg">
        {[[400, 'Regular'], [700, 'Bold']].map(([w, l]) => (
          <button key={w} type="button" className={`seg-btn${(t.weight ?? 400) === w ? ' is-on' : ''}`} onClick={() => set({ weight: w }, 'Weight')}>{l}</button>
        ))}
      </div>
      <S k="size" label="Size" min={4} max={1000} def={96} />
      <S k="tracking" label="Tracking" min={-200} max={800} def={0} />
      <S k="leading" label="Leading" min={0.6} max={3} step={0.01} decimals={2} def={1.2} />
      <S k="width" label="Box width" min={0} max={8000} def={0} />
      <div className="co-row-ctl"><span className="co-ctl-label">Colour</span><Swatch color={t.color} label="Text colour" onChange={(color) => set({ color }, 'Text Colour')} /></div>
      <div className="seg co-seg" aria-label="Alignment">
        {[['start', 'Start'], ['center', 'Centre'], ['end', 'End']].map(([k, l]) => (
          <button key={k} type="button" className={`seg-btn${(t.align ?? 'start') === k ? ' is-on' : ''}`} onClick={() => set({ align: k }, 'Alignment')}>{l}</button>
        ))}
      </div>
      <div className="seg co-seg" aria-label="Direction">
        {[['auto', 'Auto'], ['ltr', 'LTR'], ['rtl', 'RTL']].map(([k, l]) => (
          <button key={k} type="button" className={`seg-btn${(t.direction ?? 'auto') === k ? ' is-on' : ''}`} onClick={() => set({ direction: k }, 'Direction')}>{l}</button>
        ))}
      </div>
      <label className="co-check"><input type="checkbox" checked={t.kerning !== false} onChange={(e) => set({ kerning: e.target.checked }, 'Kerning')} /> Kerning (the font's own pairs)</label>
      <label className="co-check"><input type="checkbox" checked={t.ligatures !== false} onChange={(e) => set({ ligatures: e.target.checked }, 'Ligatures')} /> Ligatures</label>
      <p className="co-hint">Arabic and other complex scripts shape out of the box, and mixed right-to-left and left-to-right lines follow the Unicode bidi rules. Double-click the text on the canvas to edit it.</p>
    </div>
  )
}

function ShapeProps({ node }) {
  const sh = node.shape
  const set = (patch, label = 'Edit Shape') => op('setShape', { nodeId: node.id, patch, label })
  const live = (patch) => op('setShape', { nodeId: node.id, patch, live: true })
  const S = ({ k, label, min, max, def }) => (
    <Slider label={label} min={min} max={max} defaultValue={def} value={sh[k] ?? def}
      onPreview={(v) => live({ [k]: v })} onCommit={(v) => set({ [k]: v }, label)} />
  )
  const stroke = sh.stroke
  return (
    <div className="co-type">
      <div className="seg co-seg">
        {[['rect', 'Rect'], ['ellipse', 'Ellipse'], ['polygon', 'Polygon'], ['line', 'Line']].map(([k, l]) => (
          <button key={k} type="button" className={`seg-btn${sh.type === k ? ' is-on' : ''}`} onClick={() => set({ type: k })}>{l}</button>
        ))}
      </div>
      <S k="w" label="Width" min={1} max={8000} def={400} />
      <S k="h" label="Height" min={1} max={8000} def={300} />
      {sh.type === 'rect' && <S k="radius" label="Corner radius" min={0} max={2000} def={0} />}
      {sh.type === 'polygon' && <S k="sides" label="Sides" min={3} max={24} def={6} />}
      {sh.type === 'polygon' && (
        <Slider label="Star indent" min={0} max={95} defaultValue={0} value={Math.round((sh.star ?? 0) * 100)}
          onPreview={(v) => live({ star: v / 100 })} onCommit={(v) => set({ star: v / 100 })} />
      )}
      <div className="co-row-ctl"><span className="co-ctl-label">Fill</span><Swatch color={sh.fill ?? [1, 1, 1, 1]} label="Fill" onChange={(fill) => set({ fill }, 'Shape Fill')} /></div>
      <label className="co-check"><input type="checkbox" checked={!!stroke}
        onChange={(e) => set({ stroke: e.target.checked ? { width: 6, color: [0, 0, 0, 1], align: 'center' } : null }, 'Shape Stroke')} /> Stroke</label>
      {stroke && (
        <>
          <Slider label="Stroke width" min={1} max={200} defaultValue={6} value={stroke.width}
            onPreview={(v) => live({ stroke: { ...stroke, width: v } })} onCommit={(v) => set({ stroke: { ...stroke, width: v } }, 'Shape Stroke')} />
          <div className="co-row-ctl"><span className="co-ctl-label">Stroke colour</span><Swatch color={stroke.color} label="Stroke colour" onChange={(color) => set({ stroke: { ...stroke, color } }, 'Shape Stroke')} /></div>
          <div className="seg co-seg">
            {['inside', 'center', 'outside'].map((k) => (
              <button key={k} type="button" className={`seg-btn${stroke.align === k ? ' is-on' : ''}`} onClick={() => set({ stroke: { ...stroke, align: k } }, 'Shape Stroke')}>{k[0].toUpperCase() + k.slice(1)}</button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
