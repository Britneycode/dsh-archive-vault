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
  const ctxRoot = {
    effect: fn => fn(),
    logger: undefined,
    get: () => undefined,
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    ...http,
  }
  apply(ctxRoot, { previewMaxChars: 160 })
  const handler = http.routes[0].handler
  return { registry, handler }
}

test('HTTP API：GET /list 返回归档清单', async () => {
  const { handler } = await setupApi(['session-a', 'session-b'])
  const res = fakeRes()
  await handler(fakeReq('GET', '/archive-vault/api/list'), res)
  assert.equal(res.code, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.count, 2)
  assert.equal(payload.sessions[0].sessionId, 'session-b')
})

test('HTTP API：POST /unarchive 校验同源并恢复', async () => {
  const { handler, registry } = await setupApi(['session-a', 'session-b'])
  const foreign = fakeRes()
  await handler(
    fakeReq('POST', '/archive-vault/api/unarchive', JSON.stringify({ sessionId: 'session-a' }), {
      origin: 'https://evil.example',
      host: 'localhost:3080',
    }),
    foreign,
  )
  assert.equal(foreign.code, 403)

  const res = fakeRes()
  await handler(
    fakeReq('POST', '/archive-vault/api/unarchive', JSON.stringify({ sessionId: 'session-a' }), {
      origin: 'http://localhost:3080',
      host: 'localhost:3080',
    }),
    res,
  )
  assert.equal(res.code, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(registry.archivedSessionIds, ['session-b'])
})

test('HTTP API：未知路径 404，缺 sessionId 报错', async () => {
  const { handler } = await setupApi([])
  const missing = fakeRes()
  await handler(fakeReq('POST', '/archive-vault/api/unarchive', '{}'), missing)
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

test('HTTP API：POST /delete 真实删除临时目录', async () => {
  const base = mkdtempSync(join(tmpdir(), 'archive-vault-'))
  try {
    const sessionDir = join(base, 'session-todelete')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'x')
    const { handler, registry } = await setupApi(['session-todelete'], {
      locateBase: base.replaceAll('\\', '/'),
    })
    const res = fakeRes()
    await handler(
      fakeReq('POST', '/archive-vault/api/delete', JSON.stringify({ sessionId: 'session-todelete' }), {
        origin: 'http://localhost:3080',
        host: 'localhost:3080',
      }),
      res,
    )
    assert.equal(res.code, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.artifactDeleted, true)
    assert.equal(existsSync(sessionDir), false)
    assert.deepEqual(registry.archivedSessionIds, [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
