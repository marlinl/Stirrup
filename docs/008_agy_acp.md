# 008 · Antigravity CLI（AGY）ACP 对接

## 范围与入口

AGY 指 Google Antigravity CLI，固定 Agent ID 为 `agy`，页面显示 Antigravity。使用官方内置 `agy acp`，链路为页面 → `/acp/agy` → 本地 stdio 转接 → Antigravity CLI。认证、模型权限和历史上下文由 AGY 自身管理。

依据 [官方 ACP 入口](https://antigravity.google/docs/cli/acp/) 和 [编辑器接入说明](https://antigravity.google/docs/ide/extensions/acp/)。不使用第三方适配器，也不通过桌面 IDE、内部数据库轮询或 SSH 转发模拟 ACP。

## 安装与启动

按 [官方安装入口](https://antigravity.google/download) 安装支持 ACP 的 Antigravity CLI，在运行 Stirrup 的机器上检查：

```sh
agy acp --help
# 首次登录，可用交互式 agy，或使用官方 ACP 登录入口
agy acp --login
npm run dev
# 可执行文件不在 PATH 时
AGY_PATH="/absolute/path/to/agy" npm run dev
```

`AGY_PATH` 只表示一个可执行文件路径，参数固定为 `acp`，不执行 shell 文本。该变量来自启动进程环境，修改后需重启服务；登录 `.env` 不会自动加载它。CLI 版本由本机管理，不随 npm 安装或自动下载。只有 IDE 启动器而没有 `acp` 子命令时，须安装正确的 CLI。

认证使用 CLI 已有本地凭据。页面仅展示代理实际公布的认证方式，不接收密钥、登录令牌或浏览器会话。Stirrup 登录、ACP 握手、模型调用是三个独立的检查点。

## 协议与权限

使用共享 [001](001_codex_acp.md) ACP v1 客户端及 [003](003_web_app_design.md) 登录/项目授权。每个应用会话有独立连接和子进程；cwd 取已登记项目路径。两条 Google 入口与 Codex/DSH 使用相同 Host、Origin、登录和会话归属校验。

`modes`、`configOptions` 和恢复能力以实际握手及会话结果为准。模式、模型、推理配置使用代理原始 ID/value；不预设可用模型，不强制套用 Codex 的只读模式，也不添加自动批准参数。工具权限还受 Antigravity 本地策略影响，未出现审批并不保证只读。客户端不声明文件系统、终端、附件或私有扩展能力。

消息、工具、审批与取消沿用共享生命周期：一次仅一轮，取消后等待最终响应，断开时拒绝待决调用并清理进程组。历史可以阅读；只有代理公布 resume/load 时才尝试恢复，不自动重新发送历史。模型/推理设置按语义分类呈现，未知配置在更多选项展示。

## 验收与代码

入口配置位于 `src/acp/launch.ts`，协议注册位于 `shared/agents.ts`，浏览器能力描述位于 `web/acp/agents.ts`，持久化升级见 [005](005_sqlite_storage_design.md)。

```sh
npm run check
npm test
npm run build
npm run smoke:agy
# 已完成模型认证后，可追加一次真实短回复（会产生用量）
npm run smoke:agy -- --prompt
```

烟测使用独立回环端口和真实 CLI，不使用 Stirrup 登录；拒绝工具审批，可能创建 CLI 自身会话记录。真实验收包含握手、建会话、文本输出、配置变更、工具审批、取消和按公布能力恢复。CLI 缺失、退出或认证失败必须结束连接并允许手动重试，不能把握手成功当作模型可用。执行结果只写入 [CHANGELOG](../CHANGELOG.md)。
