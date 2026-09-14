import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2]
if (!tag) fail('Release etiketi verilmedi.')

const version = await packageVersion()
const expectedTag = `v${version}`
if (tag !== expectedTag) {
  fail(`Paket sürümü ${version}; beklenen etiket ${expectedTag}, gelen ${tag}.`)
}

const changelog = await read('CHANGELOG.md')
if (!new RegExp(`^## ${escapeRegExp(version)}(?:\\s|$)`, 'm').test(changelog)) {
  fail(`CHANGELOG.md içinde ${version} başlığı yok.`)
}

await verifyPackageSpecificVersion(version)
process.stdout.write(`${expectedTag} release doğrulaması başarılı.\n`)

async function packageVersion() {
  if (await exists('package.json')) {
    const manifest = JSON.parse(await read('package.json'))
    if (typeof manifest.version !== 'string' || !manifest.version) {
      fail('package.json içinde geçerli version yok.')
    }
    return manifest.version
  }
  if (await exists('pubspec.yaml')) {
    return match(await read('pubspec.yaml'), /^version:\s*([^\s+]+)/m, 'pubspec.yaml')
  }
  if (await exists('linguaflow/build.gradle.kts')) {
    return match(
      await read('linguaflow/build.gradle.kts'),
      /^version\s*=\s*"([^"]+)"/m,
      'linguaflow/build.gradle.kts',
    )
  }
  if (await exists('VERSION')) return (await read('VERSION')).trim()
  fail('Desteklenen bir paket sürüm kaynağı bulunamadı.')
}

async function verifyPackageSpecificVersion(version) {
  if (await exists('src/version.ts')) {
    const source = await read('src/version.ts')
    if (!source.includes(`cliVersion = '${version}'`)) {
      fail('CLI kaynak sürümü package.json ile aynı değil.')
    }
  }
  if (await exists('ios/linguaflow.podspec')) {
    const podspec = await read('ios/linguaflow.podspec')
    if (!podspec.includes(`spec.version          = '${version}'`)) {
      fail('Flutter podspec sürümü pubspec ile aynı değil.')
    }
  }
}

async function exists(file) {
  try {
    await readFile(resolve(root, file))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function read(file) {
  return readFile(resolve(root, file), 'utf8')
}

function match(value, expression, file) {
  const result = value.match(expression)
  if (!result) fail(`${file} içinde sürüm bulunamadı.`)
  return result[1]
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
