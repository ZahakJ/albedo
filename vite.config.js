import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Offline: after a build, list every emitted file into dist/sw.js so the
// service worker can precache the app shell. Models are left out — they are
// large and optional — and cached at runtime on first use instead.
const serviceWorker = () => ({
  name: 'albedo-sw',
  apply: 'build',
  closeBundle() {
    const dist = 'dist'
    const files = []
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else files.push(relative(dist, p).split('\\').join('/'))
      }
    }
    walk(dist)
    const shell = files.filter((f) => !f.startsWith('models/') && f !== 'sw.js').sort()
    const hash = createHash('sha256')
    for (const f of shell) hash.update(f).update(readFileSync(join(dist, f)))
    const src = readFileSync('src/sw.template.js', 'utf8')
      .replace('__VERSION__', hash.digest('hex').slice(0, 12))
      .replace('__PRECACHE__', JSON.stringify(['./', ...shell.filter((f) => f !== 'index.html')]))
    writeFileSync(join(dist, 'sw.js'), src)
  },
})

export default defineConfig({
  plugins: [react(), serviceWorker()],
  // relative asset URLs: the same build serves from / or from a sub-path
  base: './',
  // Module workers with imports require es format; classic workers can't share code.
  worker: { format: 'es' },
  server: { port: 5180 },
  // sqlite-wasm locates sqlite3.wasm via import.meta.url; pre-bundling would
  // point that at .vite/deps where the wasm isn't. Same for libraw-wasm's
  // nested worker + wasm. onnxruntime-web: wasm is served from public/ort
  // (env.wasm.wasmPaths) — excluded for the same import.meta.url reason.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', 'libraw-wasm',
      // subpath used by the segment worker — listed so a first-run discovery
      // never triggers the optimizer's full page reload mid-test
      'onnxruntime-web', 'onnxruntime-web/wasm', 'onnxruntime-web/webgpu'],
  },
  build: { target: 'es2022' },
})
