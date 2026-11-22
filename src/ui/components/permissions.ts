import type { LiveConversation } from '../../domain/workspace';
import { el, run } from '../dom';
/** Bind approval buttons to their owning connection, independent of view selection. */
export function renderPermissions(state?: LiveConversation): void {
  const box = el('permissions');
  box.replaceChildren();
  box.hidden = !state?.permissions.length;
  for (const permission of state?.permissions ?? []) {
    const card = document.createElement('div');
    card.className = 'permission-card';
    const title = document.createElement('strong');
    title.textContent = permission.request.toolCall.title ?? '请求操作许可';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看操作详情';
    const text = document.createElement('pre');
    text.textContent = JSON.stringify(permission.request.toolCall, null, 2);
    details.append(summary, text);
    card.append(title, details);
    const owner = state!.client;
    for (const option of [...permission.request.options, { name: '取消审批', optionId: undefined }]) {
      const button = document.createElement('button');
      button.className = 'quiet-button';
      button.textContent = option.name;
      button.addEventListener(
        'click',
        () => void run(async () => owner?.answerPermission(permission.id, option.optionId)),
      );
      card.append(button);
    }
    box.append(card);
  }
}
