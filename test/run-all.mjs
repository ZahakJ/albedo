// Runs the unit tests, then every e2e suite in sequence. Suites self-start their vite servers or
// reuse a listener already on their port (table in README).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const suites = readdirSync('test').filter((f) => f.endsWith('.e2e.mjs')).sort()
let failed = 0
// pure unit tests first (node:test, no browser)
{
  const r = spawnSync('node', ['--test', 'test/unit/**/*.test.mjs'], { stdio: 'inherit' })
  console.log(`── unit: ${r.status === 0 ? 'PASS' : 'FAIL'}`)
  if (r.status !== 0) failed++
}
for (const s of suites) {
  const r = spawnSync('node', [`test/${s}`], { stdio: 'inherit' })
  console.log(`── ${s}: ${r.status === 0 ? 'PASS' : 'FAIL'}`)
  if (r.status !== 0) failed++
}
process.exit(failed ? 1 : 0)
