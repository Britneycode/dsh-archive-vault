# dsh-archive-vault 归档对话

dsh 宿主只有"归档会话"（`workspace.archiveSession`：把会话从所有分组界面隐藏），
没有查看、恢复或删除归档会话的入口。本插件补齐这一环：

- **设置页 → 归档对话**：列出所有归档会话（所属工作区、创建时间、最近一条
  人类提问预览、cwd），支持关键词过滤；
- **一键恢复**：把会话从全局归档集合移除，立即回到原工作区会话列表的
  **原位置**（归档不改变工作区记账，恢复自动还原位置）；
- **永久删除**：两步确认（点「删除」→ 变红「确认删除」），清除归档记录、
  工作区记账并删除磁盘会话日志；正在运行的会话会被拒绝；
- **实时刷新**：恢复写入 workspace domain global，触发 `domain/changed`，
  apiproxy 自动向所有已连接的 Web 客户端推送 `host/archived-sessions-changed`，
  左侧列表实时更新，无需手动刷新页面；
- **agent 工具**：`list_archived_sessions` / `unarchive_session` /
  `delete_archived_session`，在会话里也能直接找回或清理旧对话。

## 恢复的写入路径（兼容性说明）

宿主 `WorkspaceRegistry` 只公开 `archiveSession`，没有 unarchive。本插件的
恢复走 registry 实例的串行写队列（`enqueueOperation` + `setState`，宿主里是
TS private、运行时可访问）：

- 与 create/delete/reorder/archive 的所有写完全互斥，不会丢并发变更；
- 归档集合在队列内重读，排队期间其他客户端的新归档不会丢失；
- 写入的 state 形状与宿主 `recoverPendingMutation` 产出的三字段一致，
  通过 apiproxy 的 `workspaceDomainState` zod 校验；
- 宿主若改名这两个方法，插件显式报错（不会静默写坏状态）。

## 删除的写入路径

宿主全链路没有会话删除 API（持久化后端只有 create/append/read）。删除按
"失败偏向重新可见"的顺序组装：

1. live 会话拒绝（`sessions.get(id)` 有值时不动文件）；
2. 从归档集合移除（同恢复路径，幂等）；
3. 从所属工作区记账移除（`entity.detachSession`，公开方法、domain 写链、
   幂等，自动推 `host/workspace-changed` 帧）；
4. `persistence.locate()` 定位日志文件，删除其父目录（`sessions/<project>/
   session-<uuid>`）；目录名不含会话 id 时拒绝删文件（防后端布局变化误删）。

日志删除后 `persistence.list()` 立即不再列出该会话（客户端基线随之消失，
无需重启）；projection cache 行与日志身份绑定，过期行自动作废，无需清理。
删除不要求会话仍在归档集合（幂等）：中途失败后重试不会卡在半完成状态。

## 开发

```bash
DSH_CHECKOUT=/d/App/dsh/deepseek-harness npm run typecheck
DSH_CHECKOUT=/d/App/dsh/deepseek-harness npm run build
npm test
```

