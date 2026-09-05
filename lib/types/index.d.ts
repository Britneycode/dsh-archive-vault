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
import type { Context } from 'cordis';
import { ArchiveTimeTracker } from './archive-cleanup.js';
export { cleanupButtonLabel, reconcileDeletedSession, reconcileDeletedSessions, } from './client-sync.js';
export type { CleanupButtonState, DeleteManyReconcileDeps, DeleteReconcileDeps, } from './client-sync.js';
export { ArchiveTimeFileStore, ArchiveTimeTracker, cleanupArchivedSessions, eligibleArchivedSessionIds, reconcileArchiveTimes, } from './archive-cleanup.js';
export type { ArchivedAtMap, ArchiveTimeStore, ArchiveTimeTrackerOptions, ArchiveTimeReconcileInput, ArchiveTimeReconcileResult, CleanupFailure, CleanupResult, } from './archive-cleanup.js';
export declare const name = "dsh-archive-vault";
export declare const inject: string[];
export interface Config {
    /** 预览文本最大字符数。 */
    previewMaxChars: number;
}
export declare const Config: Config;
/** 面板与工具共用的归档行投影。 */
export interface ArchiveRow {
    sessionId: string;
    /** Unix epoch 毫秒（来自会话头；缺失时 0）。 */
    createdAt: number;
    cwd: string | null;
    workspaceId: string | null;
    workspaceTitle: string | null;
    workspacePath: string | null;
    /** 会话从未开始过任何一轮（dsh 列表语义：blank）。 */
    blank: boolean;
    /** 最近一条人类提问文本（截断）；读不到日志时为空串。 */
    preview: string;
    /** 会话日志是否读取失败（预览降级）。 */
    previewAvailable: boolean;
}
type AppContext = Context & {
    webServer: any;
    tools: any;
    workspaceRegistry: any;
    sessionPersistence: any;
};
/** 可注入运行时依赖（HTTP 集成测试使用内存跟踪器与固定时钟）。 */
export interface ApplyRuntime {
    archiveTimeTracker?: ArchiveTimeTracker;
    now?: () => number;
}
/** ContentBlock 文本抽取（仅 type:'text' 可见文本块；reasoning 等其他块忽略）。 */
export declare function textFromContent(content: unknown): string;
/**
 * 从会话事件流折叠列表展示信息：blank（无 turn/start）与最近一条人类
 * 提问（user/message 且 source.kind === 'user'——与 apiproxy 的
 * SessionListMetadata 折叠同判据）。
 */
export declare function extractPreview(events: readonly unknown[], maxChars: number): {
    blank: boolean;
    preview: string;
};
export declare function buildArchiveList(registry: any, persistence: any, previewMaxChars: number): Promise<ArchiveRow[]>;
/**
 * 恢复一个归档会话：从 registry 全局归档集合移除。幂等（未归档直接
 * 返回当前集合）。变更经 registry 的串行队列与官方写入互斥；集合成员
 * 在队列内重读，不丢其它客户端的并发归档。返回更新后的完整集合。
 */
export declare function unarchiveSession(registry: any, sessionId: string): Promise<string[]>;
/** deleteArchivedSession 的可注入依赖（测试替身用）。 */
export interface DeleteDeps {
    registry: any;
    persistence: any;
    /** 会话当前是否 live（运行中/打开中）——live 会话拒绝删除。 */
    isLive: (sessionId: string) => boolean;
    /** 删除会话目录（生产为 fs rm recursive；测试注入捕获路径）。 */
    removeArtifact: (sessionDir: string) => Promise<void>;
}
/** 删除结果：registry 引用总是清理；artifactDeleted 说明日志目录是否真的删了。 */
export interface DeleteResult {
    sessionId: string;
    artifactDeleted: boolean;
    artifactPath: string | null;
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
export declare function deleteArchivedSession(deps: DeleteDeps, sessionId: string): Promise<DeleteResult>;
export declare function apply(ctx: AppContext, config: Config, runtime?: ApplyRuntime): void;
