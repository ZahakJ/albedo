import developWgsl from './shaders/wgsl/develop.wgsl?raw'
import demosaicWgsl from './shaders/wgsl/demosaic.wgsl?raw'
import rcdWgsl from './shaders/wgsl/rcd.wgsl?raw'
import xtransWgsl from './shaders/wgsl/xtrans.wgsl?raw'
import blurWgsl from './shaders/wgsl/blur.wgsl?raw'
import nrWgsl from './shaders/wgsl/nr.wgsl?raw'
import { hlChroma } from '../hlchroma.js'
import { tilesFor, tileExtent } from './tiles.js'
import finishWgsl from './shaders/wgsl/finish.wgsl?raw'
import stampWgsl from './shaders/wgsl/stamp.wgsl?raw'

// WebGPU backend. Owns the canvas context; renders the develop pass to the
// canvas or to a readback texture for export.
export async function createWebGpu(canvas) {
  if (!navigator.gpu) return null
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) return null
  // default limits cap textures at 8192 px; 45–100 MP sensors are wider
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  })
  // validation errors are otherwise silent: a broken pipeline just draws black
  device.addEventListener('uncapturederror', (e) => console.error('[webgpu]', e.error?.message ?? e))
  const format = navigator.gpu.getPreferredCanvasFormat()

  const ctx = canvas.getContext('webgpu')
  ctx.configure({ device, format, alphaMode: 'opaque' })

  const module = device.createShaderModule({ code: developWgsl })
  const makePipeline = (targetFormat) => device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: targetFormat }] },
    primitive: { topology: 'triangle-list' },
  })
  const pipeline = makePipeline(format)
  // export renders to rgba8unorm regardless of the canvas's preferred format
  const exportPipeline = format === 'rgba8unorm' ? pipeline : makePipeline('rgba8unorm')
  let half = null // 16-bit export target, built on the first TIFF

  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  })
  // 128 floats — layout comment in develop.wgsl
  const uniforms = device.createBuffer({
    size: 512,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // masksU — 192 floats (8 masks × 24), layout comment in develop.wgsl
  const masksBuf = device.createBuffer({
    size: 768,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const ZERO_MASKS = new Float32Array(192)
  // healU — 256 floats (32 spots × 8), layout comment in develop.wgsl
  const healBuf = device.createBuffer({
    size: 1024,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const ZERO_HEAL = new Float32Array(256)

  // 1×1 stand-in bound at 4/5 whenever no blur pyramid exists — the shader
  // gates sampling on lcOn but the bindings must always be populated
  const dummyTex = device.createTexture({
    size: [1, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const dummyView = dummyTex.createView()

  // 512×1 r32float point-curve LUT; textureLoad only, so the auto layout
  // infers unfilterable-float and r32float binds without float-filtering
  const curveTex = device.createTexture({
    size: [512, 1],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const identity = new Float32Array(512)
  for (let i = 0; i < 512; i++) identity[i] = i / 511
  device.queue.writeTexture({ texture: curveTex }, identity, { bytesPerRow: 512 * 4 }, [512, 1])
  let lastLut = identity
  const setLut = (lut) => {
    if (!lut || lut === lastLut) return
    lastLut = lut
    device.queue.writeTexture({ texture: curveTex }, lut, { bytesPerRow: 512 * 4 }, [512, 1])
  }

  const demosaicModule = device.createShaderModule({ code: demosaicWgsl })
  const demosaicPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: demosaicModule, entryPoint: 'vs' },
    fragment: { module: demosaicModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
  })
  const demosaicUniforms = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // Raw front ends: RCD for Bayer (rcd.wgsl), the X-Trans chain
  // (xtrans.wgsl). Both share one bind-group layout — mosaic tile, four tile
  // intermediates, uniforms — and run tile by tile (engine/gpu/tiles.js).
  const F = GPUShaderStage.FRAGMENT
  let rawBgl = null
  const chains = {}
  const chainFor = (kind) => {
    if (chains[kind]) return chains[kind]
    rawBgl ??= device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'uint' } },
        ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: F, texture: { sampleType: 'unfilterable-float' } })),
        { binding: 5, visibility: F, buffer: { type: 'uniform' } },
      ],
    })
    const module = device.createShaderModule({ code: kind === 'xtrans' ? xtransWgsl : rcdWgsl })
    const layout = device.createPipelineLayout({ bindGroupLayouts: [rawBgl] })
    const pl = (entryPoint, format) => device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
    const fmt = kind === 'xtrans'
      ? { prep: 'r32float', hlr: 'r32float', green: 'r32float' }
      : { prep: 'r32float', hlr: 'r32float', vh: 'r16float', lpf: 'r32float', green: 'r32float', pq: 'r16float', rb: 'r32float' }
    const c = { fmt, pipes: { final: pl('fs_final', 'rgba16float') } }
    if (kind !== 'xtrans') c.pipes.dnblit = pl('fs_dnblit', 'rgba16float')
    for (const [name, format] of Object.entries(fmt)) c.pipes[name] = pl(`fs_${name}`, format)
    c.uniforms = device.createBuffer({ size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    chains[kind] = c
    return c
  }

  let tinyU = null
  const tinyUint = () => (tinyU ??= device.createTexture({
    size: [1, 1], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING,
  }).createView())

  // uniform block for one tile; layouts mirror RParams / XParams
  const rawUniforms = (p, t, posOff) => {
    const M = p.camToSrgb
    const head = [
      p.camMul[0], p.camMul[1], p.camMul[2], p.black,
      p.hl.clip[0], p.hl.clip[1], p.hl.clip[2], p.white,
      p.hl.chroma[0], p.hl.chroma[1], p.hl.chroma[2], 0, // flipY: WebGPU keeps v=0 = top
      M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0,
    ]
    const u = new Float32Array(68)
    if (p.kind === 'xtrans') {
      u.set([...head, p.width, p.height, t.rw, t.rh, t.rx, t.ry, posOff[0], posOff[1]])
      u.set(p.xtrans, 32)
    } else {
      u.set([...head, p.cfa[0], p.cfa[1], p.width, p.height,
        t.rx, t.ry, posOff[0], posOff[1], t.rw, t.rh, 0, 0])
    }
    return u
  }

  // mosaic payload → linear rgba16f. Per tile: upload the tile's mosaic
  // straight from the raw frame (margins skipped by offset), run the chain in
  // tile-sized intermediates, draw the core into the output. One submit per
  // tile, so the shared uniform buffer is rewritten between them in order.
  const demosaicRaw = (p, recon) => {
    const c = chainFor(p.kind)
    const { width: w, height: h } = p
    p.hl ??= hlChroma(p)
    const stride = p.rawWidth ?? w
    const left = p.left ?? 0
    const top = p.top ?? 0
    const [ew, eh] = tileExtent(w, h)
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    const tex = {}
    for (const [name, format] of Object.entries(c.fmt)) {
      tex[name] = device.createTexture({ size: [ew, eh], format, usage })
    }
    const mosaicTex = device.createTexture({
      size: [ew, eh], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const out = device.createTexture({ size: [w, h], format: 'rgba16float', usage })
    const views = Object.fromEntries(Object.entries(tex).map(([k, t]) => [k, t.createView()]))
    const mosaicView = mosaicTex.createView()
    const hlr = recon && p.hl.clipped
    const cfa = hlr ? 'hlr' : 'prep'
    const steps = p.kind === 'xtrans'
      ? [['prep', []], ...(hlr ? [['hlr', ['prep']]] : []), ['green', [cfa]]]
      : [['prep', []], ...(hlr ? [['hlr', ['prep']]] : []), ['vh', [cfa]], ['lpf', [cfa]],
        ['green', [cfa, 'lpf', null, 'vh']], ['pq', [cfa]], ['rb', [cfa, 'green', null, 'pq']]]
    const finalIns = p.kind === 'xtrans' ? [cfa, 'green'] : [cfa, 'green', 'rb', 'vh']
    // any unused slot still needs a float view that is not the pass target
    const spare = (target) => views[target === 'prep' ? 'green' : 'prep']
    const bind = (ins, target) => device.createBindGroup({
      layout: rawBgl,
      entries: [
        { binding: 0, resource: mosaicView },
        ...[0, 1, 2, 3].map((i) => ({ binding: i + 1, resource: ins[i] ? views[ins[i]] : spare(target) })),
        { binding: 5, resource: { buffer: c.uniforms } },
      ],
    })
    for (const t of tilesFor(w, h)) {
      device.queue.writeTexture({ texture: mosaicTex }, p.buffer,
        { offset: ((top + t.ry) * stride + left + t.rx) * 2, bytesPerRow: stride * 2, rowsPerImage: t.rh },
        [t.rw, t.rh])
      device.queue.writeBuffer(c.uniforms, 0, rawUniforms(p, t, [t.rx, t.ry]))
      let enc = device.createCommandEncoder()
      for (const [name, ins] of steps) {
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: views[name], loadOp: 'clear', storeOp: 'store' }],
        })
        rp.setViewport(0, 0, t.rw, t.rh, 0, 1)
        rp.setPipeline(c.pipes[name])
        rp.setBindGroup(0, bind(ins, name))
        rp.draw(3)
        rp.end()
      }
      device.queue.submit([enc.finish()])
      // the final pass draws in image coordinates: posOff 0
      device.queue.writeBuffer(c.uniforms, 0, rawUniforms(p, t, [0, 0]))
      enc = device.createCommandEncoder()
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: out.createView(), loadOp: 'load', storeOp: 'store' }],
      })
      rp.setViewport(t.x0, t.y0, t.x1 - t.x0, t.y1 - t.y0, 0, 1)
      rp.setPipeline(c.pipes.final)
      rp.setBindGroup(0, bind(finalIns, 'final'))
      rp.draw(3)
      rp.end()
      device.queue.submit([enc.finish()])
    }
    mosaicTex.destroy()
    for (const t of Object.values(tex)) t.destroy()
    return { texture: out, width: w, height: h, isLinear: 1 }
  }

  // removal patches of the open photo (patchU layout in develop.wgsl): one
  // rgba8 atlas plus 16 rects, bound by every develop draw until replaced
  const patchBuf = device.createBuffer({
    size: 768,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  let patchView = null
  let dnView = null // AI-denoised capture of the open photo (binding 11)
  // DCP camera profile of the open photo (bindings 12–14)
  const lutSampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'repeat', addressModeW: 'clamp-to-edge',
  })
  const dummy3d = device.createTexture({
    size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING,
  }).createView({ dimension: '3d' })
  const dummyTone = device.createTexture({
    size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING,
  }).createView()
  let hsvView = null
  let toneView = null

  const bindFor = (pl, texture, aux, brush) => device.createBindGroup({
    layout: pl.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: { buffer: uniforms } },
      { binding: 3, resource: curveTex.createView() },
      { binding: 4, resource: aux?.small.view ?? dummyView },
      { binding: 5, resource: aux?.large.view ?? dummyView },
      { binding: 6, resource: { buffer: masksBuf } },
      { binding: 7, resource: brush?.view ?? dummyView },
      { binding: 8, resource: { buffer: healBuf } },
      { binding: 9, resource: patchView ?? dummyView },
      { binding: 10, resource: { buffer: patchBuf } },
      { binding: 11, resource: dnView ?? dummyView },
      { binding: 12, resource: hsvView ?? dummy3d },
      { binding: 13, resource: lutSampler },
      { binding: 14, resource: toneView ?? dummyTone },
    ],
  })

  // opts (optional): { load: keep the previous contents, scissor: [x,y,w,h] }
  // — the split view's second (after-doc) draw over the before-doc base
  const draw = (pl, texture, view, params, lut, aux, masks, brush, heal, opts) => {
    setLut(lut)
    device.queue.writeBuffer(uniforms, 0, params)
    device.queue.writeBuffer(masksBuf, 0, masks ?? ZERO_MASKS)
    device.queue.writeBuffer(healBuf, 0, heal ?? ZERO_HEAL)
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: opts?.load ? 'load' : 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    })
    pass.setPipeline(pl)
    if (opts?.scissor) pass.setScissorRect(...opts.scissor)
    pass.setBindGroup(0, bindFor(pl, texture, aux, brush))
    pass.draw(3)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  // blur pipeline built lazily: only local-contrast edits ever need it.
  // Fragment-only render passes into rgba16f (render-attachable + sampleable
  // everywhere) — no storage textures, no compute, full WebGL2 parity.
  let blur = null
  const blurPipeline = () => {
    if (blur) return blur
    const m = device.createShaderModule({ code: blurWgsl })
    blur = {
      pl: device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      }),
      // one uniform buffer is safe across passes: writeBuffer and submit
      // interleave in queue order
      uniforms: device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    }
    return blur
  }

  // nr (à-trous wavelet denoise) built lazily like blur
  let nr = null
  const nrPipeline = () => {
    if (nr) return nr
    const m = device.createShaderModule({ code: nrWgsl })
    nr = {
      pl: device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      }),
      uniforms: device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    }
    return nr
  }

  // finish (output-referred unsharp) — pipelines per target format, plus the
  // develop→finish intermediate rgba8 texture cached by size (display
  // re-renders every frame; export sizes just realloc)
  let fin = null
  const finPipeline = (fmt) => {
    fin ??= {
      module: device.createShaderModule({ code: finishWgsl }),
      pls: new Map(),
      uniforms: device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      tex: null,
    }
    if (!fin.pls.has(fmt)) {
      fin.pls.set(fmt, device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: fin.module, entryPoint: 'vs' },
        fragment: { module: fin.module, entryPoint: 'fs', targets: [{ format: fmt }] },
        primitive: { topology: 'triangle-list' },
      }))
    }
    return fin.pls.get(fmt)
  }
  const finTarget = (w, h) => {
    finPipeline(format)
    if (fin.tex?.width === w && fin.tex?.height === h) return fin.tex
    fin.tex?.texture.destroy()
    const t = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    fin.tex = { texture: t, view: t.createView(), width: w, height: h }
    return fin.tex
  }
  // benchmark sink for the finish pass when not presenting
  let sink = null
  const finTarget2 = (w, h) => {
    if (sink?.width === w && sink?.height === h) return sink
    sink?.texture.destroy()
    const t = device.createTexture({
      size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    sink = { texture: t, view: t.createView(), width: w, height: h }
    return sink
  }
  // f: { amount, sigma, maskT, maskPreview, clipOverlay, wash?, grain?,
  // geom?, split? } — layout in finish.wgsl; geom = { geom: [angle,x,y,w,h,
  // fit], srcW, srcH, perspV, perspH, distortion } (filled whenever wash or
  // grain runs), wash = { rec: Float32Array(24) } paints the selected mask's
  // weight as a 40% red overlay, grain = { amount, cell (source px), rough
  // 0..1 }, split = { dir: 'h'|'v', pos 0..1 } paints the divider
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
  const finishDraw = (targetView, fmt, srcView, f, brush) => {
    const pl = finPipeline(fmt)
    device.queue.writeBuffer(fin.uniforms, 0, finUniforms(f))
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    pass.setPipeline(pl)
    pass.setBindGroup(0, device.createBindGroup({
      layout: pl.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: srcView },
        { binding: 2, resource: { buffer: fin.uniforms } },
        { binding: 3, resource: brush?.view ?? dummyView },
      ],
    }))
    pass.draw(3)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  // brush stamp pass — pipeline per (channel, erase): the color write mask
  // picks the channel, the blend picks accumulate (MAX) vs erase (dst·src)
  let stamp = null
  const stampPipeline = (channel, erase) => {
    stamp ??= {
      module: device.createShaderModule({ code: stampWgsl }),
      pls: new Map(),
      uniforms: device.createBuffer({
        size: 1056,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    }
    const key = channel * 2 + (erase ? 1 : 0)
    if (!stamp.pls.has(key)) {
      const blend = erase
        ? { operation: 'add', srcFactor: 'zero', dstFactor: 'src' }
        : { operation: 'max', srcFactor: 'one', dstFactor: 'one' }
      stamp.pls.set(key, device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: stamp.module, entryPoint: 'vs' },
        fragment: {
          module: stamp.module,
          entryPoint: 'fs',
          targets: [{
            format: 'rgba8unorm',
            writeMask: 1 << channel,
            blend: { color: blend, alpha: blend },
          }],
        },
        primitive: { topology: 'triangle-list' },
      }))
    }
    return stamp.pls.get(key)
  }

  return {
    backend: 'webgpu',
    // GC'ing the adapter tears down Dawn's instance and breaks later mapAsync
    // calls ("A valid external Instance reference no longer exists") — hold it.
    _adapter: adapter,
    limits: { maxTex: device.limits.maxTextureDimension2D },
    // hardware adapters read back reliably; SwiftShader's mapAsync and
    // completion signals do not, and the worker then uses a scratch GL context
    readback: !(adapter.info?.isFallbackAdapter || adapter.info?.architecture === 'swiftshader'),

    uploadImage(bitmap) {
      const { width: w, height: h } = bitmap
      const texture = device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      try {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [w, h])
      } catch {
        // SwiftShader: copyExternalImageToTexture starts failing once a
        // WebGL2 context coexists in this worker (the scratch scopes/export
        // context) — raster on a 2d canvas and upload the bytes instead
        const c2 = new OffscreenCanvas(w, h).getContext('2d')
        c2.drawImage(bitmap, 0, 0)
        device.queue.writeTexture(
          { texture }, c2.getImageData(0, 0, w, h).data, { bytesPerRow: w * 4 }, [w, h])
      }
      return { texture, width: w, height: h }
    },

    // decoded RAW payload → linear rgba16f via the demosaic/camera-color pass,
    // run once here: it is edit-independent EXCEPT recon (highlight
    // reconstruction) — the worker re-runs this when modules.recon toggles.
    uploadDecoded(p, recon = 1) {
      const mosaic = p.kind === 'mosaic'
      if (mosaic || p.kind === 'xtrans') return demosaicRaw(p, recon)
      const format = mosaic ? 'r16uint' : p.bitDepth === 16 ? 'rgba16uint' : 'rgba8uint'
      const bytesPerPixel = mosaic ? 2 : p.bitDepth === 16 ? 8 : 4
      const src = device.createTexture({
        size: [p.width, p.height],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture(
        { texture: src }, p.buffer, { bytesPerRow: p.width * bytesPerPixel }, [p.width, p.height])

      const M = p.camToSrgb
      // layout mirrors DParams in demosaic.wgsl (vec3 + scalar per 16B row)
      device.queue.writeBuffer(demosaicUniforms, 0, Float32Array.of(
        M[0], M[1], M[2], mosaic ? 0 : 1,
        M[3], M[4], M[5], p.black,
        M[6], M[7], M[8], p.white,
        p.camMul[0], p.camMul[1], p.camMul[2], 0, // flipY: WebGPU keeps v=0 = top
        p.cfa[0], p.cfa[1], p.width, p.height,
        p.linear ? 0 : 1, recon ? 1 : 0, 0, 0,
      ))
      const target = device.createTexture({
        size: [p.width, p.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
      })
      pass.setPipeline(demosaicPipeline)
      pass.setBindGroup(0, device.createBindGroup({
        layout: demosaicPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: { buffer: demosaicUniforms } },
        ],
      }))
      pass.draw(3)
      pass.end()
      device.queue.submit([enc.finish()])
      src.destroy()
      // the pass decodes any source curve, so the intermediate is always linear
      return { texture: target, width: p.width, height: p.height, isLinear: 1 }
    },

    // Blur pyramid for the local-contrast family: blurSmall = σ 3px·scale at
    // source res (texture), blurLarge = σ 40px·scale, computed at QUARTER res
    // (σ 10px there) — cost stays sane and the combine samples it bilinearly.
    // Both scene-linear rgba16f; edit-independent, so callers cache per photo.
    // scale = renderW/fullW keeps preview and export blurs image-relative.
    computeAux(img, scale = 1) {
      const { pl, uniforms: bu } = blurPipeline()
      const { width: w, height: h } = img
      const linz = img.isLinear ? 0 : 1
      const target = (tw, th) => device.createTexture({
        size: [tw, th],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      // one submit per pass: the shared uniform buffer's writeBuffer lands
      // between submits in queue order, so each pass sees its own params.
      // First tap of a chain linearizes sRGB sources; later passes read
      // already-linear intermediates.
      const pass = (src, dst, dx, dy, sigma, radius, first) => {
        device.queue.writeBuffer(bu, 0,
          Float32Array.of(dx, dy, sigma, radius, first ? linz : 0, 0, 0, 0))
        const enc = device.createCommandEncoder()
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: dst.createView(), loadOp: 'clear', storeOp: 'store' }],
        })
        rp.setPipeline(pl)
        rp.setBindGroup(0, device.createBindGroup({
          layout: pl.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: src.createView() },
            { binding: 2, resource: { buffer: bu } },
          ],
        }))
        rp.draw(3)
        rp.end()
        device.queue.submit([enc.finish()])
      }
      const sS = 3 * scale
      const rS = Math.min(64, Math.max(1, Math.ceil(2.5 * sS)))
      const tmp = target(w, h)
      const small = target(w, h)
      pass(img.texture, tmp, 1 / w, 0, sS, rS, true)
      pass(tmp, small, 0, 1 / h, sS, rS, false)
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
      pass(img.texture, half, 0, 0, 1, 0, true)
      pass(half, q1, 0, 0, 1, 0, false)
      pass(q1, q2, 1 / qw, 0, sL, rL, false)
      pass(q2, q1, 0, 1 / qh, sL, rL, false) // q1 becomes blurLarge
      tmp.destroy()
      half.destroy()
      q2.destroy()
      return {
        small: { texture: small, view: small.createView(), width: w, height: h },
        large: { texture: q1, view: q1.createView(), width: qw, height: qh },
        destroy() { small.destroy(); q1.destroy() },
      }
    },

    // À-trous wavelet denoise: 3 levels, 5-tap B3 kernel at holes 1/2/4, run
    // separably (H, then V fused with the per-level soft-threshold
    // reconstruct — see nr.wgsl). Seeded by a radius-0 blur pass so the chain
    // is scene-linear. Output replaces the develop input texture. 7 full-res
    // passes; callers cache per (photoId, lumaNR, chromaNR).
    computeNR(img, lumaNR, chromaNR) {
      const { pl, uniforms: nu } = nrPipeline()
      const { pl: bpl, uniforms: bu } = blurPipeline()
      const { width: w, height: h } = img
      const mk = () => device.createTexture({
        size: [w, h],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const run = (pipe, dst, entries) => {
        const enc = device.createCommandEncoder()
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: dst.createView(), loadOp: 'clear', storeOp: 'store' }],
        })
        rp.setPipeline(pipe)
        rp.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }))
        rp.draw(3)
        rp.end()
        device.queue.submit([enc.finish()])
      }
      let a = mk()
      let out = mk()
      const tmp = mk()
      // seed: radius-0 blur = linearize-only copy (parity with computeAux)
      device.queue.writeBuffer(bu, 0, Float32Array.of(0, 0, 1, 0, img.isLinear ? 0 : 1, 0, 0, 0))
      run(bpl, a, [
        { binding: 0, resource: sampler },
        { binding: 1, resource: img.texture.createView() },
        { binding: 2, resource: { buffer: bu } },
      ])
      const kL = (lumaNR / 100) ** 2
      const kC = (chromaNR / 100) ** 2
      const TL = [0.02, 0.012, 0.008]
      const TC = [0.05, 0.03, 0.02]
      for (let i = 0; i < 3; i++) {
        const hole = 1 << i
        const nrPass = (src, dst, dx, dy, comb, tl, tc) => {
          device.queue.writeBuffer(nu, 0, Float32Array.of(dx, dy, tl, tc, comb, 0, 0, 0))
          run(pl, dst, [
            { binding: 0, resource: sampler },
            { binding: 1, resource: src.createView() },
            { binding: 2, resource: a.createView() }, // orig = level a (unused for H)
            { binding: 3, resource: { buffer: nu } },
          ])
        }
        nrPass(a, tmp, hole / w, 0, 0, 0, 0)
        nrPass(tmp, out, 0, hole / h, 1, kL * TL[i], kC * TC[i])
        ;[a, out] = [out, a]
      }
      tmp.destroy()
      out.destroy()
      const tex = a
      return {
        img: { texture: tex, width: w, height: h, isLinear: 1 },
        destroy() { tex.destroy() },
      }
    },

    resize(w, h) {
      canvas.width = w
      canvas.height = h
    },

    // ── brush mask texture: quarter-res rgba8, one channel per brush mask ──
    createBrushTex(w, h) {
      const texture = device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        // COPY_DST: uploadBrushRGBA writes the AI-mask base image
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST,
      })
      const t = { texture, view: texture.createView(), width: w, height: h, destroy() { texture.destroy() } }
      this.clearBrush(t)
      return t
    },

    clearBrush(t) {
      const enc = device.createCommandEncoder()
      enc.beginRenderPass({
        colorAttachments: [{ view: t.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      }).end()
      device.queue.submit([enc.finish()])
    },

    // full-RGBA base upload (AI-mask channels); row 0 = image top, matching
    // the stamp pass convention. Stamps land after this via per-channel blend.
    uploadBrushRGBA(t, data) {
      device.queue.writeTexture({ texture: t.texture }, data,
        { bytesPerRow: t.width * 4 }, [t.width, t.height])
    },

    // pts: [[x, y, pressure], ..] in y-down source-normalized (pre-mirror)
    // coords; size = diameter as a source-WIDTH fraction; batches of 64
    stampBrush(t, channel, pts, size, flow, erase, srcW, srcH) {
      const pl = stampPipeline(channel, erase)
      for (let i = 0; i < pts.length; i += 64) {
        const batch = pts.slice(i, i + 64)
        const u = new Float32Array(264)
        u.set([batch.length, size, flow, erase ? 1 : 0, srcW, srcH])
        batch.forEach((p, j) => u.set([p[0], p[1], p[2] ?? 1], 8 + j * 4))
        device.queue.writeBuffer(stamp.uniforms, 0, u)
        const enc = device.createCommandEncoder()
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: t.view, loadOp: 'load', storeOp: 'store' }],
        })
        pass.setPipeline(pl)
        pass.setBindGroup(0, device.createBindGroup({
          layout: pl.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: stamp.uniforms } }],
        }))
        pass.draw(3)
        pass.end()
        device.queue.submit([enc.finish()])
      }
    },

    // fin (optional): finish-pass descriptor — develop renders to an
    // intermediate rgba8 and finish (unsharp + clip + wash) hits the target.
    // masks: Float32Array(192) masksU | null; brush: createBrushTex handle |
    // null; heal: Float32Array(256) healU | null. split (optional, display
    // only): { params2, lut2, dir 'h'|'v', pos } — the BEFORE doc draws
    // full-frame first, the current doc scissors over its half (WebGPU's
    // origin is top-left, so the 'v' after-region is the HIGH y band), and
    // the finish pass (forced non-null by the worker) paints the divider.
    // offscreen: draw into the finish intermediate instead of presenting, so
    // a benchmark times GPU work, not the compositor's frame pacing
    render(img, params, lut, aux, fin_, masks, brush, heal, split, offscreen) {
      if (!fin_) {
        const view = offscreen ? finTarget(canvas.width, canvas.height).view : ctx.getCurrentTexture().createView()
        draw(offscreen ? exportPipeline : pipeline, img.texture, view, params, lut, aux, masks, brush, heal)
        return
      }
      const w = canvas.width
      const h = canvas.height
      const t = finTarget(w, h)
      if (split) {
        draw(exportPipeline, img.texture, t.view, split.params2, split.lut2, aux, null, null, null)
        const px = Math.round(split.pos * w)
        const py = Math.round(split.pos * h)
        const scissor = split.dir === 'v' ? [0, py, w, h - py] : [px, 0, w - px, h]
        draw(exportPipeline, img.texture, t.view, params, lut, aux, masks, brush, heal,
          { load: true, scissor })
      } else {
        draw(exportPipeline, img.texture, t.view, params, lut, aux, masks, brush, heal)
      }
      if (!offscreen) finishDraw(ctx.getCurrentTexture().createView(), format, t.view, fin_, brush)
      else finishDraw(finTarget2(w, h).view, 'rgba8unorm', t.view, fin_, brush)
    },

    // full-resolution render → encoded blob. Renders into a second canvas
    // configured on the same device: no buffer readback, no mapAsync (which is
    // flaky on some stacks), and convertToBlob encodes straight from the GPU.
    async renderToBlob(img, params, w, h, opts, lut, aux, fin_, masks, brush, heal) {
      const canvas2 = new OffscreenCanvas(w, h)
      const ctx2 = canvas2.getContext('webgpu')
      ctx2.configure({ device, format, alphaMode: 'opaque' })
      if (fin_) {
        const t = finTarget(w, h)
        draw(exportPipeline, img.texture, t.view, params, lut, aux, masks, brush, heal)
        finishDraw(ctx2.getCurrentTexture().createView(), format, t.view, fin_, brush)
      } else {
        draw(pipeline, img.texture, ctx2.getCurrentTexture().createView(), params, lut, aux, masks, brush, heal)
      }
      // transferToImageBitmap synchronously snapshots the drawn frame; the
      // completion-signal routes (mapAsync / onSubmittedWorkDone / direct
      // convertToBlob) are unreliable on software WebGPU stacks
      const bitmap = canvas2.transferToImageBitmap()
      ctx2.unconfigure()
      const out = new OffscreenCanvas(w, h)
      out.getContext('2d').drawImage(bitmap, 0, 0)
      bitmap.close()
      return out.convertToBlob(opts)
    },

    // full-resolution render → 16-bit RGB (row 0 = image top) for a 16-bit
    // TIFF: develop and finish render into half-float targets, read back in
    // strips so no full-size float copy exists on the CPU
    async renderToPixels16(img, params, w, h, lut, aux, fin_, masks, brush, heal) {
      half ??= makePipeline('rgba16float')
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      const target = device.createTexture({ size: [w, h], format: 'rgba16float', usage })
      let mid = null
      if (fin_) {
        mid = device.createTexture({ size: [w, h], format: 'rgba16float', usage })
        draw(half, img.texture, mid.createView(), params, lut, aux, masks, brush, heal)
        finishDraw(target.createView(), 'rgba16float', mid.createView(), fin_, brush)
      } else {
        draw(half, img.texture, target.createView(), params, lut, aux, masks, brush, heal)
      }
      const out = new Uint16Array(w * h * 3)
      const bytesPerRow = Math.ceil((w * 8) / 256) * 256
      const rows = Math.max(1, Math.floor((64 << 20) / bytesPerRow))
      for (let y0 = 0; y0 < h; y0 += rows) {
        const n = Math.min(rows, h - y0)
        const buf = device.createBuffer({ size: bytesPerRow * n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer({ texture: target, origin: [0, y0] }, { buffer: buf, bytesPerRow }, [w, n])
        device.queue.submit([enc.finish()])
        await buf.mapAsync(GPUMapMode.READ)
        const f16 = new Float16Array(buf.getMappedRange())
        for (let y = 0; y < n; y++) {
          const src = (y * bytesPerRow) / 2
          let o = (y0 + y) * w * 3
          for (let x = 0; x < w; x++) {
            const i = src + x * 4
            out[o++] = Math.round(Math.min(1, Math.max(0, f16[i])) * 65535)
            out[o++] = Math.round(Math.min(1, Math.max(0, f16[i + 1])) * 65535)
            out[o++] = Math.round(Math.min(1, Math.max(0, f16[i + 2])) * 65535)
          }
        }
        buf.unmap()
        buf.destroy()
      }
      target.destroy()
      mid?.destroy()
      return out
    },

    // full-resolution render → tightly packed RGBA bytes (row 0 = image top)
    async renderToPixels(img, params, w, h, lut, aux, fin_, masks, brush, heal) {
      const target = device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
      if (fin_) {
        const t = finTarget(w, h)
        draw(exportPipeline, img.texture, t.view, params, lut, aux, masks, brush, heal)
        finishDraw(target.createView(), 'rgba8unorm', t.view, fin_, brush)
      } else {
        draw(exportPipeline, img.texture, target.createView(), params, lut, aux, masks, brush, heal)
      }

      const bytesPerRow = Math.ceil((w * 4) / 256) * 256
      const buf = device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      const enc = device.createCommandEncoder()
      enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow }, [w, h])
      device.queue.submit([enc.finish()])

      await buf.mapAsync(GPUMapMode.READ)
      const padded = new Uint8Array(buf.getMappedRange())
      const out = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4)
      buf.unmap()
      buf.destroy()
      target.destroy()
      return out
    },

    destroyImage(img) { img.texture.destroy() },
    // atlas: { width, height, data: Uint8Array RGBA } | null (none) |
    // undefined (keep the current one); rects: Float32Array(192) patchU —
    // the photo's removal patches, until the next call
    setPatches(atlas, rects) {
      device.queue.writeBuffer(patchBuf, 0, rects ?? new Float32Array(192))
      if (atlas === undefined) return
      patchView?.texture?.destroy()
      patchView = null
      if (!atlas) return
      const t = device.createTexture({
        size: [atlas.width, atlas.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture({ texture: t }, atlas.data, { bytesPerRow: atlas.width * 4 },
        [atlas.width, atlas.height])
      patchView = t.createView()
      patchView.texture = t
    },
    // DCP profile tables: hsv { dims: [hue, sat, val], lut: Float32Array RGBA
    // (hue shift, sat scale, val scale, 1) } | null, tone Float32Array(1024)
    // | null — both null clears
    setProfile(hsv, tone) {
      hsvView?.texture?.destroy()
      toneView?.texture?.destroy()
      hsvView = null
      toneView = null
      if (hsv) {
        const [hd, sd, vd] = hsv.dims
        // half floats: rgba32float would not filter without an optional feature
        const t = device.createTexture({
          size: [sd, hd, vd], dimension: '3d', format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
        device.queue.writeTexture({ texture: t }, new Float16Array(hsv.lut), { bytesPerRow: sd * 8, rowsPerImage: hd }, [sd, hd, vd])
        hsvView = t.createView({ dimension: '3d' })
        hsvView.texture = t
      }
      if (tone) {
        const t = device.createTexture({
          size: [1024, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
        device.queue.writeTexture({ texture: t }, tone, { bytesPerRow: 4096 }, [1024, 1])
        toneView = t.createView()
        toneView.texture = t
      }
    },
    // AI denoise: an empty denoised image for the open photo (null frees it)
    setDenoised(img) {
      dnView?.texture?.destroy()
      dnView = null
      if (!img) return null
      const t = device.createTexture({
        size: [img.width, img.height], format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      dnView = t.createView()
      dnView.texture = t
      return dnView
    },
    // one model tile ({ x, y, w, h, data: Float32Array RGBA camera RGB }) into
    // the denoised image, through white balance and the camera matrix; base
    // is the photo's regular demosaic, kept where the capture clipped
    denoiseTile(p, base, tile) {
      if (!dnView) return
      const c = chainFor('mosaic')
      const t = device.createTexture({
        size: [tile.w, tile.h], format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture({ texture: t }, tile.data, { bytesPerRow: tile.w * 16 }, [tile.w, tile.h])
      p.hl ??= { clip: [1, 1, 1], chroma: [0, 0, 0], clipped: false }
      device.queue.writeBuffer(c.uniforms, 0, rawUniforms(p, { rx: tile.x, ry: tile.y, rw: tile.w, rh: tile.h }, [0, 0]))
      const enc = device.createCommandEncoder()
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: dnView, loadOp: 'load', storeOp: 'store' }] })
      rp.setViewport(tile.x, tile.y, tile.w, tile.h, 0, 1)
      rp.setPipeline(c.pipes.dnblit)
      const tv = t.createView()
      rp.setBindGroup(0, device.createBindGroup({
        layout: rawBgl,
        entries: [
          { binding: 0, resource: tinyUint() },
          { binding: 1, resource: tv },
          { binding: 2, resource: base.texture.createView() },
          { binding: 3, resource: tv },
          { binding: 4, resource: tv },
          { binding: 5, resource: { buffer: c.uniforms } },
        ],
      }))
      rp.draw(3)
      rp.end()
      device.queue.submit([enc.finish()])
      t.destroy()
    },
    // resolves when the GPU has finished all submitted work (benchmarks)
    sync: () => device.queue.onSubmittedWorkDone(),
    destroy() { device.destroy() },
  }
}
