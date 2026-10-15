// Lens profile for an opened photo: EXIF → lensfun calibration → the shader
// terms of the develop pass (slots 96..111, layout in develop.wgsl). The
// database is static JSON under lensfun/ next to the app, fetched on the
// first RAW and cached; each maker file is fetched once.
import { matchLens, correctionAt, shaderParams } from './lensfun.js'

let index = null
const files = new Map()

const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null)

// base: the app's root URL; exif: the decode payload's exif
// → { name, maker, distortion: [a1..a4] | null, tca, vignetting } | null
export async function lensProfileFor(base, exif) {
  if (!exif?.lens && !exif?.model) return null
  index ??= (await json(new URL('lensfun/index.json', base))) ?? false
  if (!index) return null
  const m = matchLens(index, {
    cameraMaker: exif.make, cameraModel: exif.model, lensModel: exif.lens ?? '', focal: exif.focal ?? 0,
  })
  // fisheyes and other projections need a remap, not a radial polynomial
  if (!m.lens || m.lens.type) return null
  if (!files.has(m.lens.file)) files.set(m.lens.file, json(new URL(`lensfun/${m.lens.file}`, base)))
  const calib = (await files.get(m.lens.file))?.[m.lens.i]
  if (!calib) return null
  const crop = m.camera?.cropFactor ?? 0
  const corr = correctionAt(calib, { focal: exif.focal ?? 0, aperture: exif.aperture ?? 0, cropFactor: crop })
  const sp = shaderParams(corr, { imageCrop: crop || undefined })
  if (!sp.distortion && !sp.tca && !sp.vignetting) return null
  return {
    name: m.lens.model,
    maker: m.lens.maker,
    distortion: sp.distortion ? sp.distortion.slice(1) : null,
    tca: sp.tca,
    vignetting: sp.vignetting,
  }
}

// write the profile into a params array, scaled by the user's amounts
// (0..200, 100 = the calibration as measured)
export function packLensProfile(p, prof, distAmount = 100, vigAmount = 100) {
  if (!prof) return
  const kd = distAmount / 100
  const kv = vigAmount / 100
  p[96] = 1
  const d = prof.distortion ?? [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) p[97 + i] = d[i] * kd
  const t = prof.tca ?? { red: [1, 0, 0], blue: [1, 0, 0] }
  p.set(t.red, 101)
  p.set(t.blue, 104)
  const v = prof.vignetting ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) p[107 + i] = v[i] * kv
}
