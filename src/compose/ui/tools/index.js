import { moveTool, handTool, zoomTool } from './basic.js'
import { selectionTools } from './select.jsx'
import { paintTools } from './paint.jsx'
import { transformTools } from './transform.jsx'
import { typeTools } from './type.jsx'
import { liquifyTool } from './liquify.jsx'

// The tool registry. Each tool: { id, key (Photoshop's), icon, label,
// group (tools sharing the key, cycled with ⇧key), cursor(state), down/move/
// up/hover(ctx), Overlay (component over the stage), Options (options bar),
// bracket(dir) ([ and ]), cancel()/commit() (Esc / Enter) }.
// ctx = { e, sx, sy (stage px), dx, dy (document px), pressure, tiltX,
// tiltY, doc, state }.

export const TOOLS = []
const byId = new Map()

export function registerTools(list) {
  for (const t of list) {
    const i = TOOLS.findIndex((x) => x.id === t.id)
    if (i >= 0) TOOLS[i] = t
    else TOOLS.push(t)
    byId.set(t.id, t)
  }
  TOOLS.sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
}

registerTools([moveTool, handTool, zoomTool, ...selectionTools, ...paintTools, ...transformTools, ...typeTools, liquifyTool])

export const toolById = (id) => byId.get(id) ?? byId.get('move')

// a key press → tool id; ⇧ cycles through tools sharing the key
export function toolForKey(k, shift, current) {
  const key = k.toLowerCase()
  const all = [...byId.values()].filter((t) => t.key === key)
  if (!all.length) return null
  if (shift && all.length > 1) {
    const i = all.findIndex((t) => t.id === current)
    return all[(i + 1) % all.length].id
  }
  return all.find((t) => t.id === current)?.id ?? all.find((t) => t.primary)?.id ?? all[0].id
}
