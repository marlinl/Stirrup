# 005 · SQLite 本地数据存储设计

## 范围与存储契约

`WorkspaceStore` 使用 `.local/web/stirrup.sqlite` 保存应用数据。旧 `.local/web/projects.json` 和 `conversations/<id>.json` 仅作为迁移源保留，不双写。离线迁移与回退导出由 CLI 执行，数据库连接和事务由独立存储模块负责。

本篇负责表结构、读写契约、旧数据迁移与恢复；[003 · Web](003_web_app_design.md) 负责既有产品行为，[004 · 代码分层](004_code_structure.md) 负责模块边界，[006 · 设置页面](006_settings_page_design.md) 负责向用户展示存储状态。范围是单用户、单个 Web 实例，SQLite 文件位于运行服务的机器，不增加独立数据库服务。

## 数据归属

| 数据 | 存储来源 | 约定 |
| --- | --- | --- |
| 项目 ID、名称、绝对目录与列表顺序 | SQLite `projects` | 保留原 ID、路径和顺序 |
| 对话 ID、项目/Agent 归属、标题、草稿、更新时间、revision | SQLite `conversations` | 保留原值和乐观并发语义 |
| `providerSessionId` | SQLite `conversations` | 仅保存 Agent 上下文的引用，不复制 Agent 内部记录 |
| 消息、思考、计划、工具及其他 ACP 展示记录 | SQLite `messages` | 每条展示消息一行，保留原数组顺序和消息 ID |
| Passkey 公钥凭证、用户标识、RP ID、名称、登录有效期、外观偏好 | SQLite `personal_settings` | 独立单用户表；仅验证成功后创建，不读取或导入旧 `.env` 身份 |
| 登录 Session、WebAuthn 挑战、活动连接、待处理审批 | 原进程/浏览器内存 | 不落库，不在重启后重放审批 |
| 最近 Agent / 会话选择 | 浏览器 `localStorage` | 仅导航缓存，不保存个人凭证或消息 |
| 监听地址、端口、站点 URL | 根目录 `.env` | 运行配置，与个人设置分离，见 003 |
| 滚动位置、展开项、连接状态 | 当前工作台视图内存 | 不制造持久化的“已连接”状态 |
| Codex / DSH / Antigravity 自身的上下文、认证与会话文件 | 各 Agent 自己的存储 | DSH 默认仍为 `.local/dsh/`；不从其内部文件导入历史 |

保存页面历史不代表支持 Agent 上下文恢复。继续对话仍使用对应项目与 Agent 的 `providerSessionId`，并检查 load / resume 能力。

## 文件、驱动与连接

数据库固定放在本项目 `.local/web/stirrup.sqlite`，不放到被操作的各个项目目录。目录权限为 0700，数据库及运行产生的辅助文件限制为当前用户可读写，继续由 Git 忽略和 Web 文件访问规则保护。

采用 Node 内置 `node:sqlite` 的 `DatabaseSync` 接口，将连接和参数化语句集中在存储层，不引入 ORM。数据库调用是同步的，应保持事务短小，事务内不等待网络、ACP、用户审批或异步文件操作。[Node SQLite 文档](https://nodejs.org/api/sqlite.html)

最低运行版本为 Node 24.9.0；数据库连接依赖 `DatabaseSync`、SQLite STRICT 表和 JSON 函数。启动时检查必要能力与结构版本，无法满足时拒绝启动。

每个 Web 实例持有一个存储连接，聊天与个人设置共享连接。连接配置由 [database.ts](../local/storage/database.ts) 统一负责：开启外键，使用 WAL、FULL 同步级别和 1000ms 忙等待；配置在事务外完成。

必须检查配置结果及 JSON 能力，失败时拒绝以“空数据”继续启动。显式开启外键，不能依赖驱动默认值。[SQLite 外键说明](https://sqlite.org/foreignkeys.html)

WAL 仍然只有一个同时写入者，可能产生 `stirrup.sqlite-wal`、`stirrup.sqlite-shm`；数据库仅用于本机文件系统。设置页面与备份流程不能把辅助文件当作可随意删除的缓存。[SQLite WAL 说明](https://sqlite.org/wal.html)

## SQL migrations 与 schema

SQL 的唯一维护位置为 [migration/](../migration/)，文档不复制 SQL。全新建库与已有库升级执行同一套有序文件：

| 版本 | 文件 | 职责 |
| --- | --- | --- |
| 1 | [001_workspace.sql](../migration/001_workspace.sql) | 创建迁移记录、项目、会话、消息表及索引 |
| 2 | [002_agents.sql](../migration/002_agents.sql) | 重建会话 Agent 约束，支持 Codex / DSH / AGY |
| 3 | [003_personal_settings.sql](../migration/003_personal_settings.sql) | 创建个人设置独立表；不预插入账号 |

[migration/schema.ts](../migration/schema.ts) 的 `MIGRATIONS` 按顺序列出文件，应用要求的 `SCHEMA_VERSION` 与清单长度一致。新增 schema 变更时追加连续编号 SQL 和清单项，不修改已发布迁移的语义，不维护另一份全量 schema。应用的参数化业务查询留在各 store 内，不属于 migration。

`schema_migrations` 记录成功执行的版本、时间及原 JSON 导入摘要。运行前验证版本连续且受支持；版本有缺口、为空或高于当前代码时拒绝升级。全新库执行全部文件后写入默认项目，已有库仅执行未应用文件。DDL、版本登记和初始化记录在同一事务提交；失败全部回滚，重试不产生副本。

重建表时在事务外暂时关闭外键，提交前检查外键完整性，最终恢复外键。`npm run dev` / `npm run preview` 分别通过 `predev` / `prepreview` 在启动服务前执行 `npm run storage:prepare`，检查并执行待应用的 schema migration。迁移工具之间使用短期目录锁，准备完成后立即释放；runtime 不持有目录锁、不创建数据库、不执行 DDL 或升级，仅打开并验证当前版本。直接运行 Vite 或自定义启动入口时，必须先执行 `npm run storage:prepare`。账号是否初始化取决于个人表记录，不能以 schema 版本、旧 `.env` 内容或历史会话存在与否判断。

固定检索字段用普通列，可变消息与个人显示偏好使用 JSON 文本，不使用 JSONB。数据库通过 JSON 有效性与对象类型约束兜底，业务层仍负责字段、长度和范围校验。[SQLite JSON 文档](https://sqlite.org/json1.html)

### 聊天记录

字段映射与约束：

- `projects.position` 来自旧项目数组的下标，避免迁移后默认项目改变；新项目追加到末尾。
- `updated_at` 保留当前 JavaScript 毫秒时间戳，`revision` 保留原数字。迁移不刷新活动时间、不额外增加版本。
- 未创建 Agent 上下文时 `provider_session_id` 为 SQL NULL；返回 API 时还原为可选字段。它不承担应用会话主键或全局唯一标识的职责。
- `ordinal` 为某个会话中从 0 开始的消息顺序；读取必须按 `ordinal` 升序，不能按 UUID 排序。原消息没有创建时间，迁移时不推造逐条时间戳。
- 消息主键限定在会话内，同一消息 ID 在不同会话出现不会相互覆盖；同一会话内重复 ID 属于迁移错误。
- `payload_json` 保存 `text` 及存在的 `title`、`toolCallId`、`status`、`details`，不再重复保存行上的 `id`、`kind`。例如 `{"text":"工具输出","title":"读取文件","status":"completed","details":{"toolCallId":"call-1"}}`。还原时组合行字段与 JSON 内容，保持现有 `Message` 契约。
- 可选字段缺失与空字符串必须区分；不将 `undefined` 转成字符串，也不在消息中额外存一份重复“原始事件全文”。现有 `details` 内容原样保留。
- JSON 校验只是数据库兜底；已有消息种类、字段长度、8 MiB 请求体、5000 条消息等应用校验仍保留。数据库错误不能替代输入验证。

不提供项目或会话删除入口。外键规则用于保证一致性，不代表产品已经提供删除功能。

## 个人设置表

结构以 [003_personal_settings.sql](../migration/003_personal_settings.sql) 为准。`id` 固定为 1，从数据库约束上保证最多一个个人记录，与项目、会话和消息表独立。

| 字段 | 含义 |
| --- | --- |
| `user_id` / `user_name` | WebAuthn 随机用户标识 / 可修改显示名称，默认名称 `Stirrup` |
| `passkey_rp_id` | 注册时的网站域名，不含协议或端口；不得随 `.env` 域名修改自动改写 |
| `credential_json` | 完整公钥凭证：ID、COSE 公钥的 base64url、签名计数器、可选传输方式；不保存私钥 |
| `session_ttl_seconds` | 下次登录的绝对有效期，默认 43200 秒，范围 1–31536000 |
| `preferences_json` | 主题 `theme`、减少透明 `opaque`、减少动态 `motion`、栏宽比例 `ratio`；默认 system / false / false / 0.2 |
| `revision` | 账号配置与凭证写入的乐观并发版本 |
| `preferences_revision` | 显示偏好的独立写入版本，避免登录计数器变化干扰外观保存 |
| `updated_at` | 最后一次个人记录更新的毫秒时间戳 |

[PersonalSettingsStore](../local/storage/personal-settings-store.ts) 只操作该表。没有记录时 `/api/auth` 返回未初始化，页面直接创建 Passkey；生成注册选项不插入记录，验证成功后在事务中检查空表并插入账号和默认配置。并发初始化只有一个提交成功，不替换先完成的凭证。失败、取消、超时及服务重启均不得产生半初始化用户。

旧 `.env` 用户、公钥、有效期和浏览器中的外观配置不导入；旧文件不自动删除。新的个人表是唯一来源。数据库读取/损坏错误必须向上抛出，不能将错误解释为无数据并重新开放初始化。

凭证更新和个人设置更新使用参数化语句及版本校验，冲突返回 409。外观接口白名单不包含用户或凭证字段；账号接口只修改显示名称与后续登录有效期。只读设置接口返回名称、RP 域名、配置有效期、当前登录到期时间和版本，不返回原始公钥、凭证 JSON、Cookie 或挑战。

站点域名改变时，原凭证仍属于原 RP；拒绝用新域名验证原凭证，不清空账号、不自动开放注册。首次初始化、Passkey 协议与 HTTPS 代理契约由 [003](003_web_app_design.md#站点身份与-nginx) 定义，设置操作由 [006](006_settings_page_design.md) 定义。

## 读写与事务

### 兼容现有调用方

继续由 `WorkspaceStore` 提供 `projects`、`list()`、`conversation(id)`、`addProject(input)`、`createConversation(input)`、`saveConversation(id, input)`；对调用方保持同样的对象结构、状态码和字段语义。提供 `close()` 用于运行入口释放连接。

`GET /api/workspace`、`POST /api/projects`、`POST /api/conversations`、`PUT /api/conversations/:id` 保持兼容。消息虽然分行保存，当前 HTTP 接口仍返回完整历史并接收完整快照；分页加载和增量保存协议不在此次切换中同时引入。

查询使用绑定参数，禁止把项目路径、标题、消息或 ID 拼接成 SQL。列表按 `projects.position` 及对话更新时间稳定读取，消息按 `ordinal` 重建数组。读取失败应返回明确错误，不能吞掉损坏记录后呈现为空工作区。

### 保存一次会话快照

浏览器继续每约 500ms 合并流式变化，同一会话的保存排队串行执行；轮次完成和主动退出时 flush。存储层执行：

1. 在开始事务前校验输入，并生成消息 JSON，避免在锁内做无关计算。
2. 开启即时写事务；读取会话，确认存在。
3. 按会话 ID 和预期 revision 匹配记录，更新允许修改的字段、`updated_at` 并递增 revision；不得更新 `project_id`、`agent_id`。未提供 `providerSessionId` 时保留原值。
4. 更新行数不是 1，回滚并返回 409；会话不存在仍返回 404。
5. 删除该会话旧消息行，按输入数组顺序插入本次全部消息。
6. 提交事务后才返回新 `revision` 与 `updatedAt`。任何一步失败都回滚，旧快照仍完整。

采用“事务内替换整组消息”以保持现有快照语义，避免顺序调整与部分工具更新引入另一套合并协议。这会有全量写放大，不能宣称使用 SQLite 就已经变成逐消息增量保存；现有请求上限与合并节流继续约束它。应用状态不得在提交成功前提前增加版本。

超出忙等待窗口的锁冲突返回可重试的 503；版本冲突返回 409，不能自动覆盖另一窗口。I/O、磁盘满或事务异常保留用户草稿和未保存状态，禁止用新空库替代损坏库。SQLite 提交不消除浏览器关闭前尚未发送数据的丢失窗口。

## 旧 JSON 数据迁移

### 入口与预检

执行 `npm run storage:migrate`。首次有旧 JSON 时采用显式离线迁移；不在浏览器打开页面时悄悄导入。迁移与导出工具共用短期目录锁，冲突时拒绝执行；崩溃遗留锁须核实原进程已结束后再清理。工具不检测或强制保证 Web 实例唯一性，执行升级、导入、导出前由操作者停止服务，部署流程串行执行。

迁移前停止 dev / preview 并关闭活动 ACP 会话。命令只读扫描旧文件，生成有序文件清单与 SHA-256 摘要，校验：

- 项目 ID、对话 ID、文件名内 ID 一致；项目路径及 ID 不重复。
- 每条对话的项目存在、Agent 是已支持的值、字段类型和消息内容有效。
- 每个会话内消息 ID 唯一，序号可以由原数组无损生成。
- 不因当前工作目录暂时离线而丢弃旧项目；旧路径原样保留，后续连接时报告不可访问。新添加项目仍执行目录存在检查。

遇到损坏 JSON、未知字段、未知 Agent、悬空引用、重复 ID 或不兼容类型时停止，报告文件和字段，不输出消息正文。未知字段必须先确定保留映射，不能静默丢弃后宣称无损迁移。

### 建库与切换

1. 保留原文件，并把本次源清单、摘要和源文件复制到 `.local/web/backups/json-<时间戳>/`；仅含项目和对话，不复制凭据文件。
2. 在同目录新建临时候选数据库，执行建表及全部导入；项目、对话、消息、`schema_migrations` 全部版本标记一次事务提交。`legacy_digest` 记录源清单摘要。
3. 验证项目/会话/逐会话消息数量、原 ID、顺序、内容、草稿、时间和版本；执行外键与数据库完整性检查。比较使用解析后的结构，不要求 JSON 空格或对象键顺序相同。
4. 复核源清单未改变，完成 checkpoint，关闭候选连接；没有未合并 WAL 数据时才原子发布为 `stirrup.sqlite`。实现采用同文件系统硬链接发布后移除临时候选名称，确保目标存在时失败，避免普通 rename 覆盖已有文件。
5. 下次启动只使用已验证数据库，旧 JSON 保留为历史源，不再读写、不做双写。

重复运行：已有完成标记且源摘要相同则报告“已迁移”，不重复导入；目标存在而标记不完整、来源不同或结构版本未知时拒绝覆盖。中断留下的临时候选库不能被服务自动选中，应清理/重建候选后重试。

没有旧项目/对话、也没有数据库的全新安装，启动前准备在临时候选库中执行完整 migration 清单、创建默认项目并核验，关闭后以硬链接发布，目标存在时拒绝覆盖；个人设置表保持为空。已有 JSON 而没有数据库时提示先迁移；已有有效数据库时只以数据库为准。禁止创建空库遮住待迁移历史。

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
| `migration/` | 有序 SQL、schema 执行器、启动前准备及工具短期锁 |
| `local/storage/personal-settings-store.ts` | 单用户初始化、凭证及个人配置读写 |
| `local/storage/workspace-store.ts` | 使用 SQL 映射，保留调用契约 |
| `migration/legacy-json.ts` | 仅供离线导入/回退使用的旧格式校验与转换 |
| `migration/cli.ts` | 预检、备份、导入、导出、核验及明确结果 |
| `local/runtime.ts`、`local/vite-plugin.ts` | 组装业务服务、打开已准备数据库并关闭连接；不维护实例独占锁 |
| `local/http/routes.ts` | 延续鉴权和 DTO，不写 SQL、不接收数据库路径 |

故障验收要求：

1. 项目顺序、会话归属、消息顺序、可选字段、工具详情和草稿往返一致。
2. 同 revision 的两个保存只有一个成功；消息插入中途失败时，版本和旧消息一起回滚。
3. 锁冲突、磁盘错误与非法 JSON 不返回成功、不清空数据库。
4. 迁移保留原 ID、`providerSessionId`、`updatedAt`、revision；损坏记录导致整体失败；重复执行不产生副本。
5. 迁移中断可重试，目标数据库不被覆盖；切换后的新增记录可通过离线导出完整回退。
6. 登录/Origin/ACP 项目绑定检查不弱化；数据库、WAL、SHM 和备份均不能通过 HTTP 静态路径读取。
7. 重启后能读到已提交历史；不自动恢复内存 Session、不批准旧权限请求。
8. 启动前准备失败时不启动服务；重复准备不重复写入。直接打开缺失或旧版本数据库的 runtime 拒绝启动且不执行迁移。runtime 不创建或持有 `.storage.lock`。

迁移执行、实际数据核验及测试结果统一记录在 [CHANGELOG.md](../CHANGELOG.md)。

相关 Agent 接入契约：[008 · Antigravity](008_agy_acp.md)。

## 升级与恢复边界

当前 schema 版本为 3。v1/v2 数据库在启动前准备阶段的短期目录锁内执行剩余 SQL，保留原项目、会话、消息和版本 1 的导入摘要；v3 增加空的个人设置表，不导入旧账号。新数据库与升级数据库执行的结构版本必须一致。

升级前停止服务及离线命令，备份完整 `.local/web/`。低版本代码不能直接打开高版本数据库；回退时恢复完整备份及配套代码。升级后的新数据不在旧备份内，应另行保留。`storage:export` 只导出聊天数据，不包含个人凭证和配置，不能作为完整账号备份；完整恢复必须包含 SQLite 个人表。旧版 JSON 导入器不认识新增 Agent，含 AGY 会话的导出不能直接交给旧版程序。

个人表验收还应覆盖：首次空表、失败注册无记录、并发注册唯一提交、重启后凭证与个人配置保留、旧 `.env` 不影响新账号、错误来源/RP 拒绝、个人配置冲突不覆盖凭证、migration 失败回滚且不误判为首次使用。
