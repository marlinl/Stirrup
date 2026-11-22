# 005 · SQLite 本地数据存储设计

## 范围与存储契约

`WorkspaceStore` 使用 `.local/web/stirrup.sqlite` 保存应用数据。旧 `.local/web/projects.json` 和 `conversations/<id>.json` 仅作为迁移源保留，不双写。离线迁移与回退导出由 CLI 执行，数据库连接和事务由独立存储模块负责。

本篇负责表结构、读写契约、旧数据迁移与恢复；[003 · Web](003_web_app_design.md) 负责既有产品行为，[004 · 代码分层](004_code_structure.md) 负责模块边界，[006 · 设置页面](006_settings_page_design.md) 负责向用户展示存储状态。范围是单用户、本机、单个 Web 实例，不增加独立数据库服务。

## 数据归属

| 数据 | 存储来源 | 约定 |
| --- | --- | --- |
| 项目 ID、名称、绝对目录与列表顺序 | SQLite `projects` | 保留原 ID、路径和顺序 |
| 对话 ID、项目/Agent 归属、标题、草稿、更新时间、revision | SQLite `conversations` | 保留原值和乐观并发语义 |
| `providerSessionId` | SQLite `conversations` | 仅保存 Agent 上下文的引用，不复制 Agent 内部记录 |
| 消息、思考、计划、工具及其他 ACP 展示记录 | SQLite `messages` | 每条展示消息一行，保留原数组顺序和消息 ID |
| Passkey 公钥、凭证、用户标识、登录有效期 | 原 `.env` | 仍由认证模块读取，不建账号表、不导入数据库 |
| 登录 Session、WebAuthn 挑战、活动连接、待处理审批 | 原进程/浏览器内存 | 不落库，不在重启后重放审批 |
| 短时绑定授权散列 | 原 `.local/web/passkey-enrollment.json` | 维持独立认证生命周期，不作为聊天数据迁移 |
| 主题、减少效果、栏宽、最近选择 | 浏览器 `localStorage` | 属于当前浏览器偏好，006 延续此约定 |
| 滚动位置、展开项、连接状态 | 当前工作台视图内存 | 不制造持久化的“已连接”状态 |
| Codex / DSH 自身的上下文、认证与会话文件 | 各 Agent 自己的存储 | DSH 默认仍为 `.local/dsh/`；不从其内部文件导入历史 |

保存页面历史不代表支持 Agent 上下文恢复。继续对话仍使用对应项目与 Agent 的 `providerSessionId`，并检查 load / resume 能力。

## 文件、驱动与连接

数据库固定放在本项目 `.local/web/stirrup.sqlite`，不放到被操作的各个项目目录。目录权限为 0700，数据库及运行产生的辅助文件限制为当前用户可读写，继续由 Git 忽略和 Web 文件访问规则保护。

采用 Node 内置 `node:sqlite` 的 `DatabaseSync` 接口，将连接和参数化语句集中在存储层，不引入 ORM。数据库调用是同步的，应保持事务短小，事务内不等待网络、ACP、用户审批或异步文件操作。[Node SQLite 文档](https://nodejs.org/api/sqlite.html)

最低运行版本为 Node 24.9.0；数据库连接依赖 `DatabaseSync`、SQLite STRICT 表和 JSON 函数。启动时检查必要能力与结构版本，无法满足时拒绝启动。

每个 Web 实例持有一个存储连接；打开后、事务外执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 1000;
```

必须检查配置结果及 JSON 能力，失败时拒绝以“空数据”继续启动。显式开启外键，不能依赖驱动默认值。[SQLite 外键说明](https://sqlite.org/foreignkeys.html)

WAL 仍然只有一个同时写入者，可能产生 `stirrup.sqlite-wal`、`stirrup.sqlite-shm`；数据库仅用于本机文件系统。设置页面与备份流程不能把辅助文件当作可随意删除的缓存。[SQLite WAL 说明](https://sqlite.org/wal.html)

## 表结构 v1

固定检索字段使用普通列；可变消息内容使用 JSON 文本。不使用 JSONB，便于检查、导出与复用当前 TypeScript 结构。SQLite 提供 `json_valid()`、`json_extract()` 等函数，可对 `TEXT` 中的 JSON 校验和查询；JSONB 是另一种二进制表示，不是本方案的前提。[SQLite JSON 文档](https://sqlite.org/json1.html)

以下是 v1 建表 SQL，代码唯一来源为 `local/storage/schema.sql`；版本登记与业务数据迁移必须在同一初始化事务提交。

```sql
CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at    INTEGER NOT NULL,
  legacy_digest TEXT
) STRICT;

CREATE TABLE projects (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  cwd        TEXT NOT NULL UNIQUE,
  position   INTEGER NOT NULL UNIQUE CHECK (position >= 0)
) STRICT;

CREATE TABLE conversations (
  id                  TEXT PRIMARY KEY NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id            TEXT NOT NULL CHECK (agent_id IN ('codex', 'dsh')),
  title               TEXT NOT NULL,
  provider_session_id TEXT,
  draft               TEXT NOT NULL DEFAULT '',
  updated_at          INTEGER NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
) STRICT;

CREATE INDEX conversations_project_agent_updated
  ON conversations(project_id, agent_id, updated_at DESC, id);

CREATE TABLE messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  kind            TEXT NOT NULL CHECK (
    kind IN ('user', 'assistant', 'thought', 'tool', 'plan', 'notice', 'error', 'event')
  ),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (json_type(payload_json) = 'object'
         AND json_type(payload_json, '$.text') IS 'text'),
  PRIMARY KEY (conversation_id, id),
  UNIQUE (conversation_id, ordinal)
) STRICT;
```

字段映射与约束：

- `projects.position` 来自旧项目数组的下标，避免迁移后默认项目改变；新项目追加到末尾。
- `updated_at` 保留当前 JavaScript 毫秒时间戳，`revision` 保留原数字。迁移不刷新活动时间、不额外增加版本。
- 未创建 Agent 上下文时 `provider_session_id` 为 SQL NULL；返回 API 时还原为可选字段。它不承担应用会话主键或全局唯一标识的职责。
- `ordinal` 为某个会话中从 0 开始的消息顺序；读取必须 `ORDER BY ordinal ASC`，不能按 UUID 排序。原消息没有创建时间，迁移时不推造逐条时间戳。
- 消息主键限定在会话内，同一消息 ID 在不同会话出现不会相互覆盖；同一会话内重复 ID 属于迁移错误。
- `payload_json` 保存 `text` 及存在的 `title`、`toolCallId`、`status`、`details`，不再重复保存行上的 `id`、`kind`。例如 `{"text":"工具输出","title":"读取文件","status":"completed","details":{"toolCallId":"call-1"}}`。还原时组合行字段与 JSON 内容，保持现有 `Message` 契约。
- 可选字段缺失与空字符串必须区分；不将 `undefined` 转成字符串，也不在消息中额外存一份重复“原始事件全文”。现有 `details` 内容原样保留。
- JSON 校验只是数据库兜底；已有消息种类、字段长度、8 MiB 请求体、5000 条消息等应用校验仍保留。数据库错误不能替代输入验证。

不提供项目或会话删除入口。外键规则用于保证一致性，不代表产品已经提供删除功能。

## 读写与事务

### 兼容现有调用方

继续由 `WorkspaceStore` 提供 `projects`、`list()`、`conversation(id)`、`addProject(input)`、`createConversation(input)`、`saveConversation(id, input)`；对调用方保持同样的对象结构、状态码和字段语义。提供 `close()` 用于运行入口释放连接。

`GET /api/workspace`、`POST /api/projects`、`POST /api/conversations`、`PUT /api/conversations/:id` 保持兼容。消息虽然分行保存，当前 HTTP 接口仍返回完整历史并接收完整快照；分页加载和增量保存协议不在此次切换中同时引入。

查询使用绑定参数，禁止把项目路径、标题、消息或 ID 拼接成 SQL。列表按 `projects.position` 及对话更新时间稳定读取，消息按 `ordinal` 重建数组。读取失败应返回明确错误，不能吞掉损坏记录后呈现为空工作区。

### 保存一次会话快照

浏览器继续每约 500ms 合并流式变化，同一会话的保存排队串行执行；轮次完成和主动退出时 flush。存储层执行：

1. 在开始事务前校验输入，并生成消息 JSON，避免在锁内做无关计算。
2. `BEGIN IMMEDIATE`；读取会话，确认存在。
3. 用 `WHERE id = ? AND revision = ?` 更新允许修改的字段、`updated_at` 和 `revision + 1`；不得更新 `project_id`、`agent_id`。未提供 `providerSessionId` 时保留原值。
4. 更新行数不是 1，回滚并返回 409；会话不存在仍返回 404。
5. 删除该会话旧消息行，按输入数组顺序插入本次全部消息。
6. `COMMIT` 后才返回新 `revision` 与 `updatedAt`。任何一步失败都回滚，旧快照仍完整。

采用“事务内替换整组消息”以保持现有快照语义，避免顺序调整与部分工具更新引入另一套合并协议。这会有全量写放大，不能宣称使用 SQLite 就已经变成逐消息增量保存；现有请求上限与合并节流继续约束它。应用状态不得在提交成功前提前增加版本。

超出忙等待窗口的锁冲突返回可重试的 503；版本冲突返回 409，不能自动覆盖另一窗口。I/O、磁盘满或事务异常保留用户草稿和未保存状态，禁止用新空库替代损坏库。SQLite 提交不消除浏览器关闭前尚未发送数据的丢失窗口。

## 旧 JSON 数据迁移

### 入口与预检

执行 `npm run storage:migrate`。首次有旧 JSON 时采用显式离线迁移；不在浏览器打开页面时悄悄导入。运行服务与迁移命令共用存储目录独占锁，冲突时拒绝执行；崩溃遗留锁须核实原进程已结束后再清理。

迁移前停止 dev / preview 并关闭活动 ACP 会话。命令只读扫描旧文件，生成有序文件清单与 SHA-256 摘要，校验：

- 项目 ID、对话 ID、文件名内 ID 一致；项目路径及 ID 不重复。
- 每条对话的项目存在、Agent 是已支持的值、字段类型和消息内容有效。
- 每个会话内消息 ID 唯一，序号可以由原数组无损生成。
- 不因当前工作目录暂时离线而丢弃旧项目；旧路径原样保留，后续连接时报告不可访问。新添加项目仍执行目录存在检查。

遇到损坏 JSON、未知字段、未知 Agent、悬空引用、重复 ID 或不兼容类型时停止，报告文件和字段，不输出消息正文。未知字段必须先确定保留映射，不能静默丢弃后宣称无损迁移。

### 建库与切换

1. 保留原文件，并把本次源清单、摘要和源文件复制到 `.local/web/backups/json-<时间戳>/`；仅含项目和对话，不复制凭据文件。
2. 在同目录新建临时候选数据库，执行建表及全部导入；项目、对话、消息、`schema_migrations` v1 标记一次事务提交。`legacy_digest` 记录源清单摘要。
3. 验证项目/会话/逐会话消息数量、原 ID、顺序、内容、草稿、时间和版本；执行 `PRAGMA foreign_key_check` 与 `PRAGMA integrity_check`。比较使用解析后的结构，不要求 JSON 空格或对象键顺序相同。
4. 复核源清单未改变，完成 checkpoint，关闭候选连接；没有未合并 WAL 数据时才原子发布为 `stirrup.sqlite`。实现采用同文件系统硬链接发布后移除临时候选名称，确保目标存在时失败，避免普通 rename 覆盖已有文件。
5. 下次启动只使用已验证数据库，旧 JSON 保留为历史源，不再读写、不做双写。

重复运行：已有完成标记且源摘要相同则报告“已迁移”，不重复导入；目标存在而标记不完整、来源不同或结构版本未知时拒绝覆盖。中断留下的临时候选库不能被服务自动选中，应清理/重建候选后重试。

没有旧项目/对话、也没有数据库的全新安装，可以直接创建 v1 空库及默认项目。已有 JSON 而没有数据库时提示先迁移；已有有效数据库时只以数据库为准。禁止创建空库遮住待迁移历史。

## 备份、回滚与关闭

首次切换前的回滚：停止服务，保留候选库和迁移报告用于排查，恢复 JSON 存储版本并使用完整旧源文件。只有确认 SQLite 中没有新写入时，旧 JSON 才是完整的回退点。

切换后已有新对话/消息时，旧 JSON 已过时，不能直接回到旧版本宣称“已恢复”。需先停止写入，将当前数据库全量导出为旧格式，验证数量和内容，再整体替换旧项目索引和对话文件，不覆盖认证文件；运行 `npm run storage:export` 会创建经过往返校验的 `.local/web/backups/export-*/`；它不自动覆盖旧文件。恢复旧 JSON 存储代码后，仅将导出的 `projects.json` 和完整 `conversations/` 目录作为旧版数据源，保留现有认证文件。

常规备份使用 SQLite 一致性备份能力，或在关闭所有连接并完成 checkpoint 后复制主文件。运行中只复制主 `.sqlite` 文件可能遗漏 WAL 中的已提交内容；不能删除 `-wal` 强行“修复”。[SQLite WAL 文件说明](https://sqlite.org/wal.html#the_wal_file)

备份和导出只进入项目自己的 `.local/`，权限与原数据一致；不在设置页新增公开下载或数据库文件直出入口。关闭时先停止新业务写入，完成正在执行的事务，再关闭连接。

## 模块落点与验收

沿用 004 的边界：

| 模块 | 当前职责 |
| --- | --- |
| `local/storage/database.ts` | 打开连接、配置 PRAGMA、版本检查、短事务与关闭 |
| `local/storage/schema.sql` | 唯一的 v1 建表 SQL |
| `local/storage/workspace-store.ts` | 使用 SQL 映射，保留调用契约 |
| `local/storage/legacy-json.ts` | 仅供离线导入/回退使用的旧格式校验与转换 |
| `local/cli/migrate-storage.ts` | 预检、备份、导入、导出、核验及明确结果 |
| `local/runtime.ts`、`local/vite-plugin.ts` | 生命周期与独占锁接入、关闭存储 |
| `local/http/routes.ts` | 延续鉴权和 DTO，不写 SQL、不接收数据库路径 |

故障验收要求：

1. 项目顺序、会话归属、消息顺序、可选字段、工具详情和草稿往返一致。
2. 同 revision 的两个保存只有一个成功；消息插入中途失败时，版本和旧消息一起回滚。
3. 锁冲突、磁盘错误与非法 JSON 不返回成功、不清空数据库。
4. 迁移保留原 ID、`providerSessionId`、`updatedAt`、revision；损坏记录导致整体失败；重复执行不产生副本。
5. 迁移中断可重试，目标数据库不被覆盖；切换后的新增记录可通过离线导出完整回退。
6. 登录/Origin/ACP 项目绑定检查不弱化；数据库、WAL、SHM 和备份均不能通过 HTTP 静态路径读取。
7. 重启后能读到已提交历史；不自动恢复内存 Session、不批准旧权限请求。

迁移执行、实际数据核验及测试结果统一记录在 [CHANGELOG.md](../CHANGELOG.md)。
