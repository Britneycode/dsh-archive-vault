/**
 * 浏览器半边的验收测试。
 *
 * 覆盖四件会真正坏掉的事：
 *  1. bundle 的注册 id / dsh.client 元数据与包名不一致（宿主按包名认模块）；
 *  2. bundle 的 require 目标不在桌面端 shell 的基线模块表（PLATFORM_MODULES）里
 *     —— 表从**运行中的桌面端安装目录**里读，宿主升级改表就会在这里红；
 *  3. 面板没有真的走宿主桌面端控件（Button / RiskConfirmation），或样式里写死了
 *     颜色、不再跟随桌面端主题；
 *  4. 二次确认之后没有真的调 /cleanup、没有刷新会话列表。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const HOST_MODULES = {
  react: 'react',
  'react/jsx-runtime': 'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives': '@deepseek-ai/dsh-client-ui-primitives',
}

/** 宿主桌面端控件替身：保留「面板确实经过宿主组件」这一可观测事实与关键入参。 */
function hostPrimitivesStub() {
  const seen = { riskConfirmation: [], toasts: [] }
  const Button = (props) => createElement('button', {
    'data-host-primitive': 'Button',
    'data-variant': props.variant ?? 'ghost',
    disabled: props.disabled === true,
    onClick: props.onClick,
  }, props.children)
  const RiskConfirmation = (props) => {
    seen.riskConfirmation.push(props)
    return createElement('div', {
      'data-host-primitive': 'RiskConfirmation',
      'data-open': String(props.open),
    }, props.open ? props.confirmLabel : null)
  }
  const Toast = (props) => {
    seen.toasts.push(props)
    return createElement('div', { 'data-host-primitive': 'Toast' }, props.text)
  }
  const Icon = () => null
  return {
    seen,
    module: {
      Button,
      RiskConfirmation,
      Toast,
      IconRefreshOutlineRegular: Icon,
      IconTrashOutlineRegular: Icon,
    },
  }
}

/** 插件注册进 slot 表这一可观测事实。 */
function slotsStub() {
  const entries = []
  return {
    entries,
    slots: {
      inject(slot, callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(options, component) {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
}

/** 执行 bundle：捕获 __ModuleLoader__.load 的注册体并实例化工厂。 */
async function loadBundle(moduleStubs) {
  const registrations = []
  const fakeWindow = { __ModuleLoader__: { load(registration) { registrations.push(registration) } } }
  new Function('window', source)(fakeWindow)
  assert.equal(registrations.length, 1, 'bundle 必须恰好向 __ModuleLoader__ 注册一次')
  const hosts = {
    react: await import('react'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    ...moduleStubs,
  }
  const requireStub = (specifier) => {
    assert.ok(specifier in HOST_MODULES, `bundle require 了基线模块表之外的名字：${specifier}`)
    assert.ok(specifier in hosts, `测试没有为 ${specifier} 准备替身`)
    return hosts[specifier]
  }
  const exports = registrations[0].factory(requireStub)
  assert.ok(typeof exports?.apply === 'function', 'bundle 必须导出 apply()')
  return exports
}

/** 找桌面端安装目录里的 app.asar；找不到就返回 null（本包不与安装目录同住，用 DSH_DESKTOP_ROOT 指路）。 */
function findDesktopAsar() {
  if (process.env.DSH_DESKTOP_ROOT === undefined) return null
  const candidate = join(process.env.DSH_DESKTOP_ROOT, 'resources', 'app.asar')
  return existsSync(candidate) ? candidate : null
}

/** 从 shell 前端 bundle 里抠出 PLATFORM_MODULES 的键集合。 */
function platformModuleKeys(asarPath) {
  const buf = readFileSync(asarPath)
  const start = buf.indexOf(Buffer.from('{"files":'))
  assert.ok(start >= 0, 'app.asar 头部解析失败')
  let depth = 0, inStr = false, esc = false, end = -1
  for (let i = start; i < buf.length; i++) {
    const c = buf[i]
    if (inStr) { if (esc) { esc = false; continue } if (c === 0x5c) { esc = true; continue } if (c === 0x22) inStr = false; continue }
    if (c === 0x22) { inStr = true; continue }
    if (c === 0x7b) depth++
    else if (c === 0x7d) { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const header = JSON.parse(buf.slice(start, end).toString('utf8'))
  const base = 16 + Math.ceil((end - start) / 8) * 8
  const files = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, p)
      else files.push({ path: p, size: entry.size, offset: Number(entry.offset) })
    }
  }
  walk(header, '')
  const shellEntry = files.find(f => /dsh-web-frontend\/dist\/assets\/index-[\w-]+\.js$/.test(f.path))
  assert.ok(shellEntry !== undefined, '桌面端 app.asar 里找不到 web 前端 bundle')
  const shell = buf.slice(base + shellEntry.offset, base + shellEntry.offset + shellEntry.size).toString('utf8')
  const table = shell.match(/function\s+[A-Za-z_$][\w$]*\(\)\s*\{\s*return\s*\{react:[\s\S]*?\}\s*\}/)
  assert.ok(table !== null, 'shell 前端 bundle 里找不到 PLATFORM_MODULES 静态表')
  const keys = new Set(['react'])
  for (const m of table[0].matchAll(/"([^"]+)"\s*:/g)) keys.add(m[1])
  for (const m of table[0].matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.add(m[1])
  return keys
}

test('bundle 以包名注册，且 dsh.client 声明与宿主约定一致', async () => {
  const registrations = []
  const fakeWindow = { __ModuleLoader__: { load(registration) { registrations.push(registration) } } }
  new Function('window', source)(fakeWindow)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, pkg.name, 'bundle 注册 id 必须等于包名（宿主按包名认模块）')

  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh?.client?.platform, 'web', '桌面端跑的是 web 前端，platform 必须是 web')
  assert.ok(pkg.exports?.['./client'], 'dsh.client 要求包导出 ./client bundle')
  assert.ok(
    (pkg.dsh?.client?.external ?? []).includes('@deepseek-ai/dsh-client-ui-primitives'),
    '面板控件来自宿主基线模块，必须声明为 external 而不是打包进 bundle',
  )
  assert.ok(existsSync(bundlePath))
})

test('bundle 的每个 require 目标都在桌面端 shell 的基线模块表里', () => {
  const asar = findDesktopAsar()
  if (asar === null) {
    console.error('# skip: 找不到桌面端 app.asar；设置 DSH_DESKTOP_ROOT 后重跑')
    return
  }
  const keys = platformModuleKeys(asar)
  const targets = [...new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]))]
  assert.ok(targets.length > 0, 'bundle 里没有发现任何宿主模块 require')
  const strangers = targets.filter(target => !keys.has(target))
  assert.deepEqual(strangers, [], `这些 require 目标不在 shell 的 PLATFORM_MODULES 里：${strangers.join(', ')}`)
})

test('apply() 把面板注册到设置页的 archived-sessions 导航项，并渲染桌面端控件', async () => {
  const primitives = hostPrimitivesStub()
  const slots = slotsStub()
  const sessions = { refresh: async () => {} }
  const effects = []
  const exports = await loadBundle({
    '@deepseek-ai/dsh-client-ui-primitives': primitives.module,
  })
  exports.apply({
    effect: (callback, label) => { effects.push({ callback, label }); callback() },
    slots: slots.slots,
    sessions,
  })
  assert.equal(slots.entries.length, 1, '面板必须恰好注册一个 slot 条目')
  const { options, component } = slots.entries[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'archived-sessions', '借用宿主 navIcon 认识的归档图标 id')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function')

  let renderer
  await act(async () => {
    renderer = createRenderer(createElement(component))
  })
  const markup = JSON.stringify(renderer.toJSON())
  assert.ok(markup.includes('"data-host-primitive":"Button"'), '行内按钮必须经过宿主 Button')
  assert.ok(markup.includes('归档清理'), '面板标题缺失')
  await act(async () => { renderer.unmount() })
})

test('面板样式只用 --dsw-* 语义令牌，不写死颜色', () => {
  const css = source.match(/const css = `([\s\S]*?)`/)
  assert.ok(css !== null, 'bundle 里找不到面板样式串')
  const sheet = css[1]
  assert.ok(sheet.includes('--dsw-alias-'), '样式必须引用 --dsw-* 语义令牌')
  const hardcoded = sheet.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  assert.equal(hardcoded, null, `样式里出现了写死的颜色：${hardcoded?.[0]}`)
})

test('二次确认后 POST /cleanup 并刷新会话列表与摘要', async () => {
  const primitives = hostPrimitivesStub()
  const slots = slotsStub()
  let sessionRefreshes = 0
  const sessions = { refresh: async () => { sessionRefreshes++ } }
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path).endsWith('/summary')) {
      return {
        ok: true,
        json: async () => ({ ok: true, count: 3, cleanup: { trackedCount: 2, unknownCount: 1, eligible7Days: 2, eligible30Days: 2 } }),
      }
    }
    if (String(path).endsWith('/cleanup')) {
      return {
        ok: true,
        json: async () => ({ ok: true, deletedCount: 2, failures: [] }),
      }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }
  }
  try {
    const exports = await loadBundle({
      '@deepseek-ai/dsh-client-ui-primitives': primitives.module,
    })
    exports.apply({ effect: cb => cb(), slots: slots.slots, sessions })
    const { component } = slots.entries[0]
    let renderer
    await act(async () => { renderer = createRenderer(createElement(component)) })
    assert.equal(sessionRefreshes, 0)

    const buttonProps = (node, acc = []) => {
      if (node === null) return acc
      if (node.props?.['data-host-primitive'] === 'Button') acc.push(node)
      for (const child of node.children ?? []) {
        if (typeof child === 'object') buttonProps(child, acc)
      }
      return acc
    }
    const json = renderer.toJSON()
    const summaryText = JSON.stringify(json)
    assert.ok(summaryText.includes('删除 2 个'), '7 天候选数没有出现在按钮上')

    const buttons = buttonProps(json)
    const deleteButton = buttons.find(node => JSON.stringify(node).includes('删除 2 个'))
    assert.ok(deleteButton !== undefined, '找不到 7 天清理的删除按钮')
    await act(async () => { deleteButton.props.onClick() })
    const confirmation = primitives.seen.riskConfirmation.at(-1)
    assert.ok(confirmation?.open === true, '删除按钮必须先打开 RiskConfirmation')
    const postsBefore = calls.filter(c => c.init?.method === 'POST').length
    assert.equal(postsBefore, 0, '确认前不得发起删除请求')

    await act(async () => {
      confirmation.onAcknowledgedChange(true)
    })
    await act(async () => {
      confirmation.onConfirm()
    })
    for (let i = 0; i < 6; i++) {
      await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    }
    const post = calls.find(c => c.init?.method === 'POST')
    assert.ok(post !== undefined, '确认后没有 POST /cleanup')
    assert.equal(post.path, '/archive-vault/api/cleanup')
    assert.deepEqual(JSON.parse(post.init.body), { days: 7 })
    assert.equal(sessionRefreshes, 1, '清理后必须刷新会话列表')
    assert.ok(calls.filter(c => c.path.endsWith('/summary')).length >= 2, '清理后必须重读摘要')
    assert.ok(primitives.seen.toasts.length > 0, '清理后必须有结果提示')
    await act(async () => { renderer.unmount() })
  } finally {
    globalThis.fetch = originalFetch
  }
})
