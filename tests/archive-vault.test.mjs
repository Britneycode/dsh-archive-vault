import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  textFromContent,
  extractPreview,
  buildArchiveList,
  unarchiveSession,
  deleteArchivedSession,
  apply,
} from '../lib/index.js'
import * as archiveVault from '../lib/index.js'

function userEvent(text, time = 1_000, kind = 'user') {
  return {
    type: 'user/message',
    time,
    data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] },
  }
}

/** 带记账与 detachSession 的假工作区实体（方法必须是自有属性，spread 拷贝才保得住）。 */
function workspaceEntity({ id, title, path, sessionIds }) {
  const record = { id, title, path, sessionIds: [...sessionIds] }
  return {
    id,
    title,
    path,
    get sessionIds() {
      return [...record.sessionIds]
    },
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter(candidate => candidate !== sessionId)
    },
    __record: record,
  }
}

function fakeRegistry({ archived = [], workspaces = [] } = {}) {
  const state = { archivedSessionIds: [...archived] }
  // 与真实 WorkspaceRegistry 相同的原型方法形态（enqueueOperation/setState
  // 在宿主里是 TS private 原型方法）：摘下来裸调用会因丢失 this 抛错。
  class Registry {
    constructor() {
      this.tail = Promise.resolve()
    }

    get archivedSessionIds() {
      return [...state.archivedSessionIds]
    }

    list() {
      return workspaces.map(workspace => ({ ...workspace }))
    }

    enqueueOperation(operation) {
      const result = this.tail.then(operation)
      this.tail = result.then(() => {}, () => {})
      return result
    }

    async setState(next) {
      state.archivedSessionIds = [...next.archivedSessionIds]
    }
  }
  const registry = new Registry()
  registry.__state = state
  return registry
}

function fakePersistence({ headers = [], inspections = new Map(), locateBase = 'D:/fake/sessions/--proj--' } = {}) {
  return {
    list: async () => headers.map(header => ({ ...header })),
    inspect: async id => {
      const events = inspections.get(id)
      if (events === undefined) throw new Error(`session '${id}' not found`)
      return { meta: {}, events }
    },
    locate: header => ({
      kind: 'jsonl',
      path: `${locateBase}/${header.id}/session.jsonl.zstd`,
    }),
  }
}

test('批量清理按钮文案稳定表达候选数、确认与执行状态', () => {
  assert.equal(archiveVault.cleanupButtonLabel(7, 2, 'idle'), '清理 7 天以上 (2)')
  assert.equal(archiveVault.cleanupButtonLabel(30, 1, 'armed'), '确认删除 1 个')
  assert.equal(archiveVault.cleanupButtonLabel(30, 1, 'busy'), '清理中…')
})

test('归档计时只记录监听期间新增的归档，旧归档保持未知', () => {
  const result = archiveVault.reconcileArchiveTimes({
    previousArchivedIds: ['tracked', 'legacy'],
    nextArchivedIds: ['tracked', 'legacy', 'new-session'],
    archivedAt: { tracked: 1_000 },
    now: 9_000,
  })

  assert.deepEqual(result, {
    archivedAt: { tracked: 1_000, 'new-session': 9_000 },
    changed: true,
  })
})

test('取消归档会移除计时，再次归档从新时间开始', () => {
  const removed = archiveVault.reconcileArchiveTimes({
    previousArchivedIds: ['session-a'],
    nextArchivedIds: [],
    archivedAt: { 'session-a': 1_000 },
    now: 5_000,
  })
  const rearchived = archiveVault.reconcileArchiveTimes({
    previousArchivedIds: [],
    nextArchivedIds: ['session-a'],
    archivedAt: removed.archivedAt,
    now: 8_000,
  })

  assert.deepEqual(removed, { archivedAt: {}, changed: true })
  assert.deepEqual(rearchived, { archivedAt: { 'session-a': 8_000 }, changed: true })
})

test('清理候选按归档时间筛选且排除未知时间记录', () => {
  const day = 24 * 60 * 60 * 1_000
  const now = 40 * day
  const archivedAt = {
    recent: now - 6 * day,
    seven: now - 7 * day,
    thirty: now - 30 * day,
  }

  assert.deepEqual(
    archiveVault.eligibleArchivedSessionIds(['legacy', 'recent', 'seven', 'thirty'], archivedAt, 7, now),
    ['seven', 'thirty'],
  )
  assert.deepEqual(
    archiveVault.eligibleArchivedSessionIds(['legacy', 'recent', 'seven', 'thirty'], archivedAt, 30, now),
    ['thirty'],
  )
})

test('批量清理继续处理单条失败并返回成功与失败明细', async () => {
  const attempted = []
  const result = await archiveVault.cleanupArchivedSessions(['first', 'live', 'last'], async sessionId => {
    attempted.push(sessionId)
    if (sessionId === 'live') throw new Error('正在运行')
  })

  assert.deepEqual(attempted, ['first', 'live', 'last'])
  assert.deepEqual(result, {
    deletedSessionIds: ['first', 'last'],
    failures: [{ sessionId: 'live', error: '正在运行' }],
  })
})

test('归档时间跟踪器加载已有记录且不给旧归档补猜测时间', async () => {
  const writes = []
  const tracker = new archiveVault.ArchiveTimeTracker({
    initialArchivedIds: ['tracked', 'legacy'],
    store: {
      read: async () => ({ tracked: 1_000 }),
      write: async archivedAt => { writes.push({ ...archivedAt }) },
    },
    now: () => 9_000,
  })

  assert.deepEqual(await tracker.snapshot(), { tracked: 1_000 })
  assert.deepEqual(writes, [])
})

test('归档时间跟踪器串行保存快速连续的归档变化', async () => {
  const writes = []
  const times = [1_000, 2_000]
  const tracker = new archiveVault.ArchiveTimeTracker({
    initialArchivedIds: [],
    store: {
      read: async () => ({}),
      write: async archivedAt => { writes.push({ ...archivedAt }) },
    },
    now: () => times.shift(),
  })

  const first = tracker.observe(['session-a'])
  const second = tracker.observe(['session-a', 'session-b'])
  await Promise.all([first, second])

  assert.deepEqual(await tracker.snapshot(), { 'session-a': 1_000, 'session-b': 2_000 })
  assert.deepEqual(writes, [
    { 'session-a': 1_000 },
    { 'session-a': 1_000, 'session-b': 2_000 },
  ])
})

test('归档时间文件后端持久化版本化状态并拒绝损坏内容', async () => {
  const base = mkdtempSync(join(tmpdir(), 'archive-vault-times-'))
  const statePath = join(base, 'archive-times.json')
  try {
    const store = new archiveVault.ArchiveTimeFileStore(statePath)
    assert.deepEqual(await store.read(), {})

    await store.write({ 'session-a': 1_234 })
    assert.deepEqual(await store.read(), { 'session-a': 1_234 })

    await store.write({ 'session-a': 1_234, 'session-b': 5_678 })
    assert.deepEqual(await store.read(), { 'session-a': 1_234, 'session-b': 5_678 })

    writeFileSync(statePath, '{"version":2,"archivedAt":{}}')
    await assert.rejects(store.read(), /version 1/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('textFromContent 拼接 text 块并忽略其他块', () => {
  assert.equal(textFromContent('plain'), 'plain')
  assert.equal(
    textFromContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }]),
    'a b',
  )
  assert.equal(textFromContent([]), '')
  assert.equal(textFromContent(null), '')
})

test('extractPreview：blank 判定 + 取最近一条人类提问', () => {
  const events = [
    userEvent('第一条', 1_000),
    { type: 'turn/start', turn: 1 },
    userEvent('第二条', 2_000),
    userEvent('插件注入', 3_000, 'plugin'),
  ]
  assert.deepEqual(extractPreview(events, 160), { blank: false, preview: '第二条' })
  assert.deepEqual(extractPreview([userEvent('未开始', 1_000)], 160), { blank: true, preview: '未开始' })
  assert.deepEqual(extractPreview([], 160), { blank: true, preview: '' })
})

test('extractPreview 超长截断带省略号', () => {
  const long = 'x'.repeat(300)
  const folded = extractPreview([userEvent(long)], 50)
  assert.equal(folded.preview.length, 50)
  assert.ok(folded.preview.endsWith('…'))
})

test('buildArchiveList：工作区归属、排序、inspect 失败降级', async () => {
  const registry = fakeRegistry({
    archived: ['session-b', 'session-a', 'session-lost'],
    workspaces: [
      { id: 'ws-1', title: 'Demo', path: 'D:/Demo', sessionIds: ['session-a'] },
    ],
  })
  const persistence = fakePersistence({
    headers: [
      { id: 'session-a', createdAt: 100, cwd: 'D:/Demo' },
      { id: 'session-b', createdAt: 300 },
      { id: 'session-lost', createdAt: 200 },
    ],
    inspections: new Map([
      ['session-a', [{ type: 'turn/start', turn: 1 }, userEvent('关于 A 的任务')]],
      ['session-b', []],
    ]),
  })
  const rows = await buildArchiveList(registry, persistence, 160)
  assert.equal(rows.length, 3)
  // createdAt 降序：b(300) → lost(200) → a(100)
  assert.deepEqual(rows.map(row => row.sessionId), ['session-b', 'session-lost', 'session-a'])
  const [rowB, rowLost, rowA] = rows
  assert.equal(rowB.blank, true)
  assert.equal(rowB.workspaceTitle, null)
  assert.equal(rowA.workspaceTitle, 'Demo')
  assert.equal(rowA.workspacePath, 'D:/Demo')
  assert.equal(rowA.cwd, 'D:/Demo')
  assert.equal(rowA.preview, '关于 A 的任务')
  assert.equal(rowA.previewAvailable, true)
  assert.equal(rowLost.previewAvailable, false)
  assert.equal(rowLost.blank, false)
})

test('unarchiveSession 只移除目标且幂等', async () => {
  const registry = fakeRegistry({ archived: ['session-a', 'session-b'] })
  const after = await unarchiveSession(registry, 'session-a')
  assert.deepEqual(after, ['session-b'])
  assert.deepEqual(registry.archivedSessionIds, ['session-b'])
  // 幂等：未归档的 id 直接返回当前集合
  const again = await unarchiveSession(registry, 'session-a')
  assert.deepEqual(again, ['session-b'])
})

test('unarchiveSession 在队列内重读集合，不丢并发归档', async () => {
  const registry = fakeRegistry({ archived: ['session-a', 'session-b'] })
  const enqueue = registry.enqueueOperation
  let runQueued
  registry.enqueueOperation = operation => {
    // 推迟队列执行：捕获操作，等测试注入并发变更后再放行
    return new Promise(resolve => {
      runQueued = async () => resolve(await operation())
    })
  }
  const pending = unarchiveSession(registry, 'session-a')
  // 排队期间另一个客户端又归档了 session-c（集合在队列执行前被外部追加）
  registry.__state.archivedSessionIds.push('session-c')
  registry.enqueueOperation = enqueue
  await runQueued()
  await pending
  assert.deepEqual(registry.archivedSessionIds, ['session-b', 'session-c'])
})

test('unarchiveSession 形状不兼容时显式报错', async () => {
  const bare = { archivedSessionIds: ['session-a'], list: () => [] }
  await assert.rejects(
    unarchiveSession(bare, 'session-a'),
    /enqueueOperation\/setState/,
  )
})

function fakeHttp() {
  const routes = []
  return {
    webServer: {
      register: entry => {
        routes.push(entry)
        return () => {}
      },
    },
    tools: { register: () => () => {} },
    routes,
  }
}

function fakeReq(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers,
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(body ?? ''))
      if (event === 'end') listener()
    },
  }
}

function fakeRes() {
  const res = {
    code: 0,
    body: '',
    writeHead(code) {
      res.code = code
    },
    end(body) {
      res.body = String(body ?? '')
    },
  }
  return res
}

async function setupApi(archived, options = {}) {
  const registry = fakeRegistry({
    archived,
    workspaces: options.workspaces ?? [],
  })
  const persistence = fakePersistence({
    headers: archived.map((id, index) => ({ id, createdAt: index })),
    locateBase: options.locateBase,
  })
  const http = fakeHttp()
  const archiveTimeTracker = new archiveVault.ArchiveTimeTracker({
    initialArchivedIds: archived,
    store: {
      read: async () => ({ ...(options.archivedAt ?? {}) }),
      write: async () => {},
    },
    now: () => options.now ?? Date.now(),
  })
  const ctxRoot = {
    effect: fn => fn(),
    on: () => () => {},
    logger: undefined,
    get: () => options.liveSessionIds === undefined
      ? undefined
      : { get: id => options.liveSessionIds.includes(id) ? {} : undefined },
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    ...http,
  }
  apply(ctxRoot, { previewMaxChars: 160 }, {
    archiveTimeTracker,
    now: () => options.now ?? Date.now(),
  })
  const handler = http.routes[0].handler
  return { registry, handler }
}

test('HTTP API：GET /summary 返回归档计数与清理候选', async () => {
  const { handler } = await setupApi(['session-a', 'session-b'])
  const res = fakeRes()
  await handler(fakeReq('GET', '/archive-vault/api/summary'), res)
  assert.equal(res.code, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.count, 2)
  assert.deepEqual(payload.cleanup, {
    trackedCount: 0,
    unknownCount: 2,
    eligible7Days: 0,
    eligible30Days: 0,
  })
})

test('HTTP API：按真实归档时间批量清理 7 天候选', async () => {
  const day = 24 * 60 * 60 * 1_000
  const now = 40 * day
  const base = mkdtempSync(join(tmpdir(), 'archive-vault-cleanup-'))
  const ids = ['legacy', 'recent', 'seven', 'thirty']
  try {
    for (const id of ids) {
      const sessionDir = join(base, id)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'x')
    }
    const { handler, registry } = await setupApi(ids, {
      locateBase: base.replaceAll('\\', '/'),
      now,
      archivedAt: {
        recent: now - 6 * day,
        seven: now - 7 * day,
        thirty: now - 30 * day,
      },
    })

    const listed = fakeRes()
    await handler(fakeReq('GET', '/archive-vault/api/summary'), listed)
    assert.deepEqual(JSON.parse(listed.body).cleanup, {
      trackedCount: 3,
      unknownCount: 1,
      eligible7Days: 2,
      eligible30Days: 1,
    })

    const cleaned = fakeRes()
    await handler(
      fakeReq('POST', '/archive-vault/api/cleanup', JSON.stringify({ days: 7 }), {
        origin: 'http://localhost:3080',
        host: 'localhost:3080',
      }),
      cleaned,
    )
    assert.deepEqual(JSON.parse(cleaned.body), {
      ok: true,
      days: 7,
      eligibleCount: 2,
      deletedCount: 2,
      deletedSessionIds: ['seven', 'thirty'],
      failedCount: 0,
      failures: [],
    })
    assert.deepEqual(registry.archivedSessionIds, ['legacy', 'recent'])
    assert.equal(existsSync(join(base, 'seven')), false)
    assert.equal(existsSync(join(base, 'thirty')), false)
    assert.equal(existsSync(join(base, 'legacy')), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('HTTP API：批量清理拒绝 7 和 30 以外的阈值', async () => {
  const { handler } = await setupApi([])
  const res = fakeRes()
  await handler(fakeReq('POST', '/archive-vault/api/cleanup', JSON.stringify({ days: 14 })), res)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'days must be 7 or 30' })
})

test('HTTP API：并发批量清理串行重算候选，不重复删除', async () => {
  const day = 24 * 60 * 60 * 1_000
  const now = 40 * day
  const base = mkdtempSync(join(tmpdir(), 'archive-vault-cleanup-race-'))
  try {
    const sessionDir = join(base, 'old-session')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'x')
    const { handler } = await setupApi(['old-session'], {
      locateBase: base.replaceAll('\\', '/'),
      now,
      archivedAt: { 'old-session': now - 30 * day },
    })
    const first = fakeRes()
    const second = fakeRes()
    const request = () => fakeReq('POST', '/archive-vault/api/cleanup', JSON.stringify({ days: 7 }))

    await Promise.all([handler(request(), first), handler(request(), second)])

    const results = [JSON.parse(first.body), JSON.parse(second.body)]
    assert.deepEqual(results.map(result => result.eligibleCount).sort(), [0, 1])
    assert.equal(results.reduce((sum, result) => sum + result.deletedCount, 0), 1)
    assert.equal(results.reduce((sum, result) => sum + result.failedCount, 0), 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('HTTP API：未知路径 404，清理参数校验报错', async () => {
  const { handler } = await setupApi([])
  const missing = fakeRes()
  await handler(fakeReq('POST', '/archive-vault/api/cleanup', '{}'), missing)
  assert.equal(JSON.parse(missing.body).ok, false)

  const unknown = fakeRes()
  await handler(fakeReq('GET', '/archive-vault/api/nope'), unknown)
  assert.equal(unknown.code, 404)
})

test('deleteArchivedSession：live 会话拒绝且不产生任何变更', async () => {
  const registry = fakeRegistry({ archived: ['session-a'] })
  const persistence = fakePersistence({ headers: [{ id: 'session-a', createdAt: 1 }] })
  const removed = []
  await assert.rejects(
    deleteArchivedSession({
      registry,
      persistence,
      isLive: id => id === 'session-a',
      removeArtifact: async dir => removed.push(dir),
    }, 'session-a'),
    /正在运行/,
  )
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  assert.deepEqual(removed, [])
})

test('deleteArchivedSession：清归档集、detach 记账、删会话目录', async () => {
  const ws = workspaceEntity({ id: 'ws-1', title: 'Demo', path: 'D:/Demo', sessionIds: ['session-a', 'session-b'] })
  const registry = fakeRegistry({ archived: ['session-a'], workspaces: [ws] })
  const persistence = fakePersistence({ headers: [{ id: 'session-a', createdAt: 1 }, { id: 'session-b', createdAt: 2 }] })
  const removed = []
  const result = await deleteArchivedSession({
    registry,
    persistence,
    isLive: () => false,
    removeArtifact: async dir => removed.push(dir),
  }, 'session-a')
  assert.equal(result.artifactDeleted, true)
  assert.equal(result.artifactPath, `D:/fake/sessions/--proj--/session-a`)
  assert.deepEqual(registry.archivedSessionIds, [])
  assert.deepEqual(ws.__record.sessionIds, ['session-b'])
  assert.deepEqual(removed, [`D:/fake/sessions/--proj--/session-a`])
})

test('deleteArchivedSession：日志已缺失时仍清引用且不报错', async () => {
  const ws = workspaceEntity({ id: 'ws-1', title: 'Demo', path: 'D:/Demo', sessionIds: ['session-gone'] })
  const registry = fakeRegistry({ archived: ['session-gone'], workspaces: [ws] })
  const persistence = fakePersistence({ headers: [] })
  const removed = []
  const result = await deleteArchivedSession({
    registry,
    persistence,
    isLive: () => false,
    removeArtifact: async dir => removed.push(dir),
  }, 'session-gone')
  assert.deepEqual(result, { sessionId: 'session-gone', artifactDeleted: false, artifactPath: null })
  assert.deepEqual(registry.archivedSessionIds, [])
  assert.deepEqual(ws.__record.sessionIds, [])
  assert.deepEqual(removed, [])
})

test('deleteArchivedSession：非归档会话（失败重试场景）仍可删', async () => {
  const registry = fakeRegistry({ archived: [] })
  const persistence = fakePersistence({ headers: [{ id: 'session-a', createdAt: 1 }] })
  const result = await deleteArchivedSession({
    registry,
    persistence,
    isLive: () => false,
    removeArtifact: async () => {},
  }, 'session-a')
  assert.equal(result.artifactDeleted, true)
})

test('deleteArchivedSession：目录名不含会话 id 时拒绝删文件', async () => {
  const registry = fakeRegistry({ archived: ['session-a'] })
  // 构造异常布局：locate 指向的父目录名与会话 id 无关
  const weird = {
    list: async () => [{ id: 'session-a', createdAt: 1 }],
    inspect: async () => ({ meta: {}, events: [] }),
    locate: () => ({ kind: 'jsonl', path: 'D:/elsewhere/other-name/session.jsonl.zstd' }),
  }
  const removed = []
  await assert.rejects(
    deleteArchivedSession({
      registry,
      persistence: weird,
      isLive: () => false,
      removeArtifact: async dir => removed.push(dir),
    }, 'session-a'),
    /目录名异常/,
  )
  // 引用清理已完成，文件未动
  assert.deepEqual(registry.archivedSessionIds, [])
  assert.deepEqual(removed, [])
})
