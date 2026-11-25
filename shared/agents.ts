/** Stable Agent identities and same-origin ACP endpoints shared by both runtimes. */
export const AGENTS = {
  codex: { name: 'Codex', endpoint: '/acp/codex' },
  dsh: { name: 'DSH', endpoint: '/acp/dsh' },
  agy: { name: 'Antigravity', endpoint: '/acp/agy' },
} as const;

export type AgentId = keyof typeof AGENTS;
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** Accept only own registry keys at URL and persistence boundaries. */
export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && Object.hasOwn(AGENTS, value);
}
