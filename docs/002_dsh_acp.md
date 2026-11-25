# 002 · DSH ACP 对接

> 本文定义 DSH ACP 接入设计。登录、项目与多会话布局见 [003 · Web 启动与页面设计](003_web_app_design.md)。

## 范围

DSH 在本文指 DeepSeek 官方的 DeepSeek Harness。接入其内置 ACP v1 profile，使用锁定的 `@deepseek-ai/dsh` 0.2.2-rc.5，不引入第三方适配器。实现限定为本地页面选择代理、创建会话、文本消息、配置选择、审批和取消。

```text
页面选择 DSH → /acp/dsh → 本地 stdio 转接 → dsh --profile acp
```

与 Codex 共用 `AcpClient` 和字节传输。只增加第二个固定启动入口，不设计服务部署、账号管理或插件注册平台，也不启动 DSH 自带的 Web 服务。

## 页面与协议

| 动作 | 协议与行为 |
| --- | --- |
| 选择代理 | 通过左侧图标切换 Codex 或 DSH；各会话消息、审批和连接独立保留 |
| 连接 | `initialize` 协商 ACP v1；代理没有认证方法时不显示虚构的登录按钮 |
| 创建会话 | `session/new` 发送所选项目的绝对路径及空 MCP 列表 |
| 配置 | 展示 `configOptions`；使用实际返回的 ID / value 调用 `session/set_config_option` |
| 配置更新 | 完整替换响应或 `config_option_update` 中的配置列表；支持分组选择及布尔值 |
| 文本对话 | `session/prompt`；通过 `session/update` 接收消息和工具活动，最终响应结束轮次 |
| 工具审批 | 原样展示本次请求的选项，按请求 ID 回答，不记忆或自动批准 |
| 停止 | `session/cancel` 后等待 prompt 最终响应；等待期间禁止提交新轮次 |
| 断开 | 拒绝待决调用、取消未处理审批、关闭连接并回收代理进程 |

DSH 的配置 ID 和模型 value 都是不透明标识，不通过拆分字符串推测 provider/model。当前会话未返回 `modes` 时隐藏操作模式控件，不能把 Codex 的 `read-only` / `workspace-write` 套用到 DSH。模型或推理强度选项仅在代理实际提供时出现；配置更新失败会恢复最后确认的值。此版将配置修改限制在空闲期间。

只接收当前会话的通知，切换代理不会重发上一轮请求。消息到达频率由 DSH 决定，页面不承诺逐 token 推送。配置标签通过 DOM 文本节点展示；003 中的助手消息使用经过清理的 Markdown，原始 HTML 不执行。

官方 ACP 的可用能力与 DSH 自带 UI 不同；本地会话列表及按实际能力恢复遵循 003；附件、DSH 展示扩展和独立工具终端不在接口范围内。

## 本地配置

DSH 0.2.2-rc.5 要求 **Node.js 24.9.0+**，项目使用相同的最低 Node 版本。执行：

```sh
npm install
npm run dev
```

打开终端给出的本地地址，先绑定或使用本地 Passkey 登录，再点击左侧 **DSH** 图标，在项目旁新建会话。

DSH 模型调用使用本地凭据。启动进程可继承已设置的 `DEEPSEEK_API_KEY`；已有 DSH 配置也可通过环境变量 `DSH_HOME` 指定：

```sh
DSH_HOME="$HOME/.dsh" npm run dev
```

未指定时，转接层使用本项目的 `.local/dsh/`，包含 DSH 自己的配置和会话数据；该目录已被 Git 忽略。显式的相对路径或 `~` 路径由 DSH 按其规则解析。不要把凭据放入 `VITE_*` 变量、页面、源码或文档。Stirrup 不复制已有凭据，也不新增密钥输入表单。

ACP 的 `initialize` 成功只说明协议已连接，不能证明模型认证成功。缺少凭据时，模型调用可能失败；应在启动环境或指定的 DSH 本地配置中补齐后重试。修改启动环境变量后需要重启 `npm run dev`。DSH 的工具授权由其本地策略控制，页面只能处理代理实际发送的审批请求，不能把“没有收到审批”解释为只读。

两条入口检查 Host / Origin，拒绝未知 ACP 路径。启动命令固定为安装依赖中的 CLI，页面不能传入可执行文件或命令行。DSH 启动显式设置 `DSH_TELEMETRY_DISABLED=1`；Codex 的 `INITIAL_AGENT_MODE` 不作为 DSH 的权限策略。

## 代码位置

- `web/acp/agents.ts`：固定代理的页面名称、入口和交互提示。
- `src/acp/launch.ts`、`src/acp/bridge.ts`：各代理的启动参数、环境及共享 stdio 转接。
- `web/acp/client.ts`：共享会话生命周期及配置选项更新。
- `web/ui/pages/workspace.ts`、`web/ui/components/session-options.ts`：代理选择与实际能力对应的配置控件。
- `web/domain/workspace.ts`：各会话独立状态与持久化；完整目录见 [004 · 代码分层](004_code_structure.md)。
- `test/bridge.test.ts`、`test/client.test.ts`：两条入口的隔离与 DSH 配置协议回归。

## 验证

运行 `npm run check`、`npm test`、`npm run build`。自动测试覆盖两个入口的同源校验、路由选择、断开回收，以及无模式的 DSH 会话、分组配置、错误恢复和会话通知隔离。

可重复的真实进程测试：

```sh
# 仅握手、建会话、回写一个已选配置值、断开，不调用模型
npm run smoke:dsh

# 凭据配置完成后，增加一次要求固定短回复的模型调用
npm run smoke:dsh -- --prompt
```

烟测使用隔离的本机随机端口和测试授权回调，不创建或使用 Stirrup 登录账号；调用实际 DSH 进程，可能创建 DSH 自身的会话记录。它不自动批准工具请求；`--prompt` 使用真实模型，可能产生少量用量。

执行结果与依赖修复历史统一记录在 [CHANGELOG.md](../CHANGELOG.md)。依赖使用 `undici` 8.12.2、`fflate` 0.8.3、`@modelcontextprotocol/client` 2.3.0 的 npm overrides；更新 DSH 时须重新评估兼容性和是否仍需覆盖。

## 一手资料

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方 DSH ACP 契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)
- [官方 CLI 运行要求与入口](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/package.json)

具体实现以 lockfile 安装的包和握手返回能力为准，仓库主分支可能继续变化。
