// 只构建浏览器半边（lib/client.js）。宿主半边直接沿用上游 dsh-archive-vault
// v0.3.0 的构建产物 lib/index.js，因此这里不需要 DSH 源码 checkout。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const tsdownDir = dirname(require.resolve('tsdown/package.json'))
const bin = JSON.parse(readFileSync(join(tsdownDir, 'package.json'), 'utf8')).bin
const entry = join(tsdownDir, typeof bin === 'string' ? bin : bin.tsdown)

const result = spawnSync(process.execPath, [entry], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
