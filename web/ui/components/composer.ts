import type { Conversation } from '../../../shared/models.ts';
import type { LiveConversation } from '../../domain/workspace';
import { el } from '../dom';
import { status } from '../status';
/** Derive enabled actions from the actual session lifecycle, not optimistic visual state. */
export function renderControls(
  record?: Conversation,
  state?: LiveConversation,
  pending = false,
): void {
  const client = state?.client;
  const ready =
    client?.phase === 'ready' &&
    !!client.sessionId &&
    !state?.opening &&
    !pending &&
    !state?.permissions.length;
  el('connection-status').textContent = status(record, state);
  el('connection-status').classList.toggle('busy', client?.phase === 'prompting');
  el<HTMLButtonElement>('connect-session').hidden = !record || !!client?.sessionId;
  el<HTMLButtonElement>('connect-session').disabled =
    !!state?.opening || (!!client && !['ready', 'closed'].includes(client.phase));
  el('connect-session').textContent = record?.providerSessionId ? '继续会话' : '连接会话';
  el<HTMLButtonElement>('disconnect-session').hidden = !client || client.phase === 'closed';
  el<HTMLButtonElement>('send').disabled =
    !ready || !el<HTMLTextAreaElement>('prompt').value.trim();
  el<HTMLButtonElement>('cancel').hidden =
    !client || !['prompting', 'cancelling'].includes(client.phase);
  el<HTMLButtonElement>('cancel').disabled = client?.phase !== 'prompting';
  el<HTMLTextAreaElement>('prompt').disabled =
    !record || client?.phase === 'prompting' || client?.phase === 'cancelling';
  const prompt = el<HTMLTextAreaElement>('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(180, Math.max(62, prompt.scrollHeight))}px`;
  el('session-hint').textContent = state?.connectionError
    ? `连接失败：${state.connectionError}`
    : !record
      ? '选择项目并新建对话，开始你的工作。'
      : !client?.sessionId
        ? record.providerSessionId
          ? '已保存的对话 · 点击“继续会话”恢复上下文。不支持恢复时可新建对话。'
          : '连接后即可发送；需要认证时，请使用上方 Agent 提供的登录方式。'
        : '';
}
