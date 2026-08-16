/** 会话 id 到归档时间（Unix epoch 毫秒）的持久化映射。 */
export type ArchivedAtMap = Readonly<Record<string, number>>;
/** 归档时间持久化后端。 */
export interface ArchiveTimeStore {
    /** 读取完整归档时间映射。 */
    read: () => Promise<Record<string, number>>;
    /** 原子替换完整归档时间映射。 */
    write: (archivedAt: ArchivedAtMap) => Promise<void>;
}
/** 一次归档集合变化的输入。 */
export interface ArchiveTimeReconcileInput {
    previousArchivedIds: readonly string[];
    nextArchivedIds: readonly string[];
    archivedAt: ArchivedAtMap;
    now: number;
}
/** 一次归档集合变化的结果。 */
export interface ArchiveTimeReconcileResult {
    archivedAt: Record<string, number>;
    changed: boolean;
}
/**
 * 将归档时间映射推进到新的宿主归档集合。
 *
 * 只为本次新增的 id 记录时间；启动时已经归档但没有记录的 id 保持未知。
 * 取消归档会移除旧时间，因此再次归档会从新的归档时刻重新计时。
 *
 * @param input - 前后归档集合、已有时间与当前时刻。
 * @returns 新映射及其是否发生变化。
 */
export declare function reconcileArchiveTimes(input: ArchiveTimeReconcileInput): ArchiveTimeReconcileResult;
/**
 * 按归档时长筛选批量清理候选；未知归档时间不会进入结果。
 *
 * @param archivedSessionIds - 宿主当前归档顺序。
 * @param archivedAt - 已知归档时间。
 * @param days - 最小归档天数。
 * @param now - 当前 Unix epoch 毫秒。
 * @returns 保持宿主归档顺序的候选 id。
 */
export declare function eligibleArchivedSessionIds(archivedSessionIds: readonly string[], archivedAt: ArchivedAtMap, days: number, now: number): string[];
/** 单条批量清理失败。 */
export interface CleanupFailure {
    sessionId: string;
    error: string;
}
/** 批量清理结果。 */
export interface CleanupResult {
    deletedSessionIds: string[];
    failures: CleanupFailure[];
}
/**
 * 顺序删除候选并隔离单条失败。
 *
 * @param sessionIds - 待删除会话 id。
 * @param deleteOne - 单条永久删除操作。
 * @returns 成功 id 与失败明细。
 */
export declare function cleanupArchivedSessions(sessionIds: readonly string[], deleteOne: (sessionId: string) => Promise<unknown>): Promise<CleanupResult>;
/** 归档时间跟踪器构造参数。 */
export interface ArchiveTimeTrackerOptions {
    initialArchivedIds: readonly string[];
    store: ArchiveTimeStore;
    now?: () => number;
}
/**
 * 串行持久化宿主归档集合变化，并提供一致的时间快照。
 *
 * 任意持久化错误会使队列保持拒绝状态，所有读取与后续写入都失败关闭。
 */
export declare class ArchiveTimeTracker {
    private readonly options;
    private archivedIds;
    private archivedAt;
    private tail;
    private readonly now;
    /** @param options - 初始宿主归档集合、持久化后端与时钟。 */
    constructor(options: ArchiveTimeTrackerOptions);
    /**
     * 记录宿主提交后的完整归档集合。
     * @param archivedSessionIds - 最新归档 id 顺序。
     * @returns 本次持久化完成。
     */
    observe(archivedSessionIds: readonly string[]): Promise<void>;
    /** @returns 完成所有排队事件后的归档时间副本。 */
    snapshot(): Promise<Record<string, number>>;
    private initialize;
}
/** 版本 1 归档时间文件后端。 */
export declare class ArchiveTimeFileStore implements ArchiveTimeStore {
    readonly path: string;
    /** @param path - 状态 JSON 的绝对路径。 */
    constructor(path: string);
    /** @returns 已验证的归档时间映射；文件不存在时为空映射。 */
    read(): Promise<Record<string, number>>;
    /** @param archivedAt - 要原子替换的完整映射。 */
    write(archivedAt: ArchivedAtMap): Promise<void>;
}
