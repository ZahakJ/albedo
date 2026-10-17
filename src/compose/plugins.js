import { selectPlugin } from './select.js'
import { paintPlugin } from './paint.js'
import { patchPlugin } from './patch.js'
import { retouchPlugin } from './retouch.js'
import { textPlugin } from './text.js'
import { liquifyPlugin } from './liquify.js'
import { filesPlugin } from './files.js'
import { stylesPlugin } from './styles.js'

// Compose's tool modules, each a plugin on the engine (engine.js E.use):
// they add operations, messages, live textures and export formats.
export function installCompose(E) {
  E.use(selectPlugin())
  E.use(paintPlugin())
  E.use(patchPlugin())
  E.use(retouchPlugin())
  E.use(textPlugin())
  E.use(liquifyPlugin())
  E.use(filesPlugin())
  E.use(stylesPlugin())
  return E
}
