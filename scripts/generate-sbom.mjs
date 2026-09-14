import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const filterIndex = process.argv.indexOf('--filter')
const outputIndex = process.argv.indexOf('--output')
const filter = filterIndex >= 0 ? process.argv[filterIndex + 1] : undefined
const output = resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1] : '.artifacts/sbom.cdx.json',
)
if (filterIndex >= 0 && !filter) throw new Error('--filter requires a workspace selector')

const arguments_ = ['list', '--recursive', '--prod', '--depth', 'Infinity', '--json']
if (filter) arguments_.splice(1, 0, '--filter', filter)
const roots = JSON.parse(
  execFileSync('pnpm', arguments_, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }),
)
const components = new Map()
for (const root of roots) collectDependencies(root.dependencies ?? {}, components)

const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'linguaflow-sbom-generator' }] },
  },
  components: [...components.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  ),
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`)
process.stdout.write(`${output}: ${document.components.length} component\n`)

function collectDependencies(dependencies, destination) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    const version = normalizedVersion(dependency.version)
    const reference = `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
    destination.set(reference, {
      type: 'library',
      name,
      version,
      'bom-ref': reference,
      purl: reference,
      ...(dependency.resolved
        ? { externalReferences: [{ type: 'distribution', url: dependency.resolved }] }
        : {}),
    })
    collectDependencies(dependency.dependencies ?? {}, destination)
  }
}

function normalizedVersion(version) {
  if (typeof version !== 'string' || !version) return 'unknown'
  return version.startsWith('link:') ? 'workspace' : version
}
