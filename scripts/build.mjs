import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? '--all'

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
  } catch {
    return null
  }
}

function findCheckout() {
  const candidates = [
    process.env.DSH_CHECKOUT,
    resolve(root, '..', '..', 'deepseek-harness'),
    join(homedir(), 'dsh-harness'),
    join(homedir(), 'deepseek-harness'),
    join(homedir(), '.dsh', 'dsh-harness'),
  ].filter(Boolean)
  return candidates.find((candidate) => packageName(candidate) === '@deepseek-ai/dsh-root') ?? null
}

const checkout = findCheckout()
if (!checkout) {
  console.error('build: cannot locate the dsh checkout; set DSH_CHECKOUT')
  process.exit(1)
}

function linkPackage(name, targetRelative) {
  const target = resolve(checkout, targetRelative)
  const link = resolve(root, 'node_modules', ...name.split('/'))
  if (!existsSync(target)) throw new Error(`dependency target missing: ${target}`)
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function linkStandardSchema() {
  const store = join(checkout, 'node_modules', '.pnpm')
  if (!existsSync(store)) return
  const entry = readdirSync(store).find((name) => name.toLowerCase().startsWith('@standard-schema+spec@'))
  if (!entry) return
  const target = join(store, entry, 'node_modules', '@standard-schema', 'spec')
  if (existsSync(target)) linkAbsolute('@standard-schema/spec', target)
}

function linkAbsolute(name, target) {
  const link = resolve(root, 'node_modules', ...name.split('/'))
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(resolve(target), link, process.platform === 'win32' ? 'junction' : 'dir')
}

function prepareDependencies() {
  linkPackage('cordis', 'vendor/cordis')
  linkPackage('cosmokit', 'vendor/cosmokit')
  linkPackage('schemastery', 'vendor/schemastery')
  linkPackage('@deepseek-ai/dsh-tools', 'packages/core/tools')
  linkPackage('@deepseek-ai/dsh-llm', 'packages/llm/llm')
  linkPackage('@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt')
  linkPackage('@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots')
  linkPackage('@types/node', 'node_modules/@types/node')
  linkStandardSchema()
}

function runNode(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

prepareDependencies()

const tsc = join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')
const tsdown = join(checkout, 'node_modules', 'tsdown', 'dist', 'run.mjs')

if (mode === '--typecheck') {
  runNode(tsc, ['-p', 'tsconfig.json', '--noEmit'])
} else if (mode === '--client') {
  runNode(tsdown, [])
} else if (mode === '--all') {
  runNode(tsc, ['-p', 'tsconfig.json'])
  runNode(tsdown, [])
} else {
  console.error(`build: unknown mode ${mode}`)
  process.exit(2)
}
