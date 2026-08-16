/**
 * 生成固定宽度按钮使用的批量清理文案。
 * @param days - 归档时长阈值。
 * @param count - 当前候选数。
 * @param state - 空闲、二次确认或执行中。
 * @returns 按钮可见文本。
 */
export function cleanupButtonLabel(days, count, state) {
    if (state === 'busy')
        return '清理中…';
    if (state === 'armed')
        return `确认删除 ${count} 个`;
    return `清理 ${days} 天以上 (${count})`;
}
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
export async function reconcileDeletedSession(sessionId, deps) {
    return reconcileDeletedSessions([sessionId], {
        removeRows: sessionIds => deps.removeRow(sessionIds[0] ?? sessionId),
        refreshSessions: deps.refreshSessions,
    });
}
/**
 * 批量删除成功后移除归档面板行并刷新宿主会话清单。
 * @param sessionIds - 已永久删除的会话 id。
 * @param deps - 面板行移除与宿主清单刷新操作。
 * @returns `null` 表示同步完成，否则返回刷新失败原因。
 */
export async function reconcileDeletedSessions(sessionIds, deps) {
    deps.removeRows(sessionIds);
    try {
        await deps.refreshSessions();
        return null;
    }
    catch (error) {
        return error;
    }
}
//# sourceMappingURL=client-sync.js.map