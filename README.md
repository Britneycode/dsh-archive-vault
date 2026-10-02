# dsh-archive-vault-desktop 归档清理（桌面端）

在 [dsh-archive-vault](https://github.com/Britneycode/dsh-archive-vault) 的基础上做的
**桌面端（DeepSeek Harness Desktop）** 版本：功能与宿主契约完全沿用上游，只重写设置页
面板，让它和桌面端设置界面同一套设计系统——并且**跟着桌面端一起变**。

- **设置页 → 归档清理**（导航项 `archived-sessions`）：显示归档会话数量与归档时间
  跟踪状态，「清理 7 天以上」「清理 30 天以上」按实际归档时间批量永久删除。单项失败
  不中止其余清理，完成后分别报告成功数与失败数；
- **永久删除**：清除归档记录、工作区记账并删除磁盘上的会话日志；正在运行的会话会被拒绝；
- **agent 工具**：`list_archived_sessions` / `unarchive_session` /
  `delete_archived_session`，在会话里也能直接找回或清理旧对话。

浏览与恢复归档会话由桌面端左侧会话列表承担（视图筛选「仅显示已归档」+ 行菜单的
取消归档）；上游文档里提到的内置「Archived sessions」设置页在当前桌面端版本
（`@deepseek-ai/dsh-*` 0.2.0-rc.2）里并不存在，本插件不再让用户去找它。

## 为什么它是「桌面端」插件

桌面端进程跑的就是 `dsh-web-app` 那套 web 前端（`dsh-desktop-host` 里
`profile: "desktop"` → `runProfile`），所以：

- **浏览器半边必须声明 `dsh.client.platform = "web"`。** 写成 `"desktop"` 会被
  `@deepseek-ai/dsh-client-modules` 的扫描直接判为「不是客户端包」
  （`decl.platform !== "web"` → `null`），面板永远不会出现。桌面端的差异体现在
  profile 名（`profileContext.name === 'desktop'`）和宿主行的开关上，不在这个字段上；
- **面板控件全部来自桌面端自带的基线模块 `@deepseek-ai/dsh-client-ui-primitives`**
  ——shell 的 `PLATFORM_MODULES` 静态表里有它，桌面端设置页用的就是同一批
  `Button` / `RiskConfirmation` / `Toast`。插件不打包、不复制任何宿主组件，
  所以桌面端改版时面板的按钮、对话框、提示条跟着一起变；
- **不可逆操作走桌面端的 `RiskConfirmation`**（模态 + 勾选确认），不再自造红色
  按钮和 5 秒二次点击；
- **颜色只走 `--dsw-*` 语义令牌**，跟随桌面端亮/暗主题；
- 排版沿用桌面端设置页的标尺：页标题 16/24 medium、行标题 14/20、行说明
  12/18 `label-secondary`、行分隔 0.5px `border-l2`、行内边距 16px 0。

导航项 id 用宿主的 `archived-sessions`：`settings-general` 的 `navIcon` 只给几个
已知 id 配图标，未知 id 一律回落成齿轮图标。

## 安装（桌面端 profile）

本包现居 `~/.dsh/plugins/dsh-archive-vault-desktop`（安装目录之外，应用更新不会
覆盖）。用官方 CLI 安装/重装，它会自动完成 pnpm 安装与 `dsh.profile.bundles` 对账：

```bash
dsh plugin --profile desktop add "C:/Users/<你>/.dsh/plugins/dsh-archive-vault-desktop"
dsh plugin --profile desktop remove dsh-archive-vault-desktop   # 卸载
```

装完**重启桌面端**：profile 的 bundle 列表在启动时读取。

安装以 `link:` 方式挂进 `~/.dsh/profiles/desktop`，插件对宿主包（`@deepseek-ai/dsh-llm`
等）的导入由桌面端 boot 的运行时解析重定向到 app 安装目录内的同版本包（profile 的
pnpm-workspace.yaml 固定 `autoInstallPeers: false`，peer 不落盘）。

> 本包与上游 `dsh-archive-vault` 功能重叠（同一个 `/archive-vault/api` 路由、同一个
> `delete_archived_session` 工具），**不要同时装两个**。

## 开发

```bash
pnpm install        # 或 npm install
npm run typecheck   # 检查浏览器半边
npm run build       # 只构建 lib/client.js
npm test            # 宿主半边 25 个用例 + 浏览器半边 5 个用例
```

改完 `src/client/index.tsx` 后 `npm run build`，重启桌面端即可生效（profile 以 link
方式引用本目录，无需重装）。

宿主半边（`lib/index.js`、`lib/archive-cleanup.js`、`lib/client-sync.js`）是上游
v0.3.0 的构建产物，未做改动，其 TS 源码保留在 `src/*.ts` 供查阅；重建宿主半边需要
DSH 源码 checkout（上游 `scripts/build.mjs` 的做法），本包的 `scripts/build.mjs`
只负责浏览器半边。

`tests/client-bundle.test.mjs` 里有一条测试会**从运行中的桌面端安装目录读
`app.asar`**，取出 shell 前端里真实的 `PLATFORM_MODULES` 表，逐条核对 bundle 的
`require` 目标——桌面端升级换了共享模块表，这条会先红。本包已不在安装目录旁边，
默认会 skip 这条；要跑全量请设：

```bash
DSH_DESKTOP_ROOT="D:/App/deepseek harness" npm test
```

`@deepseek-ai/dsh-tools` 在测试里由 `tests/stubs/dsh-tools` 替身提供（devDependencies
里的 `link:` 指向它）；宿主半边的用例不经过 tools 注册路径，替身只负责可解析。

## 实现说明（沿用上游，未改动）

- 取消归档走 `WorkspaceRegistry` 实例的串行写队列（`enqueueOperation` + `setState`，
  宿主里是 TS private、运行时可访问），与 create/delete/reorder/archive 完全互斥；
  宿主改名这两个方法时插件显式报错，不会静默写坏状态；
- 永久删除按「失败偏向会话重新可见」的顺序组装：live 会话拒绝 → 退出归档集合 →
  `detachSession` 清工作区记账 → 删 `persistence.locate()` 定位到的会话目录
  （目录名不含会话 id 时拒绝删文件），全程幂等；
- 归档时间：只从插件启用后发生的新归档开始记录，历史归档显示为「归档时间未知」，
  不进入批量清理范围；状态文件 `$DSH_HOME/archive-vault/archive-times.json`
  （默认 `~/.dsh/archive-vault/archive-times.json`），版本化 JSON + 原子替换，
  读取异常时批量清理失败关闭。

## 许可

BSD-3-Clause（同上游）。
