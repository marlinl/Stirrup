import type { Conversation, Message } from '../../../shared/models.ts';
import { AGENTS } from '../../acp/agents';
import { markdown } from '../markdown';
import { el, run } from '../dom';
import type { MessageViewState } from '../view-state';
/** Own the mounted transcript cache, retaining stable nodes while the selected conversation streams. */
export function createMessageList() {
  const rendered = new Map<string, { element: HTMLElement; signature: string }>();
  /** Reset only the rendered transcript when switching conversations or unmounting. */
  function reset(): void {
    rendered.clear();
    el('transcript').replaceChildren();
  }
  /** Update stable message nodes only when their content changes, preserving historical reading position. */
  function render(record?: Conversation, state?: MessageViewState): void {
    el('empty').hidden = !!record?.messages.length;
    if (!record || !state) return;
    const view = el('messages');
    const previous = state.scroll;
    for (const message of record.messages) {
      const signature = JSON.stringify(message);
      let cached = rendered.get(message.id);
      if (!cached) {
        const article = document.createElement('article');
        article.className = `message ${message.kind}`;
        el('transcript').append(article);
        cached = { element: article, signature: '' };
        rendered.set(message.id, cached);
      }
      if (signature === cached.signature) continue;
      cached.signature = signature;
      renderMessage(cached.element, message, record, state);
    }
    view.scrollTop = state.follow ? view.scrollHeight : previous;
    el('new-content').hidden = state.follow || record.messages.length === 0;
  }
  return { render, reset };
}

/** Format sanitized Markdown or expandable ACP details with per-conversation disclosure state. */
function renderMessage(
  article: HTMLElement,
  message: Message,
  record: Conversation,
  state: MessageViewState,
): void {
  article.replaceChildren();
  if (message.kind === 'notice') {
    article.textContent = message.text;
    return;
  }
  if (['thought', 'tool', 'plan', 'event'].includes(message.kind)) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${message.title ?? (message.kind === 'thought' ? '思考过程' : '执行详情')}${message.status ? ` · ${message.status}` : ''}`;
    details.open = state.expanded.has(message.id);
    const content = document.createElement('pre');
    content.textContent = message.text;
    details.append(summary);
    if (message.kind === 'plan' && Array.isArray(message.details?.entries)) {
      const steps = document.createElement('ol');
      steps.className = 'plan-steps';
      for (const entry of message.details.entries) {
        const step = document.createElement('li');
        const status =
          { pending: '待处理', in_progress: '进行中', completed: '已完成' }[String(entry.status)] ??
          String(entry.status);
        step.textContent = `${status} · ${entry.content}`;
        steps.append(step);
      }
      details.append(steps);
    } else details.append(content);
    article.append(details);
    details.addEventListener('toggle', () => {
      if (details.open) state.expanded.add(message.id);
      else state.expanded.delete(message.id);
    });
    return;
  }
  const head = document.createElement('div');
  head.className = 'message-author';
  head.textContent =
    message.kind === 'user'
      ? '你'
      : message.kind === 'error'
        ? '系统错误'
        : AGENTS[record.agentId].name;
  const content = document.createElement('div');
  content.className = 'message-content';
  if (message.kind === 'assistant') {
    content.innerHTML = markdown(message.text);
    for (const link of content.querySelectorAll('a')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    for (const block of content.querySelectorAll('pre')) {
      const code = block.textContent ?? '';
      const copy = document.createElement('button');
      copy.className = 'copy-code';
      copy.textContent = '复制';
      copy.type = 'button';
      copy.addEventListener(
        'click',
        () =>
          void run(async () => {
            await navigator.clipboard.writeText(code);
            copy.textContent = '已复制';
          }),
      );
      block.append(copy);
    }
  } else content.textContent = message.text;
  article.append(head, content);
}
