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
