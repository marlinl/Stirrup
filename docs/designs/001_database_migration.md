# 001 · 数据库 Migration 实现设计

## 1. 设计依据与模块边界

本设计落实 [Spec 001 · 数据库 Migration 执行规范](../specs/001_database_migration.md)，解释代码如何组织、方法如何协作及事务如何执行。版本链、文件命名和索引表字段以 spec 为准，不在本篇另建一套规则。

迁移执行器独立放在 **`src/sql/`**，只认识 SQLite、migration 文件和迁移索引；不认识项目、会话、Passkey 或 HTTP。业务存储继续放在 `src/storage/`，版本 SQL 继续放在根目录 `migration/`。不新增第二份 `sql/` 脚本目录。

```text
src/
├── sql/
│   ├── migration.ts        # 唯一公共入口 Migration、状态与错误类型
│   ├── files.ts            # SQL 文件发现、命名/配对校验、内容快照
│   ├── sqlite.ts           # 迁移专用连接、索引检查、单步事务与授权策略
│   └── lock.ts             # 基于数据库绝对路径的迁移独占锁
├── config/
│   └── database.ts         # .env 数据库路径解析及启动配置校验
├── storage/
│   ├── prepare.ts          # 业务启动准备：调用 migration.up，再做业务初始化
│   ├── database.ts         # 长生命周期业务连接、业务事务与结构验证
│   ├── workspace-store.ts  # 项目、会话与消息查询
│   ├── personal-settings-store.ts
│   ├── legacy-json.ts      # 旧数据导入/导出，不自行执行 schema SQL
│   └── cli.ts              # 离线维护命令分发
├── server.ts               # 等待数据库与业务准备完成，再监听
└── main.ts                 # 进程入口、退出码与信号处理
migration/                  # 唯一版本脚本目录，up/down 成对存在
```

依赖方向为 `server → storage/prepare → sql/migration`，以及 `sql/migration → files/sqlite/lock`。`src/sql/` 只依赖 Node 标准库及自身模块，不反向导入 storage/config，不映射 HTTP 错误码，不读取 `.env`，不提供多数据库抽象层。

## 2. 公共接口与调用场景

`src/sql/migration.ts` 只公开一个执行类和必要的数据类型。不暴露单文件执行、任意版本列表、手工写索引或独立 open/close 接口。

```ts
interface MigrationOptions {
  databasePath: string;  // 已解析的绝对文件路径
  migrationDir: string;  // 已解析的绝对 SQL 目录路径
}

interface MigrationState {
  currentVersion: number;
  latestVersion: number;
  pendingCount: number;
}

class Migration {
  /** 保存路径配置，不打开数据库、不建表、不持锁。 */
  constructor(options: MigrationOptions);
  /** 只读检查文件和索引；返回当时状态，不创建目录、数据库或索引。 */
  check(): MigrationState;
  /** 自动初始化索引并逐版本升级到文件最大版本，返回最终状态。 */
  up(): MigrationState;
  /** 默认回退一版；指定目标时逐版退到目标，返回最终状态。 */
  down(targetVersion?: number): MigrationState;
}
```

接口使用同步返回值，配合 `DatabaseSync` 和启动阶段本地文件操作；迁移期间尚未对外服务，不引入同步/异步双接口。每次方法调用独立获取资源、重新扫描并验证，结果不缓存，不在构造器中偷偷迁移。

| 调用方 | 调用方法 | 具体场景 |
| --- | --- | --- |
| `storage/prepare.ts` | `up()` | 每次服务启动先迁移，成功后打开业务连接 |
| 离线维护入口 | `check()` | 查看当前版本、最新版本和差额，不修改库 |
| 离线维护入口 | `down()` / `down(target)` | 停服后退一版或逐版退到目标 |
| 旧 JSON 导入工具 | `up()` | 对候选数据库初始化结构，再导入业务数据 |

check 的只读语义包含不创建锁目录：已有数据库使用只读连接和读事务读取一致的索引快照；如果迁移锁存在则明确报告占用。检查锁与读取存在竞态，因此 check 仅返回快照，不承诺执行资格。up/down 在自身持锁区间内重做检查，不复用此前 check 结果。

## 3. 文件模块 `files.ts`

内部使用以下数据，不进入业务 API：

```ts
interface MigrationFile {
  version: number;
  filename: string;       // up basename，也是索引 filename
  upSql: string;
  downFilename: string;
  downSql: string;
}
```

| 函数 | 责任与逻辑 | 返回/副作用与调用场景 |
| --- | --- | --- |
| `readMigrationFiles(directory)` | 读取目录项，拒绝链接/目录/未知文件；验证规范数字表示、描述、同版配对及 1…N 连续性；严格解码 UTF-8，一次读取全部内容 | 返回按数值升序的只读快照；无写入。每次 check/up/down 调用一次 |
| `hasSqlStatement(sql)` | 词法扫描时跳过空白、BOM、行注释和块注释，识别是否存在语句 token | 只用于拒绝空脚本，不充当 SQL 语法解析器或权限检查器 |

数值解析后验证 `Number.isSafeInteger(version)`，再用 `String(version).padStart(3, '0')` 与原版本串对比，排除 0、负数、别名与溢出。同版本多个 up/down 必须报重复，不能用 Map 覆盖旧值。

不缓存跨命令文件快照，不维护硬编码 MIGRATIONS 数组。所有文件内容在执行第一版前固定；SQL 的完整语法及数据库对象语义由 SQLite 在对应步骤执行时检查。文件列表错误必须在执行前报出，而未来 SQL 语法错误可以在执行到该版本时失败，已提交前缀保持不变。

## 4. SQLite 模块 `sqlite.ts`

该模块不复用业务 `DatabaseConnection`，因为业务连接校验依赖最终业务表，无法用于空库、中间版本或回退后的库。它使用 `node:sqlite`，只处理通用完整性、索引表和事务。

| 内部函数 | 责任、输入与逻辑 | 返回/副作用与调用场景 |
| --- | --- | --- |
| `openMigrationDatabase(path, readOnly)` | 已有库以指定模式打开；写模式才允许创建新文件。配置有限 busy timeout，写模式设置 FULL 同步与外键；禁用扩展加载，不注册有外部副作用的函数 | 返回专用连接，由调用命令在 finally 关闭 |
| `inspectMigration(db, files)` | 检查 integrity/foreign keys、索引结构和全部记录；逐行验证连续版本、时间戳及文件名 | 返回 MigrationState。无索引且非空的用户 schema 必须失败 |
| `initializeIndex(db)` | 仅对空库建立 spec 中的固定索引表；独立事务提交 | 不插版本 0，不创建任何业务表；只由 up 调用 |
| `applyStep(db, file, direction, expectedVersion)` | 在一个写事务内复核前缀、执行 SQL、校验、写入或删除索引、提交 | 成功返回新版本；失败回滚当前步骤并抛错 |

索引结构验证使用 `table_xinfo`、`table_list`、`index_list/index_info` 检查列名、类型、主键、STRICT 与唯一性。索引表由模块拥有固定 DDL；用 SQLite 保存的建表定义与执行器固定定义按 token 规范化比较 CHECK 约束，避免仅靠列清单接受缺失约束的表。拒绝索引表上的额外触发器。数据逐行验证，不假设 schema 正确就一定没有损坏数据。

只读 check 在数据库缺失时直接得到 K=0，不执行 mkdir 或打开可自动建库的连接。down 对不存在的数据库同样按 K=0 验证目标并无操作，不为回退建立空库。空文件存在时可只读判定为空库；存在用户表、视图或触发器却无索引不能按新库处理。

## 5. SQL 执行限制与运行时要求

使用 `DatabaseSync.setAuthorizer()` 限制脚本，选用支持该 API 的 **Node.js 24.10.0+**，执行器在任何数据库写入前验证能力。该 API 的加入版本见 [Node SQLite 官方文档](https://nodejs.org/api/sqlite.html#databasesetauthorizercallback)。实施时需要同步 package engines、安装说明和最低版本测试；缺少能力时明确失败，不静默降级为正则过滤。

授权回调区分“执行器控制 SQL”和“迁移脚本 SQL”两个阶段：

- 控制阶段允许执行器事务、PRAGMA、完整性检查和索引管理，不执行来自文件的 SQL。
- 脚本阶段禁止 TRANSACTION、SAVEPOINT、PRAGMA、ATTACH、DETACH，以及对 migration 表和其索引的写入、删除、重命名或 schema 修改。ALTER_TABLE 的表名取对应参数，不能假定所有动作都在 arg1 给表名。
- 禁止创建作用于 migration 表的触发器，以及虚拟表、扩展加载和直接写 sqlite_schema；允许 SQLite 执行正常业务 DDL 必需的内部 schema 更新，不把所有 sqlite_schema 事件一概拒绝。
- 拒绝 VACUUM 的附加数据库操作及不可事务化执行；保留事务内执行失败作为第二层保护。
- 拒绝操作返回 SQLITE_DENY，不能用 SQLITE_IGNORE 把违规 SQL 静默跳过。回调不查询或修改正在授权的连接，只检查操作码与参数。

脚本执行期间不共享连接给业务代码。授权模式切换必须由 try/finally 恢复，不能让异常后的控制 SQL 被错误拦截或让后续脚本处于无限制模式。所有授权动作与触发器间接写入都需独立测试。

## 6. 单版本事务算法

`applyStep` 共用同一算法，不为 up/down 分别维护两套事务实现：

1. 控制阶段在事务外暂时关闭外键，为需要重建引用表的脚本提供统一连接条件。
2. `BEGIN IMMEDIATE`；在事务内重新读取并验证完整索引前缀，必须等于 expectedVersion。
3. 切至脚本授权阶段，执行对应 upSql/downSql；禁止拆开文件逐条提交。
4. 恢复控制阶段，检查事务仍然有效，执行外键与数据库完整性检查。
5. up 插入版本、时间与文件名；down 删除当前最大版本且影响行数必须为 1。全部值使用绑定参数。
6. `COMMIT` 成功后更新返回版本。任何异常只回滚当前事务，保留之前已经提交的步骤。
7. finally 恢复授权阶段与 foreign_keys=ON；关闭连接前确认无活动事务。

事务、索引登记和脚本处于同一连接。外键恢复、rollback 或 close 同时失败时，保留原始错误为主原因并附带清理错误；不能让清理异常掩盖哪个版本失败。提交结果无法确定时，错误中的最后版本标为未知，要求重新 check，而不是编造已提交版本。

## 7. Migration 的命令编排

### `check()`

读取文件快照 → 检查占用 → 只读打开已有库并开启读事务 → inspect → 结束读事务与关闭 → 返回状态。数据库不存在时不创建资源；N=0 对独立执行器合法。状态必须通过全部验证后才返回。

### `up()`

规范化路径 → 获取独占锁 → 读取文件快照 → 打开专用连接并 inspect → 必要时 initializeIndex → 再 inspect → 依次 applyStep(K+1…N) → 最后 inspect → 关闭连接并释放锁。

索引初始化失败不进入任何业务迁移。若 K=N，不执行脚本或重写索引。新库途中失败保留已提交前缀，下一次从 K+1恢复；不因启动失败删除已提交数据库。业务初始化失败也不自动 down。

### `down(target?)`

规范化路径 → 获取独占锁 → 读取文件快照并 inspect → 计算 target（默认 max(K-1,0)）→ 验证目标范围 → 依次 applyStep(K…target+1) → 最后 inspect → 关闭连接并释放锁。

up/down 必须各自在一个外层 finally 内完成清理，不能在两个版本之间释放锁。所有失败都终止当前命令，不自动跳过、重试 SQL 或改变目标。

## 8. 锁与路径归一化

`lock.ts` 仅提供内部 `acquireMigrationLock(databasePath): () => void`：成功返回幂等释放函数，失败不返回伪造锁句柄。

- 数据库已存在时解析真实路径；未存在时解析最近存在祖先的真实路径再拼接剩余路径，消除相对路径和父目录软链接造成的多把锁。
- 写命令可以创建数据库父目录（0700）；锁目录为规范数据库文件名加 `.migration.lock`，使用原子 mkdir 排他创建，文件权限限制为当前用户。
- owner 文件记录 PID、获取时间和随机所有权标识；释放前核对归属，只删除本次成功获得的锁。获取中写 owner 失败时清理自身目录。
- check 不创建锁目录；锁存在时报告占用。锁只约束遵循此协议的维护进程，不阻止绕过工具的 SQLite 客户端写入。
- 拒绝数据库硬链接（多目录项指向同一 inode），避免不同文件名生成不同锁。部署期间不得替换数据库文件或重定向路径。
- 进程崩溃不自动抢占旧锁；由维护者确认原进程结束后清理。正常关闭先结束数据库事务并关连接，再释放锁。

## 9. 配置、业务初始化与发布资源

`src/config/database.ts` 从既有 env 读取机制取得 STIRRUP_DATABASE_PATH，执行 spec 的默认值、相对根目录、绝对路径及非法值规则，并把同一个 databasePath 传给 migration 和业务存储。该模块不迁移数据库。

迁移资源独立定位：开发入口传入项目根目录的 migration；构建发布使用随服务端产物复制的 migration 目录。资源复制必须完整包含 up/down，构建后不得回头依赖开发工作区，也不能从数据库所在目录寻找 SQL。文件缺失或集合为空时服务入口失败。

`storage/prepare.ts` 负责以下业务侧顺序：

1. 检查是否存在需要显式导入的旧 JSON，避免用新库遮住旧数据。
2. 调用 Migration.up；旧索引需要转换时停止，不自动采用或重跑。
3. 打开业务 DatabaseConnection，校验应用需要的表与列。
4. 在业务事务内执行可重复的默认项目初始化；个人设置保持未注册状态，不写入虚假账号。
5. 把业务连接交给 runtime，完成服务装配后才调用 listen。

WorkspaceStore 不再在构造器里重复触发 migration。Migration 命令完成后关闭自己的短期连接；业务连接由 runtime 持有并在服务退出时关闭。准备期间业务连接失败须释放连接，迁移已经成功的版本仍然保留。

离线 CLI 复用同一配置和 Migration API，回退不启动 runtime/HTTP，不创建业务初始化数据。旧索引转换独立于正常 API，按 spec 的已审核映射执行；不得新增公开的 skip/markApplied 方法来方便转换。

## 10. 错误模型与验证落点

MigrationError 附带 `phase`、`direction`、可选 `version/filename`、`lastCommittedVersion`（无法确认时为 null）及 cause。阶段区分 files、lock、inspect、initialize、execute、record、commit、cleanup；错误文本不输出 SQL 正文或数据库业务内容。src/sql 不负责进程退出，main/CLI 负责安全报告和非零退出码。

| 验证层 | 重点用例 |
| --- | --- |
| 文件校验 | 版本别名、重复/跳号、缺 down、符号链接、非法 UTF-8、注释空文件、1000 与 999 数值排序 |
| SQLite 集成 | 新库、同名错误表、错误约束、索引断链、文件名不符、同数量不同版本、0→N→0→N |
| 原子性 | SQL 中段失败、登记/删除索引失败、commit 前后进程中断、完整性失败与重试起点 |
| 授权 | COMMIT/PRAGMA/ATTACH、重命名索引表、通过触发器写索引、正常业务建表与重建表 |
| 资源与并发 | 双进程争锁、不同库独立执行、路径别名、硬链接拒绝、清理失败及遗留锁 |
| 启动集成 | env 路径一致、构建资源完整、失败时端口未监听、业务初始化失败不撤销已提交 schema |

验收判据以 spec 第 11 节为准；测试结果写入 CHANGELOG。实施交付须同时更新最低 Node 版本、旧索引转换、原 SQL 对索引的建表职责、配套 down、构建复制和启动调用点，不能仅增加执行类就视为完成。
