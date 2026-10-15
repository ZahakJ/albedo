// Ensures a vite dev server is listening on the port, spawning one if needed.
// A spawned server belongs to this test process and dies with it: servers
// that outlive their suite pile up across a full run.
import { spawn } from 'node:child_process'

const children = []
process.on('exit', () => { for (const c of children) c.kill('SIGTERM') })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

// vite run directly under node (not through npx), so killing the child stops
// the server itself; heap capped so a leak fails loudly instead of growing
export const viteArgs = (port) => ['--max-old-space-size=1024',
  new URL('../node_modules/.bin/vite', import.meta.url).pathname, '--port', String(port), '--strictPort']

// a vite child of this test process, killed when the process exits
export const spawnVite = (port, opts = {}) => {
  const c = spawn(process.execPath, viteArgs(port), { stdio: 'ignore', ...opts })
  children.push(c)
  return c
}

export async function ensureServer(port) {
  const up = () => fetch(`http://localhost:${port}`).then((r) => r.ok, () => false)
  if (await up()) return
  spawnVite(port)
  for (let i = 0; i < 60; i++) {
    if (await up()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`vite on :${port} never came up`)
}
