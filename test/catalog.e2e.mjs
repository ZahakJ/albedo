// Catalog e2e: drives test/catalog.html headless and asserts every harness
// step passed, including the reload-persistence phase. OPFS + sahpool work in
// headless Chromium without COOP/COEP. Starts its own vite on 5182 unless one
// is already listening there.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { spawnVite } from './server.mjs'

const PORT = 5182
const URL_ = `http://localhost:${PORT}/test/catalog.html`

const listening = () => fetch(`http://localhost:${PORT}/`).then(() => true, () => false)

let vite = null
if (!(await listening())) {
  vite = spawnVite(String(PORT), {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore',
  })
  for (let i = 0; i < 100 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 200))
  if (!(await listening())) { console.error('vite failed to start'); process.exit(1) }
}

let pass = false
const browser = await chromium.launch({ args: ['--no-sandbox'] })
try {
  const page = await (await browser.newContext()).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(URL_)
  // harness reloads itself midway; wait for the phase-2 terminal line
  await page.waitForFunction(
    () => document.getElementById('out')?.textContent.includes('DONE'), null, { timeout: 90000 })
  const out = await page.textContent('#out')
  console.log(out)
  if (errors.length) console.log('console errors:', errors.join('\n'))
  const lines = out.split('\n')
  const fails = lines.filter((l) => l.startsWith('FAIL'))
  const passes = lines.filter((l) => l.startsWith('PASS'))
  const hasReloadChecks = passes.some((l) => l.includes('reload:'))
  pass = fails.length === 0 && out.includes('DONE ALL PASS') && hasReloadChecks && passes.length >= 12
  console.log(pass ? 'E2E PASS' : `E2E FAIL (${fails.length} failing, ${passes.length} passing)`)
} catch (err) {
  console.error('E2E ERROR', err)
} finally {
  await browser.close()
  if (vite) vite.kill()
}
process.exit(pass ? 0 : 1)
