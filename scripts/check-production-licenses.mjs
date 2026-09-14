import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const policy = JSON.parse(
  await readFile(new URL('../supply-chain/license-allowlist.json', import.meta.url), 'utf8'),
)
const report = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }),
)
const allowed = new Set(policy.allowed)
const rejected = Object.keys(report)
  .filter((license) => !allowed.has(license))
  .sort()
if (rejected.length) {
  throw new Error(`Production dependency license is not allowlisted: ${rejected.join(', ')}`)
}
process.stdout.write(`${Object.keys(report).length} production license family is allowlisted\n`)
