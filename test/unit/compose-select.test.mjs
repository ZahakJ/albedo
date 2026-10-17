import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marchingSquares } from '../../src/compose/outline.js'

test('marching squares traces a filled square as one closed ring', () => {
  const w = 10, h = 10
  const v = new Float32Array(w * h)
  for (let y = 2; y < 7; y++) for (let x = 3; x < 8; x++) v[y * w + x] = 1
  const { path, bounds } = marchingSquares(v, w, h, 0.5, 1, 1)
  assert.equal((path.match(/M/g) ?? []).length, 1)
  assert.ok(Math.abs(bounds[0] - 3) < 0.6 && Math.abs(bounds[2] - 5) < 1.1, `bounds ${bounds}`)
})

test('two islands give two rings', () => {
  const w = 12, h = 6
  const v = new Float32Array(w * h)
  v[2 * w + 2] = 1; v[2 * w + 8] = 1
  const { path } = marchingSquares(v, w, h, 0.5, 2, 2)
  assert.equal((path.match(/M/g) ?? []).length, 2)
})
