/**
 * defineTool 的本地测试替身。
 *
 * 宿主半边的 25 个用例不经过 tools 注册路径（fake ctx 没有 tools 服务，
 * apply() 对其缺省跳过），所以这里只需要：
 *  1. 让 `import { defineTool } from '@deepseek-ai/dsh-tools'` 在 `npm test`
 *     与 typecheck 下可解析；
 *  2. 近透传保留 name/description/execute，供将来需要时手工调试注册产物。
 */

/** 近透传：保留工具身份与执行函数，不做任何 schema 校验。 */
export function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: options.execute,
  }
}

export default defineTool
