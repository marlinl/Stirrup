# Stirrup

在本地网页中操作 Codex、DSH（DeepSeek Harness）和 Antigravity CLI的 ACP 会话，使用 npm、TypeScript 和 Vite。

## 启动与使用

需要 **Node.js 24.9.0+**。

```sh
npm install
npm run dev
```

打开 **`http://localhost:5173/`**（端口被占用时以终端为准）。这是纯单用户 **Passkey 登录**，没有用户名输入、密码登录或网页注册账号。

首次绑定，在本项目的另一个终端运行：

```sh
npm run passkey:setup
# 如果 dev 使用了其他端口，例如 5174：
# npm run passkey:setup -- 5174
```

打开命令生成的短时绑定链接，点击「创建 Passkey」，由本人按系统提示完成 Touch ID、设备 PIN 或其他认证器验证。绑定后再点击「使用 Passkey 登录」。绑定链接仅在 10 分钟内有效，使用后失效；它本身不能登录。已绑定时，该命令拒绝覆盖现有 Passkey。

访问 `127.0.0.1` 会自动转到同端口的 `localhost`；Passkey 的 RP ID 固定为 `localhost`，请始终使用这个主机名。

登录后进入三栏工作台：

1. 左侧图标切换 Codex / DSH / Antigravity，底部齿轮打开设置。
2. 中间按项目列出对话。默认包含本项目，可添加本地绝对目录；点击项目旁的 `+` 创建并连接会话。会话栏默认占 20%，拖动分隔线最多到 50%；支持方向键、Home / End 和双击恢复。窄屏使用抽屉。
3. 右侧发送消息、阅读 Markdown 与 ACP 工具/计划/思考输出、处理审批或停止当前轮次。模型、Effort、Fast mode 与操作模式位于输入框下方；仅可选择 Agent 实际提供的选项，不支持的能力显示“Agent 未提供”。交互约定见 007。

切换 Agent 或对话不会断开后台连接，各会话独立保存消息和草稿。刷新后可以查看历史；点击“继续会话”会按代理公布的 load / resume 能力尝试恢复。不支持恢复时请在同一项目新建对话，不会自动重发旧消息。

设置沿用同一三栏工作台：左侧图标导航、中间设置分类、右侧设置内容。支持外观、Agent 状态、只读账号/登录有效期和存储信息，以及内联确认退出。切换设置保留后台输出与审批；退出会关闭当前登录下的代理连接。具体操作见 006。Codex / DSH 使用官方来源图标，来源见 [图标说明](src/ui/assets/README.md)。

## 从旧 JSON 版本升级

停止 `npm run dev` / `npm run preview` 后执行：

```sh
npm run storage:migrate
npm run dev
```

迁移会备份旧文件到 `.local/web/backups/json-*/`，验证后切换 SQLite；原 JSON 保留但不再写入。全新安装直接建库，无需迁移。运行实例与离线命令共用目录锁，不能同时操作同一存储目录。

如需回退格式，在停止服务后运行 `npm run storage:export`；它生成经过验证的 `backups/export-*/`，不会覆盖正在使用的数据或凭据。恢复旧 JSON 代码版本时只替换项目索引和对话文件，具体步骤见 005。

已有 SQLite v1 数据库会在持有目录锁时自动升级至 v2，保留原会话和消息。升级前应停止服务并备份 `.local/web/`；旧版代码不能直接打开升级后的数据库，恢复方法见 005。

## Agent 凭据

- **Codex**：适配器及兼容 Codex 已包含在依赖中；使用本地已有登录，或启动环境中的 `CODEX_API_KEY` / `OPENAI_API_KEY`。初始为只读模式，可在输入框下方选择代理提供的操作模式。
- **DSH**：使用官方 `dsh --profile acp`。启动环境可提供 `DEEPSEEK_API_KEY`；默认数据在本项目 `.local/dsh/`，设置 `DSH_HOME` 可使用已有 DSH 配置。模型、推理和工具权限遵循 DSH 实际能力与本地策略。

- **Antigravity（AGY）**：本机安装支持 `agy acp` 的官方 CLI，先运行 `agy` 或 `agy acp --login` 认证；可通过启动环境 `AGY_PATH` 指定可执行文件。见 [008](docs/008_agy_acp.md)。AGY CLI 不随 npm 自动安装。

Stirrup 登录和 Agent 模型认证是两个独立步骤。不要将模型密钥输入页面、写入源码或放进 `VITE_*` 变量；修改启动环境后需重启服务。

## 本地数据与验证

根目录 **`.env`** 是唯一的本地登录配置来源（模板见 [.env.example](.env.example)）：

| 变量 | 内容 |
| --- | --- |
| `STIRRUP_PASSKEY_USER_ID` | 自动生成的单用户随机标识 |
| `STIRRUP_PASSKEY_USER_NAME` | 认证器中的显示名称，默认为 `Stirrup`，页面无需输入 |
| `STIRRUP_PASSKEY_CREDENTIAL` | 验证绑定后自动写入的单行 JSON，含凭证 ID、COSE 公钥的 base64url、签名计数器及传输方式 |
| `STIRRUP_SESSION_TTL_SECONDS` | 登录有效期，单位秒；默认 `43200`（12 小时），范围 1–31536000 |

私钥留在认证器中，不写入 `.env`。认证代码只从本地 `.env` 读取以上配置，不接受请求中指定用户或 `process.env` 覆盖；写入保留其他环境配置，文件权限为 0600。公钥登记成功前不会创建登录会话。后续登录会更新签名计数器，因此 `.env` 需要可写。

项目、对话、消息和草稿保存在 **`.local/web/stirrup.sqlite`**，消息可变字段保存为 JSON 文本。数据库连接与事务位于 `local/storage/database.ts`，业务读写位于 `local/storage/workspace-store.ts`；表结构、迁移与回退见 005。`.local/web/` 还保留短时绑定授权的散列；`.local/dsh/` 保存 DSH 数据。`.env` 和 `.local/` 均被 Git 忽略并禁止通过 Vite 读取。旧 `.local/web/account.json` 不再参与认证。登录继续使用 HttpOnly Cookie；服务重启后需重新验证 Passkey，同一数据目录仅运行一个 Web 实例。

有效期在每次登录成功时从 `.env` 读取，同时用于 Cookie 和服务端会话。修改后无需重启，对下一次登录生效；已登录会话保留原到期时间，不随访问续期。未配置时使用 12 小时，空值或非法值会拒绝创建登录会话。

若 Passkey 丢失，需由有本机文件权限的本人备份 `.env`，清空 `STIRRUP_PASSKEY_CREDENTIAL` 后重新运行绑定命令。没有密码后门或远程找回入口。

```sh
npm run check
npm test
npm run build
npm run preview
```

`preview` 提供同样的登录和本地 ACP 转接。单独部署 `dist/` 静态文件无法连接本地代理。本项目仅监听回环地址，不用于公网托管。

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
