import { createWebGpu } from './webgpu.js'
import { createWebGl2 } from './webgl2.js'

// The abstraction boundary everything else depends on. Backend chosen once at
// startup; every capability difference is absorbed here, never upstream.
export async function createGpuDevice(canvas, backendPref = 'webgpu') {
  if (backendPref !== 'webgl2') {
    try {
      const gpu = await createWebGpu(canvas)
      if (gpu) return gpu
    } catch {
      // fall through — a broken WebGPU stack (e.g. blocklisted driver) should
      // land on WebGL2, not on a blank screen
    }
  }
  const gl = createWebGl2(canvas)
  if (gl) return gl
  throw new Error('No GPU backend available: WebGPU and WebGL2 both failed')
}
