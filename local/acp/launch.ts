import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { AgentId } from '../../src/acp/agents.ts';

export interface AgentLaunch {
  command: string[];
  env: NodeJS.ProcessEnv;
}

/** Resolve fixed installed CLI entrypoints and agent-specific local settings, never shell text. */
export function agentLaunch(id: AgentId, cwd: string, env: NodeJS.ProcessEnv = process.env): AgentLaunch {
  const require = createRequire(import.meta.url);
  if (id === 'codex')
    return {
      command: [process.execPath, require.resolve('@agentclientprotocol/codex-acp')],
      env: { ...env, INITIAL_AGENT_MODE: 'read-only' },
    };
  if (id === 'agy')
    return {
      command: [env.AGY_PATH?.trim() || 'agy', 'acp'],
      env: { ...env },
    };
  if (id !== 'dsh') throw new Error('Unsupported ACP agent');
  return {
    command: [process.execPath, require.resolve('@deepseek-ai/dsh/lib/bin.js'), '--profile', 'acp'],
    env: {
      ...env,
      DSH_HOME: env.DSH_HOME?.trim() || resolve(cwd, '.local/dsh'),
      DSH_TELEMETRY_DISABLED: '1',
    },
  };
}
