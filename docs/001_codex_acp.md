# 001 · Codex ACP 对接

> 本文定义 Codex ACP 接入设计。登录、项目与多会话布局见 [003 · Web 启动与页面设计](003_web_app_design.md)。

## 目标与边界

Stirrup 是 npm / TypeScript 项目，本篇定义第一个 ACP 接入：在本地网页中操作 Codex 会话。ACP 在此指 Agent Client Protocol，采用稳定 v1。对接链路为：

```text
页面 → ACP TypeScript SDK → 同源 WebSocket → 本地 stdio 转接 → codex-acp → Codex
```

依赖锁定 `@agentclientprotocol/sdk` 2.9.1、`@agentclientprotocol/codex-acp` 2.9.0。客户端使用 SDK 的 `client().onRequest().onNotification().connect()` API，协议方法引用 SDK `methods` 常量。

使用维护方的 `@agentclientprotocol/codex-acp`，不把 Codex App Server 的私有方法当作 ACP 方法。浏览器无法启动本地进程，转接层作为 Vite 插件与页面一起运行，仅负责传输和进程回收。本篇不扩展数据库、服务部署、代理注册中心或多用户服务；本地单用户 Passkey 登录由 003 实现。

## 交互约定

| 页面动作 | ACP 方法 / 事件 | 行为 |
| --- | --- | --- |
| 连接 | `initialize` | 协商版本和能力；展示代理信息、认证方法 |
| 认证 | `authenticate` | 只使用代理实际返回的 methodId；密钥从本地进程环境读取 |
| 新会话 | `session/new` | 使用所选项目的绝对路径，`mcpServers: []` |
| 操作模式 | `session/set_mode` | 从会话返回的 availableModes 中选择；初始为 read-only |
| 发消息 | `session/prompt` | 文本 content block；同一会话一次仅一轮 |
| 接收进度 | `session/update` | 增量消息、思考、工具状态与计划 |
| 工具审批 | `session/request_permission` | 展示代理提供的选项，返回被选中的 optionId |
| 取消 | `session/cancel` | 发通知后继续等待 prompt 最终结果，不以通知发送成功冒充轮次结束 |
| 断开 | 关闭传输 | 取消待决审批、拒绝待决请求、回收适配器进程 |

连接状态与轮次状态分开：未连接 → 初始化 → 已连接；会话建立后才能发送。发送后进入忙碌状态，最终响应或失败后恢复。取消期间禁止新一轮；若代理不结束，用户可断开连接。连接丢失不自动重发消息，以免重复执行。

`sessionId` 由代理生成；JSON-RPC 请求 ID 由 SDK 管理，两者不能混用。只显示当前会话的通知。工具通知按 `toolCallId` 合并，审批按每次请求独立管理。取消、断开或轮次完成时，尚未回答的审批返回 `cancelled`，永不默认批准。

客户端不声明文件系统、终端或实验扩展能力，由 Codex 自己处理其工具。页面不接收密钥、不渲染代理返回的 HTML。会话列表和按实际能力恢复遵循 003；附件不在接口范围内。配置控件与 [DSH 对接](002_dsh_acp.md) 共用：若 Codex 返回 `configOptions`，只呈现其中实际提供的模型等选项。

一个连接只建立一个会话；003 为每个应用会话分配独立连接，新建或切换不关闭其他会话。初始 `read-only` 由适配器约束，需要编辑项目时可在页面切换至代理提供的工作区访问模式。操作模式决定哪些操作需要审批，并不保证每次工具调用都弹出审批。

## 代码职责

- `src/acp/client.ts`：使用 SDK 管理连接、会话、轮次、审批和关闭。
- `src/acp/websocket.ts`：浏览器 WebSocket 与 SDK NDJSON 字节流之间的转换。
- `src/ui/`：页面、消息、工具、计划与审批展示；`src/domain/workspace.ts`：会话操作和独立连接。
- `local/acp/bridge.ts`、`local/acp/launch.ts`：固定 Agent 入口、stdio 转发、启动配置和进程清理；`local/runtime.ts` 负责登录及项目授权。
- `local/vite-plugin.ts`：装配本地 HTTP 路由与 ACP 转接。完整目录见 [004 · 代码分层](004_code_structure.md)。

本地入口仅监听 `127.0.0.1`，校验 Host / Origin，不接受页面指定任意命令。工作目录绑定已登记的项目；WebSocket 升级还校验登录及会话归属。适配器 stderr 留在启动终端；stdout 仅用于 ACP。断开后停止适配器及其进程组。此入口只用于本机交互，不用于公网托管。

进程组回收针对 macOS / Linux；Windows 下仅直接终止适配器，不提供完整子进程树回收保证。默认初始模式由转接层显式固定为只读；不继承环境中的 `INITIAL_AGENT_MODE`。不要使用 `--host 0.0.0.0` 对外开放此开发入口。

## 运行与验证

项目需要 Node.js 24.9.0+ 和 npm。首次执行 `npm install`，然后 `npm run dev`，打开终端显示的本地地址。先绑定或使用本地 Passkey 登录，再选择 Codex，在项目旁新建会话；按需通过会话配置完成 Agent 认证，再发送消息。也可先在本地完成 Codex 登录，再建立会话。适配器依赖及其兼容 Codex 随 npm 安装，版本以 lockfile 为准；可通过启动进程的 `CODEX_PATH` 显式使用已有 Codex。

`npm run check` 做类型检查，`npm test` 验证协议交互与异常路径，`npm run build` 构建页面，`npm run preview` 运行带本地转接的构建预览。单独托管 `dist/` 无法启动本地 Codex。

真实验收需要已认证的 Codex：文本增量回复、工具审批选择、取消后最终 stopReason、中途断开与再次连接。模拟代理测试不能证明真实模型调用成功；执行结果统一记录在 [CHANGELOG.md](../CHANGELOG.md)。

## 一手资料

- [ACP v1 协议](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Codex ACP 适配器与认证配置](https://github.com/agentclientprotocol/codex-acp)

本文只实现上述交互，不绑定适配器的 AIR 私有扩展或 ACP v2 预览。
