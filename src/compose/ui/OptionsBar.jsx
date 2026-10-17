import { useCompose } from '../../state/composeClient.js'
import { toolById } from './tools/index.js'
import { Icon } from './icons.jsx'
import Menus from './Menus.jsx'

// The options bar: the active tool's settings, Photoshop-style, above the
// stage.
export default function OptionsBar() {
  const st = useCompose()
  const T = toolById(st.tool)
  return (
    <div className="co-options" role="toolbar" aria-label={`${T.label} options`}>
      {st.doc && <Menus />}
      <span className="co-opt-tool"><Icon name={T.icon} /> {T.label}</span>
      {st.doc && T.Options ? <T.Options state={st} /> : <span className="co-hint">{st.doc ? T.hint ?? '' : ''}</span>}
    </div>
  )
}
