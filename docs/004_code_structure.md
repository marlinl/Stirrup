# 004 · 代码分层与 Review 导航

本篇定义 Node.js 服务项目的目录结构、模块边界与 Review 路径。协议约定仍由 [001 · Codex](001_codex_acp.md) 和 [002 · DSH](002_dsh_acp.md) 负责，页面与登录行为由 [003 · Web](003_web_app_design.md) 负责。

本文定义 SQLite 与三栏设置的模块结构。[005 · SQLite 存储](005_sqlite_storage_design.md) 负责业务数据表；迁移规则见 [Spec 001](specs/001_database_migration.md)，独立 SQL 模块实现见 [Design 001](designs/001_database_migration.md)，[006 · 设置页面](006_settings_page_design.md) 负责设置操作。

## 目录与职责

服务端源码统一位于 `src/`，浏览器端源码统一位于 `web/`。服务进程监听端口，并统一提供前端资源、HTTP API 和 ACP WebSocket。前端使用浏览器端渲染；Vite 负责前端开发与构建。

```text
web/
├── index.html               # 浏览器 HTML 外壳
├── main.ts                  # 唯一浏览器入口：加载样式、启动 Application
├── app/
│   ├── application.ts       # 启动、登录/工作台切换、登出与销毁
│   ├── routes.ts            # /login、/chat、/settings/*，URL 读写
│   └── preferences.ts       # 主题、栏宽、选择偏好的读取与保存
├── api/client.ts            # 同源 JSON 请求、错误及 401 通知
├── auth/passkey.ts          # 浏览器 WebAuthn 调用，不包含页面模板
├── domain/
│   └── workspace.ts         # 会话操作、独立 ACP 连接、输出合并与串行保存
├── acp/
│   ├── agents.ts            # Codex / DSH / Antigravity 固定能力描述与入口
│   ├── client.ts            # ACP 协议状态机、轮次、审批与恢复
│   └── websocket.ts         # WebSocket 与 NDJSON 字节流转换
└── ui/
    ├── pages/               # 登录页、工作台协调、共享三栏和设置页面
    ├── components/          # 项目列表、消息、审批、输入/会话配置控件、拖动分隔线
    ├── dialogs/             # 弹层宿主、添加项目等短操作
    ├── settings/            # 外观、Agent、账号/退出确认、存储内容
    ├── assets/              # 官方来源图标及来源说明
    ├── styles/              # 主题、基础控件、登录、工作台、对话、输入框、弹层、适配
    ├── view-state.ts        # 各会话滚动位置、跟随与展开状态，仅归界面所有
    ├── status.ts            # 连接状态到界面文案的映射
    ├── markdown.ts          # Markdown 清理与渲染
    ├── icons.ts             # 静态 SVG 图标
    ├── layout.ts            # 栏宽边界计算
    └── dom.ts               # DOM 查找、提示与事件错误处理

migration/                  # 仅存放有序 SQL，每个 up 配套同版本 .down.sql
├── 001_workspace.sql       # 初始工作区结构
├── 002_agents.sql          # Agent 约束升级
└── 003_personal_settings.sql # 个人设置结构

src/                       # Node.js 服务端源码
├── main.ts                  # CLI 参数与信号处理
├── server.ts                # Node HTTP 监听、API/ACP 与开发/构建资源装配及关闭
├── config/
│   ├── env.ts               # 根目录 .env 读取，不注入进程环境
│   ├── startup.ts           # 监听配置与启动校验
│   └── site.ts              # 外部站点 Origin 与 RP ID
├── runtime.ts               # 组装服务，校验 ACP 连接的会话和项目归属
├── http/
│   ├── routes.ts            # HTTP 路由、鉴权边界、请求到业务操作的分发
│   ├── request.ts           # JSON body/response、Host/Origin、Cookie 解析
│   └── static.ts            # 前端构建产物托管与页面路由回退
├── auth/
│   ├── passkey-auth.ts      # WebAuthn 挑战、验签与首次绑定验证
│   ├── passkey-store.ts     # 凭证类型、认证错误与身份摘要
│   └── sessions.ts          # 登录 Session、Cookie、个人有效期、过期回收
├── sql/
│   ├── migration.ts         # check/up/down 公共入口
│   ├── files.ts             # 文件发现、连续版本验证与内容快照
│   ├── sqlite.ts            # 迁移连接、索引检查、事务与 SQL 授权
│   └── lock.ts              # 数据库路径级迁移独占锁
├── storage/
│   ├── prepare.ts           # 调用 migration.up，再执行业务初始化
│   ├── legacy-json.ts       # 离线 JSON 导入、备份、核验与导出
│   ├── cli.ts               # storage:migrate / storage:export
│   ├── database.ts          # SQLite 连接、PRAGMA、版本验证、事务与关闭
│   ├── personal-settings-store.ts # 单用户凭证与个人配置
│   ├── workspace-store.ts  # 项目与会话 SQL 映射、版本冲突、统计
│   └── records.ts          # 消息字段校验
├── acp/
│   ├── launch.ts            # 固定 Agent 启动命令与环境
│   └── bridge.ts            # WebSocket ↔ stdio、子进程生命周期
├── errors.ts               # 可安全返回给页面的本地操作错误
└── validation.ts           # 持久化字段的基本校验

shared/                     # 无 Node.js / DOM 依赖的跨端数据契约
├── models.ts               # API 数据类型
└── agents.ts               # Agent 标识与协议入口等共享常量

dist/                       # 被忽略的构建产物
├── server/                 # Node.js 服务代码
└── web/                    # HTML、浏览器脚本、样式与静态素材
```

`app.css` 仅负责按原顺序引入各样式文件，避免拆分改变 CSS 覆盖关系。页面模板位于 `web/ui/`；入口、网络客户端、协议和存储模块不渲染页面。

## 依赖与状态归属

浏览器应用从 `web/main.ts` 启动 `web/app/application.ts`：先通过 API 判断登录状态，再挂载 `ui/pages/login.ts` 或工作台。路由文件只编码、读取 URL，不负责渲染或判断用户权限。

工作台页面只协调当前选择和组件事件。`domain/workspace.ts` 接收 API 客户端和变更通知，维护每个对话的 Agent 客户端、草稿、消息与保存队列，不访问 DOM。滚动位置、展开项和已渲染节点缓存分别由工作台视图与消息组件管理，不混入 ACP 或保存记录。

Node.js 入口 `src/main.ts` 负责服务启动与端口监听，通过 `src/runtime.ts` 装配认证和存储，再交给 `src/http/routes.ts` 分发 API。路由处理来源校验、登录边界和异步 body 后的再次鉴权；存储模块只接收已解析数据，负责字段验证、项目归属、原子保存和版本冲突，不读取 HTTP 请求或 Cookie。

ACP 字节转发位于 `src/acp/bridge.ts`，不处理登录或持久化。只有 `runtime.ts` 签发的连接授权才允许它启动相应项目中的固定 Agent。登录到期和登出继续通过授权中绑定的清理回调关闭连接。

## 服务运行契约

- `src/main.ts` 读取并校验 `.env` 中的监听配置与站点配置，准备并验证 SQLite，然后启动 HTTP 服务并注册 ACP 升级处理。
- `STIRRUP_HOST` / `STIRRUP_PORT` 控制实际监听地址和端口；`STIRRUP_SITE_URL` 控制浏览器外部站点的身份校验，二者分开，遵循 003。
- 开发时由 Node.js 服务装配前端开发能力；构建运行时托管 `dist/web/`。开发模块使用 `/web/` URL 前缀，避免与 `/api/*`、`/acp/*` 业务端点重名。API、ACP 和页面使用同一服务入口；静态资源与页面回退不得截获 API 或 ACP 请求，不得提供服务器源码、`.env` 或 `.local/`。
- 前端资源构建不启动数据库或 Agent。服务启动失败及正常退出都需清理已持有的连接与进程资源。
- `src/` 与 `web/` 通过 HTTP/WebSocket 契约交互，不互相导入平台实现；共用的类型、Agent 标识和协议常量放在 `shared/`。共享目录只保留实际跨端使用的数据契约。

## 推荐 Review 顺序

| 要 review 的功能 | 首先查看 | 继续跟进 |
| --- | --- | --- |
| App 启动参数 | `src/config/startup.ts`、`src/main.ts` | `.env.example`、`src/main.ts`、`src/config/site.ts`、003 |
| HTTP 接口与访问边界 | `src/http/routes.ts` | `http/request.ts`、`auth/sessions.ts` |
| Passkey 与有效期 | `src/auth/passkey-auth.ts` | `src/storage/personal-settings-store.ts`、`sessions.ts`、`src/config/site.ts` |
| 项目与对话保存 | `src/storage/workspace-store.ts` | `shared/models.ts`、`test/web.test.ts` |
| 登录页面及页面切换 | `web/app/application.ts` | `app/routes.ts`、`ui/pages/login.ts` |
| 三栏与交互 | `web/ui/pages/workspace.ts` | `workspace-shell.ts`、`ui/components/` |
| 对话输出和审批 | `web/domain/workspace.ts` | `ui/components/messages.ts`、`permissions.ts`、`web/acp/client.ts` |
| 三栏设置 | `web/ui/pages/settings.ts`、`web/ui/settings/` | `app/routes.ts`、`app/preferences.ts`、`src/http/routes.ts` |
| 会话配置 | `web/ui/components/session-options.ts`、`composer.ts` | `web/acp/client.ts`；控件约定见 [007](007_conversation_product_design.md) |
| 本地 Agent 进程 | `src/acp/launch.ts` | `bridge.ts`、`runtime.ts` |
| 样式 | `web/ui/styles/app.css` | 对应页面/组件样式文件 |

## 设置与存储边界

业务连接和业务查询位于 `src/storage/`；独立迁移执行器位于 `src/sql/`，不依赖业务模块。版本化 SQL 文件位于根目录 `migration/`，离线维护入口 `src/storage/cli.ts` 复用同一迁移接口；HTTP 路由只分发已鉴权操作。设置渲染位于 `web/ui/pages/settings.ts` 与 `web/ui/settings/`，由 `app/routes.ts` 管理 URL，复用工作台外壳；工作台状态跨对话/设置视图持续存在，设置主内容使用页面视图。会话配置的最终结构由 [007](007_conversation_product_design.md) 定义：常用控件放在输入框下方，由组件负责渲染、ACP 客户端负责协议交互。

## 验证边界

认证测试覆盖真实测试密钥验签、会话到期与连接关闭；存储测试覆盖事务、版本冲突和迁移/导出；页面测试覆盖登录生命周期、后台会话隔离和设置导航。构建与测试使用：

```sh
npm run build
npm test
```

自动测试不能替代原生 Passkey、浏览器视觉或真实模型操作验收。具体执行结果统一记录在 [CHANGELOG.md](../CHANGELOG.md)。

相关 Agent 接入契约：[008 · Antigravity](008_agy_acp.md)。
