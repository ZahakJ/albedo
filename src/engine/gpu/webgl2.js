import vertSrc from './shaders/glsl/develop.vert?raw'
import fragSrc from './shaders/glsl/develop.frag?raw'
import demosaicFragSrc from './shaders/glsl/demosaic.frag?raw'
import rcdFragSrc from './shaders/glsl/rcd.frag?raw'
import xtransFragSrc from './shaders/glsl/xtrans.frag?raw'
import { hlChroma } from '../hlchroma.js'
import { tilesFor, tileExtent } from './tiles.js'
import blurFragSrc from './shaders/glsl/blur.frag?raw'
import nrFragSrc from './shaders/glsl/nr.frag?raw'
import finishFragSrc from './shaders/glsl/finish.frag?raw'
import stampFragSrc from './shaders/glsl/stamp.frag?raw'

// WebGL2 backend — the fallback that must reach full parity with WebGPU.
// The user's own daily browser may run this path (Linux Firefox has no WebGPU).
export function createWebGl2(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false })
  if (!gl) return null

  const compile = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`)
    }
    return s
  }
  const link = (frag) => {
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vertSrc))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`program link: ${gl.getProgramInfoLog(p)}`)
    }
    return p
  }

  const prog = link(fragSrc)
  gl.useProgram(prog)
  const uImg = gl.getUniformLocation(prog, 'img')
  const uP = gl.getUniformLocation(prog, 'P[0]') ?? gl.getUniformLocation(prog, 'P')
  const uM = gl.getUniformLocation(prog, 'M[0]') ?? gl.getUniformLocation(prog, 'M')
  const uHl = gl.getUniformLocation(prog, 'Hl[0]') ?? gl.getUniformLocation(prog, 'Hl')
  const uPt = gl.getUniformLocation(prog, 'Pt[0]') ?? gl.getUniformLocation(prog, 'Pt')
  const uLin = gl.getUniformLocation(prog, 'inputIsLinear')
  const uVFlip = gl.getUniformLocation(prog, 'vFlip')
  const uCurve = gl.getUniformLocation(prog, 'curveTex')
  gl.uniform1i(uImg, 0)
  gl.uniform1i(uCurve, 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'blurSmall'), 2)
  gl.uniform1i(gl.getUniformLocation(prog, 'blurLarge'), 3)
  gl.uniform1i(gl.getUniformLocation(prog, 'brushTex'), 4)
  gl.uniform1i(gl.getUniformLocation(prog, 'patchTex'), 5)
  // removal patches of the open photo: atlas texture + rects (patchU)
  let patchTexture = null
  let patchRects = new Float32Array(192)
  gl.uniform1i(gl.getUniformLocation(prog, 'dnTex'), 6)
  let dnTexture = null // AI-denoised capture of the open photo (unit 6)
  // DCP camera profile tables (units 7, 8); dummies keep the units complete
  gl.uniform1i(gl.getUniformLocation(prog, 'hsvLut'), 7)
  gl.uniform1i(gl.getUniformLocation(prog, 'toneTex'), 8)
  const dummy3d = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_3D, dummy3d)
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  const dummyTone = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, dummyTone)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  let hsvTexture = null
  let toneTexture = null
  let dnFbo = null
  const ZERO_MASKS = new Float32Array(192)
  const ZERO_HEAL = new Float32Array(256)

  // 1×1 black stands in on units 2/3 whenever no blur pyramid exists —
  // the shader gates sampling on lcOn but the units must stay complete
  const dummyTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, dummyTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255]))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  // 1×1 TRANSPARENT stand-in for brushTex (alpha must read 0: channel 3 is a
  // live brush-mask slot, unlike the opaque dummy above)
  const dummyBrush = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, dummyBrush)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  // 512×1 R32F point-curve LUT on unit 1. NEAREST + in-shader lerp: R32F is
  // uploadable everywhere but filterable nowhere without an extension.
  const curveTexture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, curveTexture)
  const identity = new Float32Array(512)
  for (let i = 0; i < 512; i++) identity[i] = i / 511
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 512, 1, 0, gl.RED, gl.FLOAT, identity)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.activeTexture(gl.TEXTURE0)
  let lastLut = identity
  const setLut = (lut) => {
    if (!lut || lut === lastLut) return
    lastLut = lut
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, curveTexture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED, gl.FLOAT, lut)
    gl.activeTexture(gl.TEXTURE0)
  }

  // demosaic program is compiled lazily: plain JPEG/PNG sessions never need it
  let dm = null
  const demosaicProg = () => {
    if (dm) return dm
    const p = link(demosaicFragSrc)
    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'img'), 0)
    dm = {
      prog: p,
      uMat: gl.getUniformLocation(p, 'camToSrgb'),
      uMul: gl.getUniformLocation(p, 'camMul'),
      uBW: gl.getUniformLocation(p, 'blackWhite'),
      uCfa: gl.getUniformLocation(p, 'cfa'),
      uDims: gl.getUniformLocation(p, 'dims'),
      uMode: gl.getUniformLocation(p, 'mode'),
      uFlip: gl.getUniformLocation(p, 'flipY'),
      uGamma: gl.getUniformLocation(p, 'srcGamma'),
      uRecon: gl.getUniformLocation(p, 'recon'),
    }
    return dm
  }

  // Raw front ends (rcd.frag, xtrans.frag), one program per pass, compiled
  // on the first RAW of each kind; run tile by tile like the WebGPU twin
  const chains = {}
  const chainFor = (kind) => {
    if (chains[kind]) return chains[kind]
    const xt = kind === 'xtrans'
    const names = xt ? ['prep', 'hlr', 'green', 'final'] : ['prep', 'hlr', 'vh', 'lpf', 'green', 'pq', 'rb', 'final', 'dnblit']
    const src = xt ? xtransFragSrc : rcdFragSrc
    const c = { progs: {}, fmt: xt
      ? { prep: 'r32', hlr: 'r32', green: 'r32' }
      : { prep: 'r32', hlr: 'r32', vh: 'r16', lpf: 'r32', green: 'r32', pq: 'r16', rb: 'r32' } }
    names.forEach((name, i) => {
      const p = link(`#version 300 es\n#define PASS ${i + 1}\n${src}`)
      gl.useProgram(p)
      const locs = new Map()
      const u = (n) => {
        if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n))
        return locs.get(n)
      }
      gl.uniform1i(u('mosaic'), 0)
      for (let t = 0; t < 4; t++) gl.uniform1i(u(`t${t}`), t + 1)
      c.progs[name] = { prog: p, u }
    })
    chains[kind] = c
    return c
  }

  const demosaicRaw = (p, recon) => {
    const c = chainFor(p.kind)
    const { width: w, height: h } = p
    p.hl ??= hlChroma(p)
    const stride = p.rawWidth ?? w
    const left = p.left ?? 0
    const top = p.top ?? 0
    const [ew, eh] = tileExtent(w, h)
    const mk = (internal, format, type, tw, th, filter) => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, format, type, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return t
    }
    const tex = {}
    for (const [name, f] of Object.entries(c.fmt)) {
      tex[name] = f === 'r32'
        ? mk(gl.R32F, gl.RED, gl.FLOAT, ew, eh, gl.NEAREST)
        : mk(gl.R16F, gl.RED, gl.HALF_FLOAT, ew, eh, gl.NEAREST)
    }
    const mosaicTex = mk(gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ew, eh, gl.NEAREST)
    const out = mk(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, w, h, gl.LINEAR)
    const hlr = recon && p.hl.clipped
    const cfa = hlr ? 'hlr' : 'prep'
    const xt = p.kind === 'xtrans'
    const steps = xt
      ? [['prep', []], ...(hlr ? [['hlr', ['prep']]] : []), ['green', [cfa]]]
      : [['prep', []], ...(hlr ? [['hlr', ['prep']]] : []), ['vh', [cfa]], ['lpf', [cfa]],
        ['green', [cfa, 'lpf', null, 'vh']], ['pq', [cfa]], ['rb', [cfa, 'green', null, 'pq']]]
    const finalIns = xt ? [cfa, 'green'] : [cfa, 'green', 'rb', 'vh']
    const pat = xt ? Float32Array.from(p.xtrans) : null
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    const run = (name, ins, target, t, posOff) => {
      const { prog: pr, u } = c.progs[name]
      gl.useProgram(pr)
      gl.uniform3fv(u('camMul'), p.camMul)
      gl.uniform3fv(u('clipLvl'), p.hl.clip)
      gl.uniform3fv(u('chroma'), p.hl.chroma)
      gl.uniformMatrix3fv(u('camToSrgb'), true, p.camToSrgb)
      gl.uniform2f(u('blackWhite'), p.black, p.white)
      gl.uniform2f(u('cfa'), p.cfa[0], p.cfa[1])
      gl.uniform2f(u('dims'), w, h)
      gl.uniform2f(u('org'), t.rx, t.ry)
      gl.uniform2f(u('posOff'), posOff[0], posOff[1])
      gl.uniform2f(u('tdims'), t.rw, t.rh)
      gl.uniform1f(u('flipY'), 1) // the final pass stores v=0 = bottom
      if (pat) gl.uniform4fv(u('pat'), pat)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, mosaicTex)
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE1 + i)
        gl.bindTexture(gl.TEXTURE_2D, ins[i] ? tex[ins[i]] : null)
      }
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride)
    for (const t of tilesFor(w, h)) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, mosaicTex)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, left + t.rx)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, top + t.ry)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.rw, t.rh, gl.RED_INTEGER, gl.UNSIGNED_SHORT, p.buffer)
      gl.viewport(0, 0, t.rw, t.rh)
      for (const [name, ins] of steps) run(name, ins, tex[name], t, [t.rx, t.ry])
      // final: image coordinates, rows flipped into this backend's convention
      gl.viewport(t.x0, h - t.y1, t.x1 - t.x0, t.y1 - t.y0)
      run('final', finalIns, out, t, [0, 0])
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    for (let i = 0; i < 5; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, null)
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(mosaicTex)
    for (const t of Object.values(tex)) gl.deleteTexture(t)
    gl.useProgram(prog)
    return { texture: out, width: w, height: h, isLinear: 1 }
  }

  // blur program compiled lazily: only local-contrast edits ever need it
  let bl = null
  const blurProg = () => {
    if (bl) return bl
    const p = link(blurFragSrc)
    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'img'), 0)
    bl = {
      prog: p,
      uDir: gl.getUniformLocation(p, 'dir'),
      uSigma: gl.getUniformLocation(p, 'sigma'),
      uRadius: gl.getUniformLocation(p, 'radius'),
      uFlip: gl.getUniformLocation(p, 'vFlip'),
      uLinz: gl.getUniformLocation(p, 'linearize'),
    }
    return bl
  }

  // nr program (à-trous wavelet denoise) compiled lazily like blur
  let nrp = null
  const nrProg = () => {
    if (nrp) return nrp
    const p = link(nrFragSrc)
    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'img'), 0)
    gl.uniform1i(gl.getUniformLocation(p, 'orig'), 1)
    nrp = {
      prog: p,
      uDir: gl.getUniformLocation(p, 'dir'),
      uTl: gl.getUniformLocation(p, 'tl'),
      uTc: gl.getUniformLocation(p, 'tc'),
      uComb: gl.getUniformLocation(p, 'combine'),
    }
    return nrp
  }

  // finish program (output-referred unsharp) + the develop→finish
  // intermediate rgba8 target, cached by size (display re-renders every
  // frame; export sizes just realloc)
  let fp = null
  const finProg = () => {
    if (fp) return fp
    const p = link(finishFragSrc)
    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'img'), 0)
    gl.uniform1i(gl.getUniformLocation(p, 'brushTex'), 1)
    fp = { prog: p, uF: gl.getUniformLocation(p, 'F[0]') ?? gl.getUniformLocation(p, 'F') }
    return fp
  }

  // stamp program (brush disc accumulation) compiled lazily like blur
  let st = null
  const stampProg = () => {
    if (st) return st
    const p = link(stampFragSrc)
    gl.useProgram(p)
    st = {
      prog: p,
      uS: gl.getUniformLocation(p, 'S'),
      uDims: gl.getUniformLocation(p, 'dims'),
      uPT: gl.getUniformLocation(p, 'PT[0]') ?? gl.getUniformLocation(p, 'PT'),
    }
    return st
  }
  let finT = null
  const finTarget = (w, h) => {
    if (finT?.w === w && finT?.h === h) return finT
    if (finT) { gl.deleteTexture(finT.tex); gl.deleteFramebuffer(finT.fbo) }
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    finT = { w, h, tex, fbo }
    return finT
  }
  // f: { amount, sigma, maskT, maskPreview, clipOverlay, wash?, grain?,
  // geom?, split? } — layout in finish.frag; geom = { geom: [angle,x,y,w,h,
  // fit], srcW, srcH, perspV, perspH, distortion } (filled whenever wash or
  // grain runs), wash = { rec: Float32Array(24) }, grain = { amount, cell
  // (source px), rough 0..1 }, split = { dir: 'h'|'v', pos 0..1 } paints the
  // divider. Pure 1:1 sampling pass, so orientation flows through untouched.
  const finUniforms = (f) => {
    const u = new Float32Array(48)
    u.set([f.amount, f.sigma, f.maskT, f.maskPreview ? 1 : 0, f.clipOverlay ? 1 : 0])
    const g = f.geom
    if (g) {
      u[6] = g.srcW
      u[7] = g.srcH
      u.set(g.geom.slice(0, 6), 8) // angle, crop x/y/w/h, fitScale
      u[14] = g.perspV ?? 0
      u[15] = g.perspH ?? 0
      u[43] = g.distortion ?? 0
    }
    if (f.wash) {
      u[5] = 1
      u.set(f.wash.rec, 16)
    }
    if (f.grain) {
      u[40] = f.grain.amount
      u[41] = f.grain.cell
      u[42] = f.grain.rough
    }
    if (f.split) {
      u[44] = f.split.dir === 'v' ? 2 : 1
      u[45] = f.split.pos
    }
    return u
  }
  const finish = (srcTex, w, h, f, brush) => {
    const p = finProg()
    gl.useProgram(p.prog)
    gl.viewport(0, 0, w, h)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, brush?.texture ?? dummyBrush)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform4fv(p.uF, finUniforms(f))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.useProgram(prog)
  }

  // GL renders with a bottom-left origin. Bitmap textures land top-down (see
  // uploadImage) and carry flip=1, honored here; demosaic intermediates are
  // written bottom-up and need none. Export readbacks flip rows back.
  // aux (optional): { small, large } blur pyramid from computeAux — the blur
  // passes bake the flip in, so the shader samples them unflipped.
  // masks: Float32Array(192) masksU | null; brush: createBrushTex handle |
  // null; heal: Float32Array(256) healU | null
  const draw = (img, params, w, h, lut, aux, masks, brush, heal) => {
    gl.useProgram(prog)
    setLut(lut)
    gl.viewport(0, 0, w, h)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, curveTexture)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, aux?.small.texture ?? dummyTex)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, aux?.large.texture ?? dummyTex)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, brush?.texture ?? dummyBrush)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, img.texture)
    gl.uniform4fv(uP, params) // 128 floats — layout comment in develop.frag
    gl.uniform4fv(uM, masks ?? ZERO_MASKS) // 192 floats — masksU
    gl.uniform4fv(uHl, heal ?? ZERO_HEAL) // 256 floats — healU
    gl.uniform4fv(uPt, patchRects) // 192 floats — patchU
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_2D, patchTexture ?? dummyTex)
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, dnTexture ?? dummyTex)
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_3D, hsvTexture ?? dummy3d)
    gl.activeTexture(gl.TEXTURE8)
    gl.bindTexture(gl.TEXTURE_2D, toneTexture ?? dummyTone)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1f(uLin, params[11])
    gl.uniform1f(uVFlip, img.flip ?? 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  return {
    backend: 'webgl2',
    limits: { maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) },

    uploadImage(bitmap) {
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      // UNPACK_FLIP_Y_WEBGL is IGNORED for ImageBitmap sources (spec), so the
      // texture lands top-down; the develop shader flips v for flagged images.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return { texture, width: bitmap.width, height: bitmap.height, flip: 1 }
    },

    // decoded RAW payload → linear rgba16f via the demosaic/camera-color pass,
    // run once here: it is edit-independent EXCEPT recon (highlight
    // reconstruction) — the worker re-runs this when modules.recon toggles.
    // Rendering to rgba16f needs EXT_color_buffer_float (sampling it doesn't).
    uploadDecoded(p, recon = 1) {
      if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error('EXT_color_buffer_float unavailable: cannot render RAW intermediate')
      }
      const mosaic = p.kind === 'mosaic'
      if (mosaic || p.kind === 'xtrans') return demosaicRaw(p, recon)
      const src = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1) // mosaic rows are w*2 bytes, w may be odd
      if (mosaic) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, p.width, p.height, 0,
          gl.RED_INTEGER, gl.UNSIGNED_SHORT, p.buffer)
      } else if (p.bitDepth === 16) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, p.width, p.height, 0,
          gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, p.buffer)
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, p.width, p.height, 0,
          gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, p.buffer)
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      const target = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, target)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, p.width, p.height, 0, gl.RGBA, gl.HALF_FLOAT, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      const d = demosaicProg()
      gl.useProgram(d.prog)
      // row-major payload matrix; transpose=true gives srgb = M(rows) * cam
      gl.uniformMatrix3fv(d.uMat, true, p.camToSrgb)
      gl.uniform3fv(d.uMul, p.camMul)
      gl.uniform2f(d.uBW, p.black, p.white)
      gl.uniform2f(d.uCfa, p.cfa[0], p.cfa[1])
      gl.uniform2f(d.uDims, p.width, p.height)
      gl.uniform1f(d.uMode, mosaic ? 0 : 1)
      gl.uniform1f(d.uFlip, 1) // demosaic in image space, store v=0 = bottom
      gl.uniform1f(d.uGamma, p.linear ? 0 : 1)
      gl.uniform1f(d.uRecon, recon ? 1 : 0)

      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      gl.viewport(0, 0, p.width, p.height)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(src)
      gl.useProgram(prog)
      // the pass decodes any source curve, so the intermediate is always linear
      return { texture: target, width: p.width, height: p.height, isLinear: 1 }
    },

    // Blur pyramid for the local-contrast family: blurSmall = σ 3px·scale at
    // source res (texture), blurLarge = σ 40px·scale, computed at QUARTER res
    // (σ 10px there) — cost stays sane and the combine samples it bilinearly.
    // Both scene-linear rgba16f; edit-independent, so callers cache per photo.
    // scale = renderW/fullW keeps preview and export blurs image-relative.
    computeAux(img, scale = 1) {
      if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error('EXT_color_buffer_float unavailable: cannot render blur pyramid')
      }
      const { width: w, height: h } = img
      const flip = img.flip ?? 0
      const linz = img.isLinear ? 0 : 1
      const target = (tw, th) => {
        const t = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return t
      }
      const b = blurProg()
      const fbo = gl.createFramebuffer()
      gl.useProgram(b.prog)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.activeTexture(gl.TEXTURE0)
      // src flags apply to the FIRST tap of a chain only; later passes read
      // already-linear, already-unflipped intermediates
      const pass = (src, dst, dw, dh, dx, dy, sigma, radius, first) => {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0)
        gl.viewport(0, 0, dw, dh)
        gl.bindTexture(gl.TEXTURE_2D, src)
        gl.uniform2f(b.uDir, dx, dy)
        gl.uniform1f(b.uSigma, sigma)
        gl.uniform1f(b.uRadius, radius)
        gl.uniform1f(b.uFlip, first ? flip : 0)
        gl.uniform1f(b.uLinz, first ? linz : 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      const sS = 3 * scale
      const rS = Math.min(64, Math.max(1, Math.ceil(2.5 * sS)))
      const tmp = target(w, h)
      const small = target(w, h)
      pass(img.texture, tmp, w, h, 1 / w, 0, sS, rS, true)
      pass(tmp, small, w, h, 0, 1 / h, sS, rS, false)
      // large: two 2× box downsamples (bilinear tap at quarter centers), then
      // the separable blur at quarter res
      const hw = Math.max(1, Math.round(w / 2))
      const hh = Math.max(1, Math.round(h / 2))
      const qw = Math.max(1, Math.round(hw / 2))
      const qh = Math.max(1, Math.round(hh / 2))
      const sL = (40 * scale) / 4
      const rL = Math.min(64, Math.max(1, Math.ceil(2.5 * sL)))
      const half = target(hw, hh)
      const q1 = target(qw, qh)
      const q2 = target(qw, qh)
      pass(img.texture, half, hw, hh, 0, 0, 1, 0, true)
      pass(half, q1, qw, qh, 0, 0, 1, 0, false)
      pass(q1, q2, qw, qh, 1 / qw, 0, sL, rL, false)
      pass(q2, q1, qw, qh, 0, 1 / qh, sL, rL, false) // q1 becomes blurLarge
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tmp)
      gl.deleteTexture(half)
      gl.deleteTexture(q2)
      gl.useProgram(prog)
      return {
        small: { texture: small, width: w, height: h },
        large: { texture: q1, width: qw, height: qh },
        destroy() { gl.deleteTexture(small); gl.deleteTexture(q1) },
      }
    },

    // À-trous wavelet denoise: 3 levels, 5-tap B3 kernel at holes 1/2/4, run
    // separably (H, then V fused with the per-level soft-threshold
    // reconstruct — see nr.frag). Seeded by a radius-0 blur pass so the chain
    // is scene-linear and unflipped. Output replaces the develop input
    // texture (flip 0, isLinear 1). 7 full-res passes; callers cache per
    // (photoId, lumaNR, chromaNR).
    computeNR(img, lumaNR, chromaNR) {
      if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error('EXT_color_buffer_float unavailable: cannot render NR chain')
      }
      const { width: w, height: h } = img
      const mk = () => {
        const t = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return t
      }
      const b = blurProg()
      const n = nrProg()
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.viewport(0, 0, w, h)
      let a = mk()
      let out = mk()
      const tmp = mk()
      // seed: radius-0 blur = linearize+unflip copy (parity with computeAux)
      gl.useProgram(b.prog)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, img.texture)
      gl.uniform2f(b.uDir, 0, 0)
      gl.uniform1f(b.uSigma, 1)
      gl.uniform1f(b.uRadius, 0)
      gl.uniform1f(b.uFlip, img.flip ?? 0)
      gl.uniform1f(b.uLinz, img.isLinear ? 0 : 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.useProgram(n.prog)
      const kL = (lumaNR / 100) ** 2
      const kC = (chromaNR / 100) ** 2
      const TL = [0.02, 0.012, 0.008]
      const TC = [0.05, 0.03, 0.02]
      for (let i = 0; i < 3; i++) {
        const hole = 1 << i
        // H: a → tmp (plain à-trous blur; orig on unit 1 unused but complete)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmp, 0)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, a)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, a)
        gl.uniform2f(n.uDir, hole / w, 0)
        gl.uniform1f(n.uComb, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        // V + threshold reconstruct: (tmp, orig=a) → out
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0)
        gl.bindTexture(gl.TEXTURE_2D, tmp)
        gl.uniform2f(n.uDir, 0, hole / h)
        gl.uniform1f(n.uTl, kL * TL[i])
        gl.uniform1f(n.uTc, kC * TC[i])
        gl.uniform1f(n.uComb, 1)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        ;[a, out] = [out, a]
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tmp)
      gl.deleteTexture(out)
      gl.useProgram(prog)
      const tex = a
      return {
        img: { texture: tex, width: w, height: h, isLinear: 1 },
        destroy() { gl.deleteTexture(tex) },
      }
    },

    resize(w, h) {
      canvas.width = w
      canvas.height = h
    },

    // ── brush mask texture: quarter-res rgba8, one channel per brush mask ──
    createBrushTex(w, h) {
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const t = { texture, fbo, width: w, height: h, destroy() { gl.deleteTexture(texture); gl.deleteFramebuffer(fbo) } }
      this.clearBrush(t)
      return t
    },

    clearBrush(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    },

    // full-RGBA base upload (AI-mask channels); row 0 = image top, matching
    // the stamp pass convention. Stamps land after this via colorMask.
    uploadBrushRGBA(t, data) {
      gl.bindTexture(gl.TEXTURE_2D, t.texture)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    },

    // pts: [[x, y, pressure], ..] in y-down source-normalized (pre-mirror)
    // coords; size = diameter as a source-WIDTH fraction; batches of 64.
    // Normal: MAX blend (flow-accumulate); erase: dst · Π(1−vᵢ).
    stampBrush(t, channel, pts, size, flow, erase, srcW, srcH) {
      const sp = stampProg()
      gl.useProgram(sp.prog)
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.viewport(0, 0, t.width, t.height)
      gl.enable(gl.BLEND)
      gl.colorMask(channel === 0, channel === 1, channel === 2, channel === 3)
      if (erase) {
        gl.blendEquation(gl.FUNC_ADD)
        gl.blendFunc(gl.ZERO, gl.SRC_COLOR)
      } else {
        gl.blendEquation(gl.MAX)
        gl.blendFunc(gl.ONE, gl.ONE)
      }
      const u = new Float32Array(256)
      for (let i = 0; i < pts.length; i += 64) {
        const batch = pts.slice(i, i + 64)
        u.fill(0)
        batch.forEach((p, j) => u.set([p[0], p[1], p[2] ?? 1], j * 4))
        gl.uniform4f(sp.uS, batch.length, size, flow, erase ? 1 : 0)
        gl.uniform2f(sp.uDims, srcW, srcH)
        gl.uniform4fv(sp.uPT, u)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      gl.disable(gl.BLEND)
      gl.blendEquation(gl.FUNC_ADD)
      gl.colorMask(true, true, true, true)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.useProgram(prog)
    },

    // fin (optional): finish-pass descriptor — develop renders to an
    // intermediate rgba8 and finish (unsharp + clip + wash) hits the target.
    // split (optional, display only): { params2, lut2, dir 'h'|'v', pos } —
    // the BEFORE doc draws full-frame first, the current doc scissors over
    // its half, and the finish pass (forced non-null by the worker when
    // split is active) paints the divider. GL origin is bottom-left, so the
    // 'v' after-region (image bottom) is the LOW y band.
    render(img, params, lut, aux, fin, masks, brush, heal, split) {
      if (!fin) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        draw(img, params, canvas.width, canvas.height, lut, aux, masks, brush, heal)
        return
      }
      const w = canvas.width
      const h = canvas.height
      const t = finTarget(w, h)
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      if (split) {
        draw(img, split.params2, w, h, split.lut2, aux, null, null, null)
        gl.enable(gl.SCISSOR_TEST)
        if (split.dir === 'v') gl.scissor(0, 0, w, h - Math.round(split.pos * h))
        else gl.scissor(Math.round(split.pos * w), 0, w - Math.round(split.pos * w), h)
        draw(img, params, w, h, lut, aux, masks, brush, heal)
        gl.disable(gl.SCISSOR_TEST)
      } else {
        draw(img, params, w, h, lut, aux, masks, brush, heal)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      finish(t.tex, w, h, fin, brush)
    },

    // 5×5 average of the PRE-develop source texture at y-down source-
    // normalized (u,v) → scene-linear [r,g,b]. RAW intermediates (isLinear,
    // rgba16f, stored bottom-up) read back as floats; bitmap uploads (flip=1,
    // top-down sRGB bytes) decode to linear here. Feeds WB eyedropper/auto —
    // NR is deliberately ignored: it barely moves a 5×5 mean.
    readSource(img, u, v, n = 5) {
      const px = Math.min(img.width - 1, Math.max(0, Math.round(u * img.width)))
      const py = Math.min(img.height - 1, Math.max(0, Math.round(v * img.height)))
      const row = img.flip ? py : img.height - 1 - py // texture row of that image px
      const x0 = Math.max(0, Math.min(img.width - n, px - (n >> 1)))
      const y0 = Math.max(0, Math.min(img.height - n, row - (n >> 1)))
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, img.texture, 0)
      const out = [0, 0, 0]
      const m = n * n
      if (img.isLinear) {
        const b = new Float32Array(m * 4)
        gl.readPixels(x0, y0, n, n, gl.RGBA, gl.FLOAT, b)
        for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) out[c] += b[i * 4 + c]
      } else {
        const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        const b = new Uint8Array(m * 4)
        gl.readPixels(x0, y0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, b)
        for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) out[c] += s2l(b[i * 4 + c] / 255)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      return out.map((v2) => v2 / m)
    },

    // full-resolution render → 16-bit RGB (row 0 = image top) for a 16-bit
    // TIFF: half-float targets, read back in strips
    async renderToPixels16(img, params, w, h, lut, aux, fin, masks, brush, heal) {
      const mk = () => {
        const t = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        const fb = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
        return { t, fb }
      }
      const target = mk()
      let mid = null
      if (fin) {
        mid = mk()
        draw(img, params, w, h, lut, aux, masks, brush, heal)
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb)
        finish(mid.t, w, h, fin, brush)
      } else {
        draw(img, params, w, h, lut, aux, masks, brush, heal)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb)
      const out = new Uint16Array(w * h * 3)
      const rows = Math.max(1, Math.floor((64 << 20) / (w * 16)))
      const strip = new Float32Array(w * Math.min(rows, h) * 4)
      for (let y0 = 0; y0 < h; y0 += rows) {
        const n = Math.min(rows, h - y0)
        gl.readPixels(0, y0, w, n, gl.RGBA, gl.FLOAT, strip, 0)
        // readPixels rows are bottom-up
        for (let y = 0; y < n; y++) {
          let o = (h - 1 - (y0 + y)) * w * 3
          const src = y * w * 4
          for (let x = 0; x < w; x++) {
            const i = src + x * 4
            out[o++] = Math.round(Math.min(1, Math.max(0, strip[i])) * 65535)
            out[o++] = Math.round(Math.min(1, Math.max(0, strip[i + 1])) * 65535)
            out[o++] = Math.round(Math.min(1, Math.max(0, strip[i + 2])) * 65535)
          }
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      for (const x of [target, mid]) if (x) { gl.deleteFramebuffer(x.fb); gl.deleteTexture(x.t) }
      return out
    },

    async renderToBlob(img, params, w, h, opts, lut, aux, fin, masks, brush, heal) {
      const pixels = await this.renderToPixels(img, params, w, h, lut, aux, fin, masks, brush, heal)
      const canvas2 = new OffscreenCanvas(w, h)
      canvas2.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0)
      return canvas2.convertToBlob(opts)
    },

    async renderToPixels(img, params, w, h, lut, aux, fin, masks, brush, heal) {
      const target = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, target)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      if (fin) {
        const t = finTarget(w, h)
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
        draw(img, params, w, h, lut, aux, masks, brush, heal)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        finish(t.tex, w, h, fin, brush)
      } else {
        draw(img, params, w, h, lut, aux, masks, brush, heal)
      }

      const flipped = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(target)

      // readPixels rows are bottom-up; flip to row 0 = image top
      const out = new Uint8ClampedArray(w * h * 4)
      const row = w * 4
      for (let y = 0; y < h; y++) out.set(flipped.subarray(y * row, y * row + row), (h - 1 - y) * row)
      return out
    },

    destroyImage(img) { gl.deleteTexture(img.texture) },
    // atlas: { width, height, data: Uint8Array RGBA } | null (none) |
    // undefined (keep the current one); rects: Float32Array(192) patchU
    setPatches(atlas, rects) {
      patchRects = rects ?? new Float32Array(192)
      if (atlas === undefined) return
      if (patchTexture) gl.deleteTexture(patchTexture)
      patchTexture = null
      if (!atlas) return
      patchTexture = gl.createTexture()
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, patchTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas.data)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.activeTexture(gl.TEXTURE0)
    },
    // DCP profile tables (see the WebGPU twin)
    setProfile(hsv, tone) {
      if (hsvTexture) gl.deleteTexture(hsvTexture)
      if (toneTexture) gl.deleteTexture(toneTexture)
      hsvTexture = null
      toneTexture = null
      if (hsv) {
        const [hd, sd, vd] = hsv.dims
        hsvTexture = gl.createTexture()
        gl.activeTexture(gl.TEXTURE7)
        gl.bindTexture(gl.TEXTURE_3D, hsvTexture)
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, sd, hd, vd, 0, gl.RGBA, gl.FLOAT, hsv.lut)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      }
      if (tone) {
        toneTexture = gl.createTexture()
        gl.activeTexture(gl.TEXTURE8)
        gl.bindTexture(gl.TEXTURE_2D, toneTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1024, 1, 0, gl.RED, gl.FLOAT, tone)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      }
      gl.activeTexture(gl.TEXTURE0)
    },
    // AI denoise: an empty denoised image for the open photo (null frees it)
    setDenoised(img) {
      if (dnTexture) gl.deleteTexture(dnTexture)
      if (dnFbo) gl.deleteFramebuffer(dnFbo)
      dnTexture = null
      dnFbo = null
      if (!img) return null
      dnTexture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, dnTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, img.width, img.height, 0, gl.RGBA, gl.HALF_FLOAT, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      dnFbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, dnFbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dnTexture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return dnTexture
    },
    // one model tile ({ x, y, w, h, data: Float32Array RGBA camera RGB, rows
    // top first }) into the denoised image; base: the regular demosaic
    denoiseTile(p, base, tile) {
      if (!dnTexture) return
      const k = chainFor('mosaic').progs.dnblit
      const t = gl.createTexture()
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, tile.w, tile.h, 0, gl.RGBA, gl.FLOAT, tile.data)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, base.texture)
      gl.useProgram(k.prog)
      const u = k.u
      gl.uniform3fv(u('camMul'), p.camMul)
      gl.uniformMatrix3fv(u('camToSrgb'), true, p.camToSrgb)
      gl.uniform2f(u('dims'), p.width, p.height)
      gl.uniform2f(u('org'), tile.x, tile.y)
      gl.bindFramebuffer(gl.FRAMEBUFFER, dnFbo)
      // rows flip into this backend's bottom-first storage
      gl.viewport(tile.x, p.height - tile.y - tile.h, tile.w, tile.h)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.activeTexture(gl.TEXTURE0)
      gl.deleteTexture(t)
      gl.useProgram(prog)
    },
    // a 1-pixel readback blocks until the GPU has drained (benchmarks)
    sync() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    },
    destroy() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
  }
}
