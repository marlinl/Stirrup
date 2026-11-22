# Agent Policy

## Activation

This policy applies ONLY when the root model is `gpt-6-astra` or `gpt-5.6-sol`.

If the root model is `gpt-5.6-terra`, `gpt-5.6-luna`, or any other model:

* do NOT spawn subagents because of this policy
* execute the task directly
* ignore the delegation rules below

## Root: Astra / Sol

Root only plans, delegates, and validates.

* MUST delegate substantial implementation to `terra`.
* Use `luna` for small, deterministic, or mechanical work.
* MUST NOT investigate/read substantial code before delegation.
* Prefer one subagent owning the full loop: investigate → implement → test/debug → verify.
* Do not split overlapping work across agents.
* Parallelize only genuinely independent tasks.
* Avoid duplicate investigation or verification.
* Use independent review only for risky, complex, security-sensitive, concurrent, or cross-cutting changes.
* Delegate fixes back to the same agent when practical.
* Subagents execute directly and MUST NOT delegate further.
* If delegation fails, report it; do not silently fall back to root implementation.

## 文档与变更记录规则（适用于所有模型）

以下规则独立于上方的模型委派条件，所有执行者均须遵守。

### CHANGELOG.md：操作与变更的唯一记录入口

- 所有操作变更必须在根目录 `CHANGELOG.md` 中记录，包括代码、依赖、配置、文档、数据迁移/回退、服务启停及其他运行状态变更；相关验证、失败与未完成事项一并记录。
- 按实际发生时间升序排列，新记录追加在文件末尾。新增任务记录使用 `YYYY-MM-DD HH:mm:ss +08:00`，时区为 `Asia/Shanghai`；同一任务的一组操作可合并为一个条目，并按执行先后描述。
- 每条记录说明操作/变更内容、影响范围、执行结果及验证情况；未运行的测试明确标为未运行，计划、已执行操作和已验证结果不能混写为完成。
- 同一任务完成前必须追加记录。仅修改文档或调整本规则，也必须记入 changelog。
- 历史内容只追加，不覆盖或删除既有事实；发现错误时追加更正并指向原条目。首次整理旧记录时仅使用可确认的日期/时间，未知时刻明确注明，不补造时间或验证结论。
- 不记录密钥、Cookie、绑定授权、完整 `.env`、私有消息正文等敏感内容。描述必要的操作和结果，不复制终端中的敏感输出。

### docs/：当前最终设计

- `docs/` 只保留当前有效、定稿的设计：目标与范围、模块职责、接口契约、数据结构、交互规则、约束、迁移/恢复机制和验收标准。
- 设计变化时直接更新对应权威文档，使其形成一份一致的最终说明；同步修正目录和引用。旧设计如何变化、为何变更及实施过程写入 `CHANGELOG.md`。
- 禁止在 `docs/` 追加修改历史、日期进度、实现日志、测试通过记录、具体环境迁移结果或“本次完成/尚未完成”的阶段汇报；禁止保留已经失效的设计作为历史段落。
- 区分验收标准与执行结果：应验证哪些行为属于设计；何时运行、通过多少测试、实际数据数量和人工检查结果属于 changelog。
- 通用启动、迁移、回退步骤可以作为最终使用契约保留；某次实际执行步骤和结果必须写入 changelog。
- `README.md` 保留项目介绍、使用入口和文档索引，通过链接指向设计与 changelog，不再维护另一份变更或验证日志。
