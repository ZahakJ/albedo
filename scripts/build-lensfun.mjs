// Builds public/lensfun/ from the lensfun database (github.com/lensfun/lensfun,
// data/db/*.xml on master; CC BY-SA 3.0). Run: npm run setup-lensfun
//   LENSFUN_CACHE  download/extract dir (default .cache/lensfun)
//   --refresh      re-download even when the cached tarball exists
//
// Output is committed, unlike public/models/ and public/ort/: the compact JSON
// is well under the ~3 MB budget (the script prints the total), it changes only
// when someone re-runs this, and a fresh clone then has lens corrections
// without a network step. The tarball and raw XML stay in the cache, never in
// the repo.
//
// One repo tarball instead of per-file fetches: a single request, no GitHub API
// rate limit, and its pax header names the exact commit, which the index and
// LICENSE record.
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { guessFromName } from '../src/engine/lensfun.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARBALL = 'https://codeload.github.com/lensfun/lensfun/tar.gz/refs/heads/master'

// ------------------------------------------------------------- XML reader

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m)

// Minimal tolerant XML → { name, attrs, children, text } tree. Skips the
// prolog, comments, doctype and PIs; keeps CDATA as text; an unmatched close
// tag pops to the nearest open element of that name (or is ignored), and
// unclosed elements are closed at EOF — lensfun files are well-formed, but a
// stray typo upstream should cost one entry, not the build.
export function parseXml(src) {
  const top = { name: '#document', attrs: {}, children: [], text: '' }
  const stack = [top]
  const cur = () => stack[stack.length - 1]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) { cur().text += decode(src.slice(i)); break }
    if (lt > i) cur().text += decode(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9)
      cur().text += src.slice(lt + 9, e < 0 ? n : e)
      i = e < 0 ? n : e + 3
      continue
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue }
    // find the tag end, skipping '>' inside quoted attribute values
    let j = lt + 1
    let q = null
    for (; j < n; j++) {
      const c = src[j]
      if (q) { if (c === q) q = null } else if (c === '"' || c === "'") q = c
      else if (c === '>') break
    }
    const body = src.slice(lt + 1, j)
    i = j + 1
    if (body[0] === '/') {
      const name = body.slice(1).trim()
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break }
      continue
    }
    const selfClose = body.endsWith('/')
    const m = /^\s*([^\s/>]+)/.exec(body)
    if (!m) continue
    const el = { name: m[1], attrs: {}, children: [], text: '' }
    const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g
    re.lastIndex = m[0].length
    let a
    while ((a = re.exec(body))) el.attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? '')
    cur().children.push(el)
    if (!selfClose) stack.push(el)
  }
  return top
}

const kids = (el, name) => el.children.filter((c) => c.name === name)
const kid = (el, name) => el.children.find((c) => c.name === name)
const txt = (el) => (el?.text ?? '').trim()

// a multi-language string (<model>A</model><model lang="de">B</model>):
// the untagged one first, translations as alt
const ml = (el, name) => {
  const all = kids(el, name)
  const main = all.find((e) => !e.attrs.lang) ?? all[0]
  if (!main) return { value: null, alt: [] }
  const alt = [...new Set(all.filter((e) => e !== main).map(txt))].filter((s) => s && s !== txt(main))
  return { value: txt(main), alt }
}

// ----------------------------------------------------- lensfun DB → JSON

const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d }
const aspect = (s) => { const [a, b] = s.split(':'); return b !== undefined ? num(a) / num(b) : num(a) }
// mirror the XML's own precision; cuts float noise from JSON
const r6 = (x) => Number.parseFloat(x.toPrecision(6))

const DIST_TERMS = { poly3: ['k1'], poly5: ['k1', 'k2'], ptlens: ['a', 'b', 'c'] }
const TCA_TERMS = { linear: ['kr', 'kb'], poly3: ['vr', 'vb', 'cr', 'cb', 'br', 'bb'] }
const TCA_DEFAULT = { kr: 1, kb: 1, vr: 1, vb: 1 }

// database.cpp _xml_start_element/_xml_text + lens.cpp GuessParameters, for
// the calibration kinds albedo uses. Like lensfun, each kind takes the first
// model met in document order and ignores entries of another model; "acm"
// entries are skipped (no shader for them).
export function extractDb(doc) {
  const db = doc.children.find((c) => c.name === 'lensdatabase') ?? doc
  const mounts = {}
  for (const m of kids(db, 'mount')) {
    const name = ml(m, 'name').value
    if (name) mounts[name] = kids(m, 'compat').map(txt).filter(Boolean)
  }
  const cameras = []
  for (const c of kids(db, 'camera')) {
    const maker = ml(c, 'maker')
    const model = ml(c, 'model')
    const mount = txt(kid(c, 'mount'))
    const crop = num(txt(kid(c, 'cropfactor')))
    if (!maker.value || !model.value || !mount || !(crop > 0)) continue
    const cam = { maker: maker.value, model: model.value, mount, cropFactor: crop }
    const variant = txt(kid(c, 'variant'))
    if (variant) cam.variant = variant
    if (maker.alt.length) cam.makerAlt = maker.alt
    if (model.alt.length) cam.alt = model.alt
    cameras.push(cam)
  }
  const lenses = []
  for (const l of kids(db, 'lens')) {
    const maker = ml(l, 'maker')
    const model = ml(l, 'model')
    const mountsOf = kids(l, 'mount').map(txt).filter(Boolean)
    if (!model.value || !mountsOf.length) continue
    const crop = num(txt(kid(l, 'cropfactor')), 1)
    const ar = kid(l, 'aspect-ratio') ? aspect(txt(kid(l, 'aspect-ratio'))) : 1.5
    if (!(crop > 0) || !(ar >= 1)) continue
    const type = txt(kid(l, 'type')) || 'rectilinear'
    const f = kid(l, 'focal')?.attrs ?? {}
    const ap = kid(l, 'aperture')?.attrs ?? {}
    let minF = num(f.value ?? f.min)
    let maxF = num(f.value ?? f.max)
    let minA = num(ap.value ?? ap.min)
    let maxA = num(ap.value ?? ap.max)

    let dist = null
    let tca = null
    let vig = null
    const calFocals = []
    const vigAps = []
    for (const cal of kids(l, 'calibration')) {
      for (const e of cal.children) {
        const a = e.attrs
        const model = a.model
        if (e.name === 'distortion' || e.name === 'tca' || e.name === 'crop' || e.name === 'field_of_view') calFocals.push(num(a.focal))
        if (e.name === 'vignetting') { calFocals.push(num(a.focal)); vigAps.push(num(a.aperture)) }
        if (e.name === 'distortion' && DIST_TERMS[model]) {
          dist ??= { model, points: [] }
          if (dist.model === model) dist.points.push([num(a.focal), ...DIST_TERMS[model].map((k) => r6(num(a[k])))])
        } else if (e.name === 'tca' && TCA_TERMS[model]) {
          tca ??= { model, points: [] }
          if (tca.model === model) tca.points.push([num(a.focal), ...TCA_TERMS[model].map((k) => r6(num(a[k], TCA_DEFAULT[k] ?? 0)))])
        } else if (e.name === 'vignetting' && model === 'pa') {
          vig ??= { model, points: [] }
          vig.points.push([num(a.focal), num(a.aperture), num(a.distance), r6(num(a.k1)), r6(num(a.k2)), r6(num(a.k3))])
        }
      }
    }
    if (!dist && !tca && !vig) continue

    // GuessParameters: name regexes, then widen by calibration focals (and
    // vignetting apertures), filling only what the XML left unset
    if (!minA || !minF) {
      const g = guessFromName(model.value)
      let lo = g.minFocal || Infinity
      let hi = g.maxFocal || -Infinity
      let alo = g.minAperture || Infinity
      let ahi = -Infinity
      for (const x of calFocals) { lo = Math.min(lo, x); hi = Math.max(hi, x) }
      for (const x of vigAps) { alo = Math.min(alo, x); ahi = Math.max(ahi, x) }
      if (!minF && Number.isFinite(lo)) minF = lo
      if (!maxF && Number.isFinite(hi)) maxF = hi
      if (!minA && Number.isFinite(alo)) minA = alo
      if (!maxA && Number.isFinite(ahi)) maxA = ahi
    }
    if (!maxF) maxF = minF

    const calib = { maker: maker.value, model: model.value, cropFactor: crop, focal: [minF, maxF] }
    if (ar !== 1.5) calib.aspectRatio = r6(ar)
    if (type !== 'rectilinear') calib.type = type
    if (dist) calib.distortion = dist
    if (tca) calib.tca = tca
    if (vig) calib.vignetting = vig
    lenses.push({
      calib,
      entry: {
        maker: maker.value, model: model.value, mounts: mountsOf, cropFactor: crop,
        focal: [minF, maxF], aperture: [minA, maxA],
        ...(ar !== 1.5 ? { aspectRatio: calib.aspectRatio } : {}),
        ...(type !== 'rectilinear' ? { type } : {}),
        ...(maker.alt.length ? { makerAlt: maker.alt } : {}),
        ...(model.alt.length ? { alt: model.alt } : {}),
      },
    })
  }
  return { mounts, cameras, lenses }
}

const slug = (s) => (s || 'unknown').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'

// ------------------------------------------------------------ download

// ustar + pax/GNU long names; yields { path, data } for regular files
function* untar(buf) {
  let off = 0
  let longName = null
  let pax = {}
  const str = (o, l) => { const s = buf.subarray(o, o + l); const z = s.indexOf(0); return s.subarray(0, z < 0 ? l : z).toString('utf8') }
  const parsePax = (data) => {
    const out = {}
    let p = 0
    while (p < data.length) {
      const sp = data.indexOf(0x20, p)
      if (sp < 0) break
      const len = parseInt(data.subarray(p, sp).toString(), 10)
      if (!(len > 0)) break
      const rec = data.subarray(sp + 1, p + len - 1).toString('utf8')
      const eq = rec.indexOf('=')
      out[rec.slice(0, eq)] = rec.slice(eq + 1)
      p += len
    }
    return out
  }
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break
    const size = parseInt(str(off + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(buf[off + 156] || 48)
    const prefix = str(off + 345, 155)
    let name = (prefix ? prefix + '/' : '') + str(off, 100)
    const data = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue }
    if (type === 'x') { pax = parsePax(data); continue }
    if (type === 'g') { yield { global: parsePax(data) }; continue }
    if (pax.path) name = pax.path
    if (longName) name = longName
    longName = null
    pax = {}
    if (type === '0' || type === '\0' || type === '7') yield { path: name, data }
  }
}

async function fetchDb(cache, refresh) {
  mkdirSync(cache, { recursive: true })
  const tgz = join(cache, 'lensfun-master.tar.gz')
  if (refresh || !existsSync(tgz) || statSync(tgz).size < 100_000) {
    console.log(`lensfun: fetching ${TARBALL}`)
    const res = await fetch(TARBALL)
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${TARBALL}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100_000) throw new Error(`tarball too small (${buf.length}B)`)
    writeFileSync(tgz + '.tmp', buf)
    renameSync(tgz + '.tmp', tgz)
  } else console.log(`lensfun: using cached ${tgz}`)
  const dbDir = join(cache, 'db')
  rmSync(dbDir, { recursive: true, force: true })
  mkdirSync(dbDir, { recursive: true })
  let commit = null
  const files = []
  for (const e of untar(gunzipSync(readFileSync(tgz)))) {
    if (e.global) { commit = e.global.comment ?? commit; continue }
    const m = /^[^/]+\/data\/db\/([^/]+\.xml)$/.exec(e.path)
    if (!m) continue
    writeFileSync(join(dbDir, m[1]), e.data)
    files.push(m[1])
  }
  if (!files.length) throw new Error('no data/db/*.xml in tarball')
  return { dbDir, files: files.sort(), commit, fetched: statSync(tgz).mtime.toISOString().slice(0, 10) }
}

// ---------------------------------------------------------------- main

const LICENSE = (commit, date) => `Lens calibration data in this directory is derived from the lensfun database
(https://github.com/lensfun/lensfun, data/db/*.xml, branch master${commit ? `, commit ${commit}` : ''},
fetched ${date}).

Copyright (c) the lensfun project and its contributors; see
https://github.com/lensfun/lensfun for the list of authors and calibrators.

The lensfun database is licensed under the Creative Commons Attribution-Share
Alike 3.0 license (CC BY-SA 3.0): https://creativecommons.org/licenses/by-sa/3.0/

Changes: the XML was converted to JSON by albedo's scripts/build-lensfun.mjs,
keeping cameras, mounts and the distortion (poly3/poly5/ptlens), TCA
(linear/poly3) and vignetting (pa) calibration of each lens; other entries
(acm models, crop, field of view, real focal length, lens centre) were dropped.

These JSON files are distributed under the same CC BY-SA 3.0 license. This
license applies to the data only; albedo's code is AGPL-3.0-only.
`

async function main() {
  const cache = process.env.LENSFUN_CACHE || new URL('../.cache/lensfun', import.meta.url).pathname
  const out = join(root, 'public/lensfun')
  const { dbDir, files, commit, fetched } = await fetchDb(cache, process.argv.includes('--refresh'))

  const mounts = {}
  const cameras = []
  const lenses = []
  for (const f of files) {
    let doc
    try { doc = extractDb(parseXml(readFileSync(join(dbDir, f), 'utf8'))) } catch (err) { console.warn(`lensfun: skip ${f}: ${err.message}`); continue }
    for (const [k, v] of Object.entries(doc.mounts)) mounts[k] = [...new Set([...(mounts[k] ?? []), ...v])]
    cameras.push(...doc.cameras)
    lenses.push(...doc.lenses)
  }

  const byFile = new Map()
  const index = { source: { repo: 'https://github.com/lensfun/lensfun', branch: 'master', commit, fetched, license: 'CC BY-SA 3.0' }, mounts, cameras, lenses: [] }
  for (const { calib, entry } of lenses) {
    const file = `${slug(entry.maker)}.json`
    if (!byFile.has(file)) byFile.set(file, [])
    const arr = byFile.get(file)
    index.lenses.push({ ...entry, file, i: arr.length })
    arr.push(calib)
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  let total = 0
  const write = (name, s) => { writeFileSync(join(out, name), s); total += Buffer.byteLength(s) }
  write('index.json', JSON.stringify(index))
  for (const [file, arr] of byFile) write(file, JSON.stringify(arr))
  write('LICENSE', LICENSE(commit, fetched))
  console.log(`lensfun: ${files.length} xml → ${cameras.length} cameras, ${index.lenses.length} calibrated lenses, ${byFile.size} lens files`)
  console.log(`lensfun: public/lensfun ${(total / 1024).toFixed(0)} KiB total${commit ? ` (commit ${commit.slice(0, 12)})` : ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
