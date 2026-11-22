import { AGENTS, type AgentId } from '../../acp/agents';
import type { WorkspaceController } from '../../domain/workspace';
import { icon } from '../icons';

/** Mount Agent summaries from existing clients only; return a cheap refresh callback for background status changes. */
export function renderAgents(
  host: HTMLElement,
  workspace: WorkspaceController,
  choose: (id: AgentId) => void,
): () => void {
  host.innerHTML =
    (['codex', 'dsh'] as const)
      .map(
        (id) => `<section class="settings-card glass">
    <h3 class="settings-agent-heading">${icon(id)}${AGENTS[id].name}</h3><p id="status-${id}"></p><p class="muted" id="capabilities-${id}"></p>
    <button class="quiet-button" data-show-agent="${id}">查看 ${AGENTS[id].name} 对话</button></section>`,
      )
      .join('') +
    '<p class="muted">模型和操作模式在具体会话内配置。连接成功不代表模型调用已验证；此页不会启动新的 Agent。</p>';
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-show-agent]'))
    button.addEventListener('click', () => choose(button.dataset.showAgent as AgentId));
  /** Refresh counts and actual recovery capabilities without replacing focused buttons. */
  function refresh(): void {
    for (const id of ['codex', 'dsh'] as const) {
      const states = workspace.conversations
        .filter((c) => c.agentId === id)
        .map((c) => workspace.live.get(c.id))
        .filter((s) => !!s);
      const connected = states.filter((s) => s.client?.sessionId && s.client.phase !== 'closed');
      const active = states.filter(
        (s) => s.opening || (s.client && !['ready', 'closed'].includes(s.client.phase)),
      ).length;
      const pending = states.reduce((sum, s) => sum + s.permissions.length, 0);
      host.querySelector(`#status-${id}`)!.textContent =
        `${connected.length ? `${connected.length} 个已连接会话` : '未连接'} · ${active} 个进行中 · ${pending} 项待审批`;
      host.querySelector(`#capabilities-${id}`)!.textContent = connected.length
        ? connected
            .map((state, index) => {
              const caps = state.client?.info?.agentCapabilities;
              const recovery = caps?.sessionCapabilities?.resume
                ? 'resume'
                : caps?.loadSession
                  ? 'load'
                  : '未声明恢复能力';
              return `会话 ${index + 1}：${recovery}，${state.client?.configOptions.length ?? 0} 项配置`;
            })
            .join('；')
        : '未连接时不推断模型凭据或能力。';
    }
  }
  refresh();
  return refresh;
}
