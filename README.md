# Stirrup

在本地网页中操作 Codex、DSH（DeepSeek Harness）和 Antigravity CLI的 ACP 会话，使用 npm、TypeScript 和 Vite。

## 启动与使用

需要 **Node.js 24.9.0+**。

```sh
npm install
npm run dev
```

默认打开 **`http://localhost:5173/`**。在根目录 `.env` 中用 `STIRRUP_HOST`（默认 `127.0.0.1`，支持 IP / 主机名，如 `0.0.0.0`、`::`）和 `STIRRUP_PORT`（默认 `5173`）配置监听，修改后重启。dev 与 preview 共用这些参数，端口占用时启动失败，不自动递增。完整环境参数和优先级见 [003](docs/003_web_app_design.md#app-环境参数与启动约束)。这是纯单用户 **Passkey 登录**，没有用户名输入或密码登录。

需要通过 Nginx 访问时，在 `.env` 配置浏览器实际地址，例如 `STIRRUP_SITE_URL=https://chat.example.com`；内部 Node.js 仍可使用 HTTP。Nginx 保留外部 Host 与 Origin，并转发 ACP WebSocket，详见 [003 的站点身份约定](docs/003_web_app_design.md#站点身份与-nginx)。

首次访问时，个人设置表没有记录，登录页直接显示「创建 Passkey」。完成系统认证器验证后初始化个人记录，再使用 Passkey 登录。已有记录时不开放注册。旧 `.env` 账号、公钥与浏览器外观设置不导入；私钥始终留在认证器中。

登录后进入三栏工作台：

1. 左侧图标切换 Codex / DSH / Antigravity，底部齿轮打开设置。
2. 中间按项目列出对话。默认包含本项目，可添加本地绝对目录；点击项目旁的 `+` 创建并连接会话。会话栏默认占 20%，拖动分隔线最多到 50%；支持方向键、Home / End 和双击恢复。窄屏使用抽屉。
3. 右侧发送消息、阅读 Markdown 与 ACP 工具/计划/思考输出、处理审批或停止当前轮次。模型、Effort、Fast mode 与操作模式位于输入框下方；仅可选择 Agent 实际提供的选项，不支持的能力显示“Agent 未提供”。交互约定见 007。

切换 Agent 或对话不会断开后台连接，各会话独立保存消息和草稿。刷新后可以查看历史；点击“继续会话”会按代理公布的 load / resume 能力尝试恢复。不支持恢复时请在同一项目新建对话，不会自动重发旧消息。

设置沿用同一三栏工作台：左侧图标导航、中间设置分类、右侧设置内容。支持外观、Agent 状态、个人名称/登录有效期和存储信息，以及内联确认退出。切换设置保留后台输出与审批；退出会关闭当前登录下的代理连接。具体操作见 006。Codex / DSH 使用官方来源图标，来源见 [图标说明](src/ui/assets/README.md)。

## 从旧 JSON 版本升级

停止 `npm run dev` / `npm run preview` 后执行：

```sh
npm run storage:migrate
npm run dev
```

迁移会备份旧文件到 `.local/web/backups/json-*/`，验证后切换 SQLite；原 JSON 保留但不再写入。全新安装直接建库，无需迁移。运行实例与离线命令共用目录锁，不能同时操作同一存储目录。

如需回退格式，在停止服务后运行 `npm run storage:export`；它生成经过验证的 `backups/export-*/`，不会覆盖正在使用的数据或凭据。恢复旧 JSON 代码版本时只替换项目索引和对话文件，具体步骤见 005。

已有 SQLite v1/v2 数据库会在持有目录锁时自动执行 migration 升级至 v3，保留原会话和消息。升级前应停止服务并备份 `.local/web/`；旧版代码不能直接打开升级后的数据库，恢复方法见 005。

## Agent 凭据

- **Codex**：适配器及兼容 Codex 已包含在依赖中；使用本地已有登录，或启动环境中的 `CODEX_API_KEY` / `OPENAI_API_KEY`。初始为只读模式，可在输入框下方选择代理提供的操作模式。
- **DSH**：使用官方 `dsh --profile acp`。启动环境可提供 `DEEPSEEK_API_KEY`；默认数据在本项目 `.local/dsh/`，设置 `DSH_HOME` 可使用已有 DSH 配置。模型、推理和工具权限遵循 DSH 实际能力与本地策略。

- **Antigravity（AGY）**：本机安装支持 `agy acp` 的官方 CLI，先运行 `agy` 或 `agy acp --login` 认证；可通过启动环境 `AGY_PATH` 指定可执行文件。见 [008](docs/008_agy_acp.md)。AGY CLI 不随 npm 自动安装。

Stirrup 登录和 Agent 模型认证是两个独立步骤。不要将模型密钥输入页面、写入源码或放进 `VITE_*` 变量；修改启动环境后需重启服务。

## 本地数据与验证

根目录 **`.env`** 只管理 App 启动配置（模板见 [.env.example](.env.example)）：

| 变量 | 内容 |
| --- | --- |
| `STIRRUP_HOST` | dev/preview 监听地址，默认 `127.0.0.1`，支持 IP / 主机名及通配监听 |
| `STIRRUP_PORT` | 监听端口，默认 `5173`，范围 1–65535；占用时启动失败 |
| `STIRRUP_SITE_URL` | 浏览器访问的外部站点来源，例如 `https://chat.example.com`；省略时用 `http://localhost:<实际端口>` |

**`.local/web/stirrup.sqlite`** 保存项目、对话、消息、草稿，以及独立的 **`personal_settings`** 表。个人表保存 Passkey 用户和公钥凭证、RP ID、显示名称、登录有效期与外观配置；默认有效期 12 小时。设置页保存名称和有效期，下一次登录使用新有效期，已有会话不延长。浏览器只缓存最近 Agent / 会话选择。

SQL 结构唯一维护在 [local/storage/migrations/](local/storage/migrations/)，按编号执行，设计与恢复契约见 [005](docs/005_sqlite_storage_design.md)。`.env` 与 `.local/` 均被 Git 忽略并禁止通过 Web 静态路径读取。登录仍使用服务端内存 Session 与 HttpOnly Cookie，服务重启后重新登录。

旧 `.env` 账号和有效期项、旧绑定授权文件不再读取，也不会被自动删除。丢失 Passkey 没有密码恢复入口；数据库备份包含个人凭证和配置，聊天 JSON 导出不能代替完整备份。

```sh
npm run check
npm test
npm run build
npm run preview
```

`preview` 提供同样的登录和本地 ACP 转接。单独部署 `dist/` 静态文件无法连接本地代理。监听地址通过 `.env` 配置。

`npm run smoke:dsh` 检查真实 DSH 握手、建会话和配置；提供模型凭据后，`npm run smoke:dsh -- --prompt` 可追加一次短回复测试。

操作、变更和测试执行结果按时间追加到 [CHANGELOG.md](CHANGELOG.md)。协作约束见 [AGENTS.md](AGENTS.md)；`docs/` 仅维护当前最终设计：

- [001 · Codex ACP 对接](docs/001_codex_acp.md)
- [002 · DSH ACP 对接](docs/002_dsh_acp.md)
- [003 · Web 启动与页面设计](docs/003_web_app_design.md)
- [004 · 代码分层与 Review 导航](docs/004_code_structure.md)
- [005 · SQLite 本地数据存储设计](docs/005_sqlite_storage_design.md)
- [006 · 设置页面布局与操作设计](docs/006_settings_page_design.md)
- [007 · 对话消息与输入区产品设计](docs/007_conversation_product_design.md)
- [008 · Antigravity CLI ACP 对接](docs/008_agy_acp.md)

代码目录、职责边界与推荐 review 顺序见 004。HTTP 路由集中在 `local/http/routes.ts`；页面渲染位于 `src/ui/`，浏览器入口 `src/main.ts` 仅负责启动。
