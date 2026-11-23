# 004 · 代码分层与 Review 导航

本篇说明当前代码位置与模块边界，便于按功能 review。协议约定仍由 [001 · Codex](001_codex_acp.md) 和 [002 · DSH](002_dsh_acp.md) 负责，页面与登录行为由 [003 · Web](003_web_app_design.md) 负责。

本文定义 SQLite 与三栏设置的模块结构。[005 · SQLite 存储](005_sqlite_storage_design.md) 负责数据表与迁移，[006 · 设置页面](006_settings_page_design.md) 负责设置操作。

## 目录与职责

```text
src/
├── main.ts                  # 唯一浏览器入口：加载样式、启动 Application
├── app/
│   ├── application.ts       # 启动、登录/工作台切换、登出与销毁
│   ├── routes.ts            # /login、/chat、/settings/*，URL 读写与 localhost 归一化
│   └── preferences.ts       # 主题、栏宽、选择偏好的读取与保存
├── api/client.ts            # 同源 JSON 请求、错误及 401 通知
├── auth/passkey.ts          # 浏览器 WebAuthn 调用，不包含页面模板
├── domain/
│   ├── models.ts            # 项目、对话、消息、登录状态的数据契约
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

local/
├── vite-plugin.ts           # Vite dev / preview 的装配入口
├── runtime.ts               # 组装服务，校验 ACP 连接的会话和项目归属
├── http/
│   ├── routes.ts            # HTTP 路由、鉴权边界、请求到业务操作的分发
│   └── request.ts           # JSON body/response、Host/Origin、Cookie 解析
├── auth/
│   ├── passkey-auth.ts      # WebAuthn 挑战、验签与首次绑定验证
│   ├── passkey-store.ts     # .env 凭证读写及本机绑定授权
│   └── sessions.ts          # 登录 Session、Cookie、.env 有效期、过期回收
├── storage/
│   ├── database.ts          # SQLite 连接、PRAGMA、事务、目录锁与关闭
│   ├── schema.sql           # v2 表结构
│   ├── workspace-store.ts  # 项目与会话 SQL 映射、版本冲突、统计
│   ├── records.ts          # 消息字段校验
│   └── legacy-json.ts      # 离线 JSON 迁移、备份、核验与导出
├── acp/
│   ├── launch.ts            # 固定 Agent 启动命令与环境
│   └── bridge.ts            # WebSocket ↔ stdio、子进程生命周期
├── cli/
│   ├── setup-passkey.ts     # npm run passkey:setup
│   └── migrate-storage.ts  # npm run storage:migrate / storage:export
├── errors.ts               # 可安全返回给页面的本地操作错误
└── validation.ts           # 持久化字段的基本校验
```

`app.css` 仅负责按原顺序引入各样式文件，避免拆分改变 CSS 覆盖关系。所有 HTML 模板位于 `ui/`；入口、网络客户端、协议和存储模块不渲染页面。

## 依赖与状态归属

浏览器应用从 `app/application.ts` 进入：先通过 API 判断登录状态，再挂载 `ui/pages/login.ts` 或工作台。路由文件只编码、读取 URL，不负责渲染或判断用户权限。

工作台页面只协调当前选择和组件事件。`domain/workspace.ts` 接收 API 客户端和变更通知，维护每个对话的 Agent 客户端、草稿、消息与保存队列，不访问 DOM。滚动位置、展开项和已渲染节点缓存分别由工作台视图与消息组件管理，不混入 ACP 或保存记录。

本地入口通过 `runtime.ts` 装配认证和存储，再交给 `http/routes.ts` 分发。路由处理来源校验、登录边界和异步 body 后的再次鉴权；存储模块只接收已解析数据，负责字段验证、项目归属、原子保存和版本冲突，不读取 HTTP 请求或 Cookie。

ACP 字节转发位于 `local/acp/bridge.ts`，不处理登录或持久化。只有 `runtime.ts` 签发的连接授权才允许它启动相应项目中的固定 Agent。登录到期和登出继续通过授权中绑定的清理回调关闭连接。

## 推荐 Review 顺序

| 要 review 的功能 | 首先查看 | 继续跟进 |
| --- | --- | --- |
| HTTP 接口与访问边界 | `local/http/routes.ts` | `http/request.ts`、`auth/sessions.ts` |
| Passkey 与有效期 | `local/auth/passkey-auth.ts` | `passkey-store.ts`、`sessions.ts`、`.env.example` |
| 项目与对话保存 | `local/storage/workspace-store.ts` | `src/domain/models.ts`、`test/web.test.ts` |
| 登录页面及页面切换 | `src/app/application.ts` | `app/routes.ts`、`ui/pages/login.ts` |
| 三栏与交互 | `src/ui/pages/workspace.ts` | `workspace-shell.ts`、`ui/components/` |
| 对话输出和审批 | `src/domain/workspace.ts` | `ui/components/messages.ts`、`permissions.ts`、`src/acp/client.ts` |
| 三栏设置 | `src/ui/pages/settings.ts`、`src/ui/settings/` | `app/routes.ts`、`app/preferences.ts`、`local/http/routes.ts` |
| 会话配置 | `src/ui/components/session-options.ts`、`composer.ts` | `src/acp/client.ts`；控件约定见 [007](007_conversation_product_design.md) |
| 本地 Agent 进程 | `local/acp/launch.ts` | `bridge.ts`、`runtime.ts` |
| 样式 | `src/ui/styles/app.css` | 对应页面/组件样式文件 |

## 设置与存储边界

连接和 SQL 留在 `local/storage/`，离线迁移放在 `local/cli/`，HTTP 路由只分发已鉴权操作。设置渲染位于 `src/ui/pages/settings.ts` 与 `src/ui/settings/`，由 `app/routes.ts` 管理 URL，复用工作台外壳；工作台状态跨对话/设置视图持续存在，设置主内容使用页面视图。会话配置的最终结构由 [007](007_conversation_product_design.md) 定义：常用控件放在输入框下方，由组件负责渲染、ACP 客户端负责协议交互。

## 验证边界

认证测试覆盖真实测试密钥验签、会话到期与连接关闭；存储测试覆盖事务、版本冲突和迁移/导出；页面测试覆盖登录生命周期、后台会话隔离和设置导航。构建与测试使用：

```sh
npm run build
npm test
```

自动测试不能替代原生 Passkey、浏览器视觉或真实模型操作验收。具体执行结果统一记录在 [CHANGELOG.md](../CHANGELOG.md)。

相关 Agent 接入契约：[008 · Antigravity](008_agy_acp.md)。
