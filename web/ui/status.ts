import type { Conversation } from '../../shared/models.ts';
import type { LiveConversation } from '../domain/workspace';
/** Map actual connection states to concise display labels. */
export function status(record?: Conversation, state?: LiveConversation): string {
  if (!record || !state) return '就绪';
  if (state.permissions.length) return '等待审批';
  if (state.opening) return '正在连接';
  const phase = state.client?.phase;
  if (!phase || phase === 'closed') return record.providerSessionId ? '历史会话' : '未连接';
  return {
    initializing: '正在连接',
    ready: state.client?.sessionId ? '已连接' : '待建会话',
    creating: '正在建会话',
    authenticating: '等待认证',
    configuring: '更新配置中',
    prompting: '正在回复',
    cancelling: '正在停止',
  }[phase];
}
