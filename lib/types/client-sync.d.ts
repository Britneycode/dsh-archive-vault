/** 删除成功后的客户端会话清单同步依赖。 */
export interface DeleteReconcileDeps {
    /** 立即从归档面板移除已删除的行。 */
    removeRow: (sessionId: string) => void;
    /** 从宿主重新读取权威会话清单。 */
    refreshSessions: () => Promise<void>;
}
/** 批量删除成功后的客户端会话清单同步依赖。 */
export interface DeleteManyReconcileDeps {
    /** 立即从归档面板移除已删除的行。 */
    removeRows: (sessionIds: readonly string[]) => void;
    /** 从宿主重新读取权威会话清单。 */
    refreshSessions: () => Promise<void>;
}
/** 批量清理按钮的可见状态。 */
export type CleanupButtonState = 'idle' | 'armed' | 'busy';
/**
 * 生成固定宽度按钮使用的批量清理文案。
 * @param days - 归档时长阈值。
 * @param count - 当前候选数。
 * @param state - 空闲、二次确认或执行中。
 * @returns 按钮可见文本。
 */
export declare function cleanupButtonLabel(days: 7 | 30, count: number, state: CleanupButtonState): string;
/**
 * 删除成功后移除归档面板行并刷新宿主会话清单。
 *
 * 服务端删除已经完成，因此刷新失败作为结果返回，不能再被上层误报为
 * 删除失败。
 *
 * @param sessionId - 已永久删除的会话 id。
 * @param deps - 面板行移除与宿主清单刷新操作。
 * @returns `null` 表示同步完成，否则返回刷新失败原因。
 */
export declare function reconcileDeletedSession(sessionId: string, deps: DeleteReconcileDeps): Promise<unknown | null>;
/**
 * 批量删除成功后移除归档面板行并刷新宿主会话清单。
 * @param sessionIds - 已永久删除的会话 id。
 * @param deps - 面板行移除与宿主清单刷新操作。
 * @returns `null` 表示同步完成，否则返回刷新失败原因。
 */
export declare function reconcileDeletedSessions(sessionIds: readonly string[], deps: DeleteManyReconcileDeps): Promise<unknown | null>;
