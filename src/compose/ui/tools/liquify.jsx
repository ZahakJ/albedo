import { useCompose, getCompose, setToolOpts, liquify, liquifyEnd, op } from '../../../state/composeClient.js'
import { toast } from '../../../state/toastStore.js'

// Liquify: push, bloat, pucker, twirl, reconstruct, smooth — on the active
// layer's displacement field, so it stays editable (see liquify.js).
let pts = []
let raf = 0
const flush = () => { raf = 0; if (pts.length) { liquify({ phase: 'pts', pts }); pts = [] } }

export const liquifyTool = {
  id: 'liquify', key: 'q', icon: 'liquify', label: 'Liquify', order: 60,
  cursor: () => 'none',
  Overlay: ({ hover }) => {
    const st = useCompose()
    if (!hover) return null
    const d = Math.max(6, st.opts.liquify.size * st.view.zoom)
    return <div className="co-ring" style={{ width: d, height: d, transform: `translate(${hover[0] - d / 2}px, ${hover[1] - d / 2}px)` }} />
  },
  Options: () => {
    const st = useCompose()
    const o = st.opts.liquify
    return (
      <>
        <span className="co-opt seg">
          {[['push', 'Push'], ['bloat', 'Bloat'], ['pucker', 'Pucker'], ['twirl', 'Twirl'], ['smooth', 'Smooth'], ['reconstruct', 'Reconstruct']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${o.mode === k ? ' is-on' : ''}`} onClick={() => setToolOpts('liquify', { mode: k })}>{l}</button>
          ))}
        </span>
        <label className="co-opt">Size <input type="range" min="10" max="2000" value={o.size} onChange={(e) => setToolOpts('liquify', { size: +e.target.value })} /><span className="co-opt-val mono">{o.size}</span></label>
        <label className="co-opt">Pressure <input type="range" min="1" max="100" value={Math.round(o.pressure * 100)} onChange={(e) => setToolOpts('liquify', { pressure: +e.target.value / 100 })} /><span className="co-opt-val mono">{Math.round(o.pressure * 100)}%</span></label>
        <button type="button" className="btn-quick" onClick={() => op('resetLiquify', {})}>Restore all</button>
        <span className="co-hint">Stays editable: Reconstruct or Restore brings the original back.</span>
      </>
    )
  },
  bracket(dir) {
    const o = getCompose().opts.liquify
    setToolOpts('liquify', { size: Math.max(10, Math.min(2000, Math.round(o.size * (dir > 0 ? 1.25 : 0.8)))) })
  },
  down(c) {
    const o = getCompose().opts.liquify
    this.on = true
    liquify({ phase: 'begin', ...o })
    pts = [[c.dx, c.dy]]
    raf ||= requestAnimationFrame(flush)
  },
  move(c) {
    if (!this.on) return
    pts.push([c.dx, c.dy])
    raf ||= requestAnimationFrame(flush)
  },
  up() {
    if (!this.on) return
    this.on = false
    if (raf) cancelAnimationFrame(raf)
    flush()
    liquifyEnd({}).catch((e) => toast(e.message))
  },
}
