// Catalog harness. Phase 1: init, import 3 generated JPEGs, query, meta,
// doc save/load, then reload. Phase 2 (post-reload): re-init and verify
// everything persisted. Log survives the reload in sessionStorage; the e2e
// waits for the final DONE line.

import {
  initCatalog, importFiles, setMeta, setFilter, getThumbUrl, loadOriginal,
  saveDoc, loadDoc, getCatalogState,
} from '/src/state/catalogStore.js'

const out = document.getElementById('out')
const log = JSON.parse(sessionStorage.getItem('cat_log') ?? '[]')
const line = (s) => {
  log.push(s)
  sessionStorage.setItem('cat_log', JSON.stringify(log))
  out.textContent = log.join('\n')
}
const step = async (name, fn) => {
  try { await fn(); line(`PASS ${name}`) }
  catch (err) { line(`FAIL ${name}: ${err?.message ?? err}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

async function makeJpeg(name, color) {
  const canvas = new OffscreenCanvas(640, 480)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 640, 480)
  ctx.fillStyle = '#fff'
  ctx.fillRect(100, 100, 200, 120)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  return new File([blob], name, { type: 'image/jpeg' })
}

const phase = sessionStorage.getItem('cat_phase') ?? '1'

if (phase === '1') {
  sessionStorage.setItem('cat_log', '[]')
  log.length = 0
  let ids = []

  await step('init', async () => {
    await initCatalog()
    assert(getCatalogState().ready, 'store not ready')
  })

  await step('import 3 jpegs', async () => {
    const files = await Promise.all([
      makeJpeg('red.jpg', '#c33'), makeJpeg('green.jpg', '#3c3'), makeJpeg('blue.jpg', '#33c'),
    ])
    ids = await importFiles(files)
    assert(ids.length === 3, `imported ${ids.length}, want 3`)
  })

  await step('query shows imports', async () => {
    setFilter({}) // forces a re-query
    await new Promise((r) => setTimeout(r, 300))
    const { photos } = getCatalogState()
    for (const id of ids) assert(photos.some((p) => p.id === id), `missing ${id}`)
    const p = photos.find((x) => x.id === ids[0])
    assert(p.name === 'red.jpg', `name ${p.name}`)
    assert(p.width === 640 && p.height === 480, `dims ${p.width}x${p.height}`)
    assert(p.thumbState === 1, `thumbState ${p.thumbState}`)
    assert(p.isRaw === false, 'jpg flagged raw')
  })

  await step('thumb url', async () => {
    const url = await getThumbUrl(ids[0])
    assert(typeof url === 'string' && url.startsWith('blob:'), `bad url ${url}`)
  })

  await step('original roundtrip', async () => {
    const { buffer, name } = await loadOriginal(ids[0])
    assert(name === 'red.jpg' && buffer.byteLength > 1000, `got ${name} ${buffer?.byteLength}b`)
  })

  await step('set rating', async () => {
    setMeta(ids[0], { rating: 4 })
    const p = getCatalogState().photos.find((x) => x.id === ids[0])
    assert(p.rating === 4, 'optimistic rating missing')
    await new Promise((r) => setTimeout(r, 300)) // let the worker write land
  })

  await step('save/load doc', async () => {
    saveDoc(ids[0], {
      schema: 1, photoId: ids[0], versionId: 'v_default',
      modules: { exposure: { ev: 1.5, black: 0 } }, masks: [],
    })
    await new Promise((r) => setTimeout(r, 800)) // past the 500ms write-behind
    const doc = await loadDoc(ids[0])
    assert(doc?.modules?.exposure?.ev === 1.5, `doc ev ${doc?.modules?.exposure?.ev}`)
  })

  sessionStorage.setItem('cat_ids', JSON.stringify(ids))
  sessionStorage.setItem('cat_phase', '2')
  line('RELOADING for persistence check…')
  location.reload()
} else {
  sessionStorage.removeItem('cat_phase') // next manual visit starts fresh
  const ids = JSON.parse(sessionStorage.getItem('cat_ids') ?? '[]')

  await step('reload: init', async () => {
    await initCatalog()
    assert(getCatalogState().ready, 'store not ready after reload')
  })

  await step('reload: photos persisted', async () => {
    const { photos } = getCatalogState()
    for (const id of ids) assert(photos.some((p) => p.id === id), `missing ${id} after reload`)
  })

  await step('reload: rating persisted', async () => {
    const p = getCatalogState().photos.find((x) => x.id === ids[0])
    assert(p?.rating === 4, `rating ${p?.rating}, want 4`)
  })

  await step('reload: doc persisted', async () => {
    const doc = await loadDoc(ids[0])
    assert(doc?.modules?.exposure?.ev === 1.5, `doc ev ${doc?.modules?.exposure?.ev}`)
  })

  await step('reload: thumb persisted', async () => {
    const url = await getThumbUrl(ids[0])
    assert(typeof url === 'string' && url.startsWith('blob:'), `bad url ${url}`)
  })

  await step('reload: filter query', async () => {
    setFilter({ minRating: 4 })
    await new Promise((r) => setTimeout(r, 300))
    const { photos } = getCatalogState()
    assert(photos.some((p) => p.id === ids[0]), 'rated photo not in filtered set')
    assert(!photos.some((p) => p.id === ids[1]), 'unrated photo leaked through filter')
  })

  line(log.some((l) => l.startsWith('FAIL')) ? 'DONE (failures)' : 'DONE ALL PASS')
}
