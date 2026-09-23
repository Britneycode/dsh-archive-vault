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
//# sourceMappingURL=client-sync.js.map