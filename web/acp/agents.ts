import { AGENTS as REGISTRY, type AgentId } from '../../shared/agents.ts';
export { AGENT_IDS, isAgentId, type AgentId } from '../../shared/agents.ts';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

/** The supported local ACP agents; no endpoint accepts a page-supplied command. */
export const AGENTS = {
  codex: {
    ...REGISTRY.codex,
    authHelp: '已有本地登录可直接创建会话。需要登录时，选择代理提供的方式。',
    connectedHelp: '创建会话后即可发送消息。初始模式为只读，可在会话建立后选择代理提供的操作模式。',
  },
  dsh: {
    ...REGISTRY.dsh,
    authHelp: '使用 DSH 本地凭据配置。ACP 连接成功不代表模型凭据已配置；本页面不接收密钥。',
    connectedHelp:
      '创建会话后即可发送消息，并选择代理提供的模型和推理配置。工具权限由 DSH 本地策略决定。',
  },
  agy: {
    ...REGISTRY.agy,
    authHelp: '先在本机运行 agy 或 agy acp --login 完成认证，再连接会话。',
    connectedHelp: '创建会话后发送消息；工具权限由 Antigravity CLI 本地策略及当前模式决定。',
  },
} as const;

/** Known IDs supplement ACP categories; values always come from the active session. */
const CONFIG_IDS = {
  codex: { model: 'model', effort: 'reasoning_effort', fast: 'fast-mode' },
  dsh: { model: 'model', effort: 'reasoning_effort', fast: undefined },
  agy: { model: undefined, effort: undefined, fast: undefined },
} as const;

/** Partition advertised options, accepting only Codex's verified speed switch contract for Fast mode. */
export function sessionOptions(agent: AgentId, options: SessionConfigOption[]) {
  const ids = CONFIG_IDS[agent];
  const model =
    options.find((option) => option.category === 'model') ??
    options.find((option) => option.id === ids.model);
  const effort =
    options.find((option) => option.category === 'thought_level') ??
    options.find((option) => option.id === ids.effort);
  const candidate = options.find((option) => option.id === ids.fast);
  const values =
    candidate?.type === 'select'
      ? candidate.options
          .flatMap((item) => ('group' in item ? item.options : [item]))
          .map((item) => item.value)
      : [];
  const fast =
    candidate?.type === 'boolean' ||
    (values.length === 2 && values.includes('on') && values.includes('off'))
      ? candidate
      : undefined;
  return {
    model,
    effort,
    fast,
    other: options.filter((option) => ![model, effort, fast].includes(option)),
  };
}
