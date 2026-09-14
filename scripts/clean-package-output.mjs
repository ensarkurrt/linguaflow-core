import { readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workingDirectory = await realpath(process.cwd())
if (workingDirectory !== (await realpath(repositoryRoot))) {
  throw new Error('Public package output can only be cleaned from its repository root')
}
const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@linguaflow/')) {
  throw new Error('Refusing to clean an unknown public package')
}
await rm(join(repositoryRoot, 'dist'), { recursive: true, force: true })
