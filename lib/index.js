/**
 * dsh-archive-vault — 归档对话（查看 / 恢复 / 删除 / 按归档时长清理）。
 *
 * dsh 宿主只有 workspace.archiveSession（把会话从所有分组界面隐藏），
 * 没有查看或恢复归档会话的入口。本插件补齐：
 *
 *  1. 设置页面板「归档对话」：列出归档会话（所属工作区、创建时间、
 *     最近一条人类提问预览、cwd），支持过滤、恢复、永久删除，以及按
 *     实际归档时间清理 7 天或 30 天以上的会话；
 *  2. 恢复 = 从 WorkspaceRegistry 的全局归档集合移除该会话。归档不改
 *     工作区记账（sessionIds 槽位保留），所以恢复后会话自动回到原位置；
 *  3. 恢复走 registry 自己的串行写队列（enqueueOperation + setState，
 *     与 create/delete/reorder/archive 完全互斥，不丢并发写）；
 *  4. 写入 domain global 触发 domain/changed → apiproxy 自动向所有已连接
 *     Web 客户端推送 host/archived-sessions-changed，侧栏实时刷新——
 *     插件无需（也不能）自己碰推送通道；
 *  5. 归档时间只从插件启用后发生的新归档开始记录；无法确定归档时间的
 *     历史会话不参与批量清理，状态读取异常时清理失败关闭；
 *  6. 附带 agent 工具 list_archived_sessions / unarchive_session /
 *     delete_archived_session，会话内也能直接找回或删除归档对话。
 *
 * 兼容性守卫：unarchive 依赖 registry 的 TS-private 方法（运行时可访问），
 * 形状变更时显式报错而不是静默写坏状态。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import z from 'schemastery';
import { ArchiveTimeFileStore, ArchiveTimeTracker, cleanupArchivedSessions, eligibleArchivedSessionIds, } from './archive-cleanup.js';
export { cleanupButtonLabel, reconcileDeletedSession, reconcileDeletedSessions, } from './client-sync.js';
export { ArchiveTimeFileStore, ArchiveTimeTracker, cleanupArchivedSessions, eligibleArchivedSessionIds, reconcileArchiveTimes, } from './archive-cleanup.js';
export const name = 'dsh-archive-vault';
export const inject = ['workspaceRegistry', 'sessionPersistence', 'webServer', 'tools'];
export const Config = z.object({
    previewMaxChars: z.number().default(160),
});
function archiveTimeStatePath() {
    const configured = process.env['DSH_HOME'];
    const root = configured === undefined || configured.trim() === ''
        ? join(homedir(), '.dsh')
        : resolve(configured);
    return join(root, 'archive-vault', 'archive-times.json');
}
/** ContentBlock 文本抽取（仅 type:'text' 可见文本块；reasoning 等其他块忽略）。 */
export function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') {
            parts.push(block);
        }
        else if (block !== null && typeof block === 'object') {
            const record = block;
            if (record['type'] === 'text' && typeof record['text'] === 'string')
                parts.push(record['text']);
        }
    }
    return parts.join(' ').trim();
}
/**
 * 从会话事件流折叠列表展示信息：blank（无 turn/start）与最近一条人类
 * 提问（user/message 且 source.kind === 'user'——与 apiproxy 的
 * SessionListMetadata 折叠同判据）。
 */
export function extractPreview(events, maxChars) {
    let blank = true;
    let preview = '';
    for (const raw of events) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const event = raw;
        const type = event['type'];
        if (type === 'turn/start')
            blank = false;
        if (type !== 'user/message')
            continue;
        const data = event['data'];
        const source = data?.['source'];
        if (source?.['kind'] !== 'user')
            continue;
        const text = textFromContent(data?.['content']);
        if (text !== '')
            preview = text;
    }
    if (preview.length > maxChars)
        preview = `${preview.slice(0, Math.max(0, maxChars - 1))}…`;
    return { blank, preview };
}
/**
 * 构建归档会话列表。只读路径全部走公开 API（archivedSessionIds / list() /
 * sessionPersistence.list() / inspect()）；单个会话 inspect 失败仅降级预览。
 */
export async function buildArchiveList(registry, persistence, previewMaxChars) {
    const archivedIds = registry.archivedSessionIds ?? [];
    if (archivedIds.length === 0)
        return [];
    const headers = new Map();
    for (const header of await persistence.list()) {
        const record = header;
        headers.set(String(record['id']), {
            createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
            ...(typeof record['cwd'] === 'string' ? { cwd: record['cwd'] } : {}),
        });
    }
    const workspaceOf = new Map();
    for (const workspace of registry.list() ?? []) {
        const record = workspace;
        const id = String(record['id']);
        const owner = {
            id,
            title: String(record['title'] ?? ''),
            path: String(record['path'] ?? ''),
        };
        for (const sessionId of record['sessionIds'] ?? []) {
            workspaceOf.set(String(sessionId), owner);
        }
    }
    const rows = [];
    for (const rawId of archivedIds) {
        const sessionId = String(rawId);
        const header = headers.get(sessionId);
        const workspace = workspaceOf.get(sessionId);
        const row = {
            sessionId,
            createdAt: header?.createdAt ?? 0,
            cwd: header?.cwd ?? null,
            workspaceId: workspace?.id ?? null,
            workspaceTitle: workspace?.title ?? null,
            workspacePath: workspace?.path ?? null,
            blank: false,
            preview: '',
            previewAvailable: true,
        };
        try {
            const inspection = await persistence.inspect(sessionId);
            const events = inspection['events'];
            const folded = extractPreview(Array.isArray(events) ? events : [], previewMaxChars);
            row.blank = folded.blank;
            row.preview = folded.preview;
        }
        catch {
            row.previewAvailable = false;
        }
        rows.push(row);
    }
    rows.sort((left, right) => right.createdAt - left.createdAt);
    return rows;
}
/**
 * 恢复一个归档会话：从 registry 全局归档集合移除。幂等（未归档直接
 * 返回当前集合）。变更经 registry 的串行队列与官方写入互斥；集合成员
 * 在队列内重读，不丢其它客户端的并发归档。返回更新后的完整集合。
 */
export async function unarchiveSession(registry, sessionId) {
    const target = String(sessionId);
    // 原型方法必须以 registry 为接收者调用（摘下来裸调用会丢 this）。
    if (typeof registry?.enqueueOperation !== 'function' || typeof registry?.setState !== 'function') {
        throw new Error('当前 dsh 版本的 WorkspaceRegistry 缺少 enqueueOperation/setState，无法安全恢复归档；请反馈插件作者。');
    }
    const current = registry.archivedSessionIds.map(String);
    if (!current.includes(target))
        return current;
    return await registry.enqueueOperation(async () => {
        const archived = registry.archivedSessionIds
            .map(String)
            .filter(id => id !== target);
        const workspaceIds = registry.list().map(workspace => workspace['id']);
        await registry.setState({
            initialized: true,
            workspaceIds,
            archivedSessionIds: archived,
        });
        return archived;
    });
}
/**
 * 永久删除一个（已归档）会话。宿主没有任何会话删除 API，这里按下述顺序
 * 组装，失败模式偏向"会话重新可见"而不是"无日志的隐身残骸"：
 *
 *  1. live 会话拒绝（删正在写的日志会撕裂 coordinator 状态）；
 *  2. 从全局归档集合移除（unarchiveSession，幂等）；
 *  3. 从所属工作区记账移除（entity.detachSession，公开方法、domain 写链、
 *     幂等，写入自动推 host/workspace-changed 帧）；
 *  4. 删除会话日志目录（persistence.locate 定位文件，删其父目录 =
 *     sessions/<project>/session-<uuid>；目录名不含会话 id 时拒绝，防
 *     后端布局变化误删）。日志删除后 persistence.list() 不再列出该会话，
 *     客户端基线随之消失；projection cache 行与日志身份绑定，过期自动作废。
 *
 * 不要求会话仍在归档集合（步骤 2/3 幂等）：删除中途失败后重试不会卡在
 * "已恢复但没删掉"的状态。
 */
export async function deleteArchivedSession(deps, sessionId) {
    const target = String(sessionId);
    if (deps.isLive(target)) {
        throw new Error(`会话 ${target} 正在运行，请先等它结束（或关闭该会话）再删除。`);
    }
    const headers = await deps.persistence.list();
    const header = headers.find(candidate => String(candidate['id']) === target);
    if (deps.registry.archivedSessionIds.map(String).includes(target)) {
        await unarchiveSession(deps.registry, target);
    }
    for (const workspace of deps.registry.list() ?? []) {
        const record = workspace;
        const members = record['sessionIds'] ?? [];
        if (!members.map(String).includes(target))
            continue;
        if (typeof workspace.detachSession !== 'function') {
            throw new Error('当前 dsh 版本的 Workspace 实体缺少 detachSession，无法清理记账；请反馈插件作者。');
        }
        await workspace.detachSession(target);
    }
    if (header === undefined) {
        return { sessionId: target, artifactDeleted: false, artifactPath: null };
    }
    const location = deps.persistence.locate?.(header);
    const logPath = location?.path;
    if (typeof logPath !== 'string' || logPath === '') {
        throw new Error(`无法定位会话 ${target} 的日志文件（后端未提供 locate），已清理归档与记账引用，日志未删除。`);
    }
    const sessionDir = dirname(logPath);
    if (!basename(sessionDir).includes(target)) {
        throw new Error(`会话日志目录名异常（${sessionDir}），为防误删已中止；归档与记账引用已清理。`);
    }
    await deps.removeArtifact(sessionDir);
    return { sessionId: target, artifactDeleted: true, artifactPath: sessionDir };
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
/** POST 动作仅接受同源请求（Origin 缺失视为非浏览器客户端，放行）。 */
function sameOrigin(req) {
    const origin = req?.headers?.origin;
    if (!origin)
        return true;
    try {
        const parsed = new URL(String(origin));
        return typeof req.headers.host === 'string' && parsed.host === req.headers.host;
    }
    catch {
        return false;
    }
}
export function apply(ctx, config, runtime = {}) {
    const logger = ctx.logger;
    const now = runtime.now ?? Date.now;
    const archiveTimeTracker = runtime.archiveTimeTracker ?? new ArchiveTimeTracker({
        initialArchivedIds: ctx.workspaceRegistry.archivedSessionIds.map(String),
        store: new ArchiveTimeFileStore(archiveTimeStatePath()),
        now,
    });
    let deletionTail = Promise.resolve();
    const enqueueDeletion = (operation) => {
        const result = deletionTail.then(operation);
        deletionTail = result.then(() => { }, () => { });
        return result;
    };
    ctx.effect(() => ctx.on('domain/changed', (change) => {
        if (change?.domain !== 'workspace' || change?.table !== '' || change?.operation !== 'put')
            return;
        const archivedIds = ctx.workspaceRegistry.archivedSessionIds.map(String);
        void archiveTimeTracker.observe(archivedIds).catch((error) => {
            logger?.error?.('[%s] 归档时间持久化失败：%s', name, String(error));
        });
    }), 'dsh-archive-vault: archive time tracking');
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/archive-vault/api',
        handler: async (req, res) => {
            const send = (code, obj) => {
                res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(obj));
            };
            try {
                const url = new URL(req.url ?? '/', 'http://localhost');
                const path = url.pathname.replace(/^\/archive-vault\/api/, '') || '/';
                if (req.method === 'GET' && path === '/list') {
                    const sessions = await buildArchiveList(ctx.workspaceRegistry, ctx.sessionPersistence, config.previewMaxChars);
                    const archivedAt = await archiveTimeTracker.snapshot();
                    const archivedIds = ctx.workspaceRegistry.archivedSessionIds.map(String);
                    const trackedCount = archivedIds.filter(id => archivedAt[id] !== undefined).length;
                    return send(200, {
                        ok: true,
                        count: sessions.length,
                        sessions: sessions.map(row => ({ ...row, archivedAt: archivedAt[row.sessionId] ?? null })),
                        cleanup: {
                            trackedCount,
                            unknownCount: archivedIds.length - trackedCount,
                            eligible7Days: eligibleArchivedSessionIds(archivedIds, archivedAt, 7, now()).length,
                            eligible30Days: eligibleArchivedSessionIds(archivedIds, archivedAt, 30, now()).length,
                        },
                    });
                }
                if (req.method === 'POST' && path === '/unarchive') {
                    if (!sameOrigin(req))
                        return send(403, { ok: false, error: 'forbidden' });
                    const body = JSON.parse(await readBody(req));
                    const sessionId = String(body?.sessionId ?? '').trim();
                    if (sessionId === '')
                        return send(200, { ok: false, error: 'missing sessionId' });
                    const archivedSessionIds = await unarchiveSession(ctx.workspaceRegistry, sessionId);
                    await archiveTimeTracker.observe(archivedSessionIds);
                    return send(200, { ok: true, sessionId, archivedSessionIds });
                }
                if (req.method === 'POST' && path === '/delete') {
                    if (!sameOrigin(req))
                        return send(403, { ok: false, error: 'forbidden' });
                    const body = JSON.parse(await readBody(req));
                    const sessionId = String(body?.sessionId ?? '').trim();
                    if (sessionId === '')
                        return send(200, { ok: false, error: 'missing sessionId' });
                    const result = await enqueueDeletion(async () => {
                        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                        const deleted = await deleteArchivedSession({
                            registry: ctx.workspaceRegistry,
                            persistence: ctx.sessionPersistence,
                            isLive: id => sessions?.get?.(id) !== undefined,
                            removeArtifact: dir => rm(dir, { recursive: true, force: false }),
                        }, sessionId);
                        await archiveTimeTracker.observe(ctx.workspaceRegistry.archivedSessionIds.map(String));
                        return deleted;
                    });
                    logger?.info?.('[%s] 删除归档会话 %s（artifact=%s）', name, sessionId, result.artifactPath ?? '无');
                    return send(200, { ok: true, ...result });
                }
                if (req.method === 'POST' && path === '/cleanup') {
                    if (!sameOrigin(req))
                        return send(403, { ok: false, error: 'forbidden' });
                    const body = JSON.parse(await readBody(req));
                    const days = Number(body?.days);
                    if (days !== 7 && days !== 30)
                        return send(200, { ok: false, error: 'days must be 7 or 30' });
                    const { eligible, result } = await enqueueDeletion(async () => {
                        const archivedAt = await archiveTimeTracker.snapshot();
                        const archivedIds = ctx.workspaceRegistry.archivedSessionIds.map(String);
                        const eligible = eligibleArchivedSessionIds(archivedIds, archivedAt, days, now());
                        const liveSessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                        const result = await cleanupArchivedSessions(eligible, sessionId => deleteArchivedSession({
                            registry: ctx.workspaceRegistry,
                            persistence: ctx.sessionPersistence,
                            isLive: id => liveSessions?.get?.(id) !== undefined,
                            removeArtifact: dir => rm(dir, { recursive: true, force: false }),
                        }, sessionId));
                        await archiveTimeTracker.observe(ctx.workspaceRegistry.archivedSessionIds.map(String));
                        return { eligible, result };
                    });
                    logger?.info?.('[%s] 清理归档超过 %s 天的会话：成功 %s，失败 %s', name, days, result.deletedSessionIds.length, result.failures.length);
                    return send(200, {
                        ok: true,
                        days,
                        eligibleCount: eligible.length,
                        deletedCount: result.deletedSessionIds.length,
                        deletedSessionIds: result.deletedSessionIds,
                        failedCount: result.failures.length,
                        failures: result.failures,
                    });
                }
                return send(404, { ok: false, error: 'not found' });
            }
            catch (error) {
                return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
            }
        },
    }), 'dsh-archive-vault: api');
    // ── 工具：让 agent 在会话里直接查看 / 恢复归档对话 ──
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'list_archived_sessions',
        description: '列出当前用户所有已归档的 dsh 会话（用户在界面上归档后从会话列表隐藏的对话）。'
            + '返回 sessionId、创建时间、工作区、最近一条用户提问预览。'
            + '配合 unarchive_session 工具可以把某个归档会话恢复到会话列表原位置。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute() {
            const sessions = await buildArchiveList(ctx.workspaceRegistry, ctx.sessionPersistence, config.previewMaxChars);
            if (sessions.length === 0)
                return '当前没有归档的会话。';
            return JSON.stringify(sessions.map(row => ({
                sessionId: row.sessionId,
                createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
                cwd: row.cwd,
                workspace: row.workspaceTitle,
                preview: row.blank ? '(空白会话)' : row.preview || '(预览不可用)',
            })), null, 2);
        },
    })), 'dsh-archive-vault: list tool');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'unarchive_session',
        description: '恢复一个已归档的 dsh 会话：把它从全局归档集合移除，会话立即回到'
            + '原工作区会话列表的原位置（所有已连接界面实时刷新）。sessionId 来自'
            + ' list_archived_sessions 的输出。',
        parameters: {
            sessionId: {
                type: 'string',
                required: true,
                description: '要恢复的会话 id（session-<uuid> 形式，来自 list_archived_sessions）',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
            const sessionId = String(args['sessionId'] ?? '');
            const archived = await unarchiveSession(ctx.workspaceRegistry, sessionId);
            return `已恢复会话 ${sessionId}；当前剩余归档会话 ${archived.length} 个。`;
        },
    })), 'dsh-archive-vault: unarchive tool');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'delete_archived_session',
        description: '永久删除一个已归档的 dsh 会话：清除归档记录、工作区记账并删除磁盘上的'
            + '会话日志（不可恢复）。请先与用户确认要删除哪个会话（sessionId 来自'
            + ' list_archived_sessions），再调用本工具。正在运行的会话会被拒绝。',
        parameters: {
            sessionId: {
                type: 'string',
                required: true,
                description: '要删除的会话 id（session-<uuid> 形式，来自 list_archived_sessions）',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
            const sessionId = String(args['sessionId'] ?? '');
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
            const result = await enqueueDeletion(() => deleteArchivedSession({
                registry: ctx.workspaceRegistry,
                persistence: ctx.sessionPersistence,
                isLive: id => sessions?.get?.(id) !== undefined,
                removeArtifact: dir => rm(dir, { recursive: true, force: false }),
            }, sessionId));
            return result.artifactDeleted
                ? `已永久删除会话 ${sessionId}（日志目录 ${result.artifactPath}）。`
                : `已清理会话 ${sessionId} 的归档与记账引用；其日志文件本就不存在。`;
        },
    })), 'dsh-archive-vault: delete tool');
    logger?.info?.('[%s] 归档对话插件启动', name);
}
//# sourceMappingURL=index.js.map