// Puts the local AI models into public/models/ and the onnxruntime-web
// runtime into public/ort/ (both gitignored, served by the app itself).
// Downloads are checked against their SHA-256 and kept in a cache
// (ALBEDO_MODEL_CACHE, default .cache/models). Models marked fp16 are
// stored at half precision (scripts/fp16.py) when Python with onnx and numpy
// is available (PYTHON, default python3); otherwise the float32 file is used.
// Run: npm run setup-models
import { mkdirSync, existsSync, statSync, copyFileSync, createReadStream, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { MODELS } from '../src/engine/models.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = process.env.ALBEDO_MODEL_CACHE ?? join(root, '.cache/models')
const python = process.env.PYTHON ?? 'python3'
const out = join(root, 'public/models')
for (const d of [cache, out, join(root, 'public/ort')]) mkdirSync(d, { recursive: true })

// the WebGPU bundle runs both execution providers on this one wasm
const ORT = 'ort-wasm-simd-threaded.asyncify.wasm'
copyFileSync(join(root, 'node_modules/onnxruntime-web/dist', ORT), join(root, 'public/ort', ORT))
console.log(`ort: ${ORT}`)

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(file).on('data', (b) => h.update(b)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
})

// one member of a zip archive (stored or deflated), via the central directory
function unzipMember(zipFile, name) {
  const z = readFileSync(zipFile)
  let e = z.length - 22
  while (e >= 0 && z.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error(`${zipFile}: not a zip`)
  let p = z.readUInt32LE(e + 16)
  const n = z.readUInt16LE(e + 10)
  for (let i = 0; i < n; i++) {
    const method = z.readUInt16LE(p + 10)
    const size = z.readUInt32LE(p + 20)
    const nameLen = z.readUInt16LE(p + 28)
    const extra = z.readUInt16LE(p + 30)
    const comment = z.readUInt16LE(p + 32)
    const local = z.readUInt32LE(p + 42)
    const entry = z.subarray(p + 46, p + 46 + nameLen).toString()
    if (entry === name || entry.endsWith('/' + name)) {
      const start = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28)
      const data = z.subarray(start, start + size)
      return method === 0 ? data : inflateRawSync(data)
    }
    p += 46 + nameLen + extra + comment
  }
  throw new Error(`${zipFile}: no ${name}`)
}

const canHalve = spawnSync(python, ['-c', 'import onnx, numpy'], { stdio: 'ignore' }).status === 0
if (!canHalve) console.log(`fp16: ${python} lacks onnx/numpy — using float32 files`)

for (const [id, m] of Object.entries(MODELS)) {
  const dest = join(out, m.file)
  if (existsSync(dest) && statSync(dest).size >= m.minBytes) {
    console.log(`${id}: present (${statSync(dest).size} B)`)
    continue
  }
  const src = join(cache, m.member ? m.source.split('/').pop() : m.file)
  if (!existsSync(src) || (await sha256(src)) !== m.sha256) {
    console.log(`${id}: fetching ${m.source}`)
    const res = await fetch(m.source)
    if (!res.ok) throw new Error(`${m.source}: ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(src + '.part'))
    renameSync(src + '.part', src)
    const got = await sha256(src)
    if (got !== m.sha256) { rmSync(src); throw new Error(`${m.file}: sha256 ${got}, expected ${m.sha256}`) }
  }
  if (m.member) {
    writeFileSync(dest + '.part', unzipMember(src, m.member))
    renameSync(dest + '.part', dest)
  } else if (m.fp16 && canHalve) {
    const r = spawnSync(python, [join(root, 'scripts/fp16.py'), src, dest + '.part'], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`${m.file}: fp16 conversion failed`)
    renameSync(dest + '.part', dest)
  } else {
    copyFileSync(src, dest)
  }
  console.log(`${id}: ${m.file} (${statSync(dest).size} B)`)
}
console.log('setup-models done')
