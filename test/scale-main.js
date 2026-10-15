// Catalog at scale: imports ?n= tiny JPEGs (default 10000) through the normal
// import path in batches, then times the queries the Library runs. Results as
// JSON in #out. The app on the same origin then sees the same catalog.
import { initCatalog, importFiles, queryPhotos, fetchSidebar, setMeta } from '/src/state/catalogStore.js'

const q = new URLSearchParams(location.search)
const N = +(q.get('n') ?? 10000)
const out = document.getElementById('out')
const report = (o) => { out.textContent = JSON.stringify(o) }
const t = async (fn) => { const s = performance.now(); const r = await fn(); return [Math.round((performance.now() - s) * 10) / 10, r] }

async function jpeg(i) {
  const c = new OffscreenCanvas(160, 120)
  const x = c.getContext('2d')
  x.fillStyle = `hsl(${(i * 37) % 360} 50% 50%)`
  x.fillRect(0, 0, 160, 120)
  x.fillStyle = '#fff'
  x.fillText(String(i), 20, 60)
  return new File([await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 })], `IMG_${String(i).padStart(5, '0')}.jpg`, { type: 'image/jpeg' })
}

async function main() {
  await initCatalog()
  const have = (await queryPhotos()).length
  const r = { existing: have }
  if (have < N) {
    const ti = performance.now()
    for (let i = have; i < N; i += 250) {
      const batch = await Promise.all(Array.from({ length: Math.min(250, N - i) }, (_, k) => jpeg(i + k)))
      await importFiles(batch)
      out.textContent = `imported ${Math.min(N, i + 250)}/${N}`
    }
    r.importPerSec = Math.round(((N - have) / (performance.now() - ti)) * 1000)
    // ratings and flags spread over the catalog, as in a real one
    const all = await queryPhotos()
    for (let i = 0; i < all.length; i++) {
      if (i % 3 === 0) setMeta(all[i].id, { rating: (i % 5) + 1 })
      if (i % 7 === 0) setMeta(all[i].id, { flag: 1 })
    }
    await new Promise((res) => setTimeout(res, 3000))
  }
  const runs = {}
  const time3 = async (name, fn) => {
    const ms = []
    let n = 0
    let w = null
    for (let k = 0; k < 3; k++) { const [m, rows] = await t(fn); ms.push(m); n = rows?.length ?? n; w = rows?.workerMs ?? w }
    runs[name] = { ms: Math.min(...ms), rows: n, ...(w != null ? { workerMs: Math.round(w * 10) / 10 } : {}) }
  }
  await time3('all, by capture date', () => queryPhotos({}, { by: 'takenAt', dir: 'desc' }))
  await time3('rating ≥ 3', () => queryPhotos({ minRating: 3 }))
  await time3('picks', () => queryPhotos({ flag: 1 }))
  await time3('search "IMG_04"', () => queryPhotos({ search: 'IMG_04' }))
  await time3('by name', () => queryPhotos({}, { by: 'name', dir: 'asc' }))
  await time3('sidebar', async () => { await fetchSidebar(); return null })
  report({ ok: true, n: (await queryPhotos()).length, ...r, runs })
}
main().catch((e) => report({ ok: false, error: String(e?.stack ?? e) }))
