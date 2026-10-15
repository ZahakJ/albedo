import { useState, useEffect } from 'react'
import Slider from './Slider.jsx'
import { useEditState, previewParam, commitParam } from '../state/editStore.js'
import { getParam, BAND_NAMES } from '../engine/editdoc.js'

// TAT hook: the targeted-adjustment drag (Develop.jsx) edits whichever axis
// tab is active; mirrored module-level so non-React code can read it.
let liveAxis = 'h'
export const getMixerAxis = () => liveAxis

// 8-band HSL mixer. One axis visible at a time (H | S | L segmented tabs);
// previews/commits merge the active axis into the whole band object. The
// per-row hue underline is the second sanctioned color-in-chrome spot.

const AXES = [
  ['h', 'H', 'Hue shift'],
  ['s', 'S', 'Saturation'],
  ['l', 'L', 'Luminance'],
]
const ZERO = { h: 0, s: 0, l: 0 }
const cap = (s) => s[0].toUpperCase() + s.slice(1)

export default function Mixer() {
  const { doc } = useEditState()
  const [axis, setAxis] = useState('h')
  useEffect(() => { liveAxis = axis }, [axis])
  return (
    <div className="mixer">
      <div className="seg mix-seg" role="tablist" aria-label="Mixer axis">
        <span className="seg-thumb" aria-hidden="true" />
        {AXES.map(([a, label, title]) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={axis === a}
            title={title}
            className={`seg-btn${axis === a ? ' is-on' : ''}`}
            onClick={() => setAxis(a)}
          >{label}</button>
        ))}
      </div>
      {BAND_NAMES.map((band) => {
        const cur = doc ? getParam(doc, 'colormix', band) : ZERO
        return (
          <div className={`mix-row mix-${band}`} key={band}>
            <Slider
              label={cap(band)}
              min={-100}
              max={100}
              step={1}
              defaultValue={0}
              value={cur[axis]}
              onPreview={(v) => doc && previewParam('colormix', band, { ...cur, [axis]: v })}
              onCommit={(v) => doc && commitParam('colormix', band, { ...cur, [axis]: v })}
            />
            <span className="mix-hue" aria-hidden="true" />
          </div>
        )
      })}
    </div>
  )
}
