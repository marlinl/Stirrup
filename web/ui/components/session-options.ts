import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { AGENTS, sessionOptions, type AgentId } from '../../acp/agents';
import type { AcpClient } from '../../acp/client';
import type { Conversation } from '../../../shared/models.ts';
import type { LiveConversation, WorkspaceController } from '../../domain/workspace';
import { el } from '../dom';

type Action = {
  client: AcpClient;
  session?: string;
  pending: boolean;
  error?: string;
  retry: () => Promise<void>;
};

/** Own inline session controls and per-connection feedback without changing selection or storing config locally. */
export function createSessionOptions(workspace: WorkspaceController, refresh: () => void) {
  const actions = new Map<string, Action>();
  let signature = '';
  let previousClient: AcpClient | undefined;
  let disposed = false;

  /** Accept an async result only while its originating connection and session still own this record. */
  function owns(id: string, action: Action): boolean {
    return (
      !disposed &&
      workspace.state(id).client === action.client &&
      action.client.phase !== 'closed' &&
      action.client.sessionId === action.session
    );
  }

  /** Serialize an advertised operation, retaining the confirmed value and a retryable error on failure. */
  async function apply(
    id: string,
    client: AcpClient,
    operation: () => Promise<void>,
  ): Promise<void> {
    const state = workspace.state(id);
    if (
      disposed ||
      state.client !== client ||
      client.phase !== 'ready' ||
      state.opening ||
      state.permissions.length ||
      actions.get(id)?.pending
    )
      return;
    const action: Action = { client, session: client.sessionId, pending: true, retry: operation };
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    actions.set(id, action);
    refresh();
    try {
      await operation();
    } catch (error) {
      if (owns(id, action)) action.error = error instanceof Error ? error.message : String(error);
    } finally {
      action.pending = false;
      if (!owns(id, action) && actions.get(id) === action) actions.delete(id);
      if (!disposed) {
        refresh();
        if (
          focusId &&
          owns(id, action) &&
          el('session-options').dataset.record === id &&
          !el('chat-panel').hidden &&
          document.activeElement === document.body
        )
          document.getElementById(focusId)?.focus({ preventScroll: true });
      }
    }
  }

  /** Render only changed configuration/lifecycle state so streaming tokens and typing do not close native menus. */
  function render(agent: AgentId, record?: Conversation, state?: LiveConversation): boolean {
    const client = state?.client;
    let action = record ? actions.get(record.id) : undefined;
    if (action && !owns(record!.id, action)) {
      actions.delete(record!.id);
      action = undefined;
    }
    const pending = !!action?.pending;
    const loading =
      !!state?.opening ||
      (!!client && ['initializing', 'authenticating', 'creating'].includes(client.phase));
    const connected = !!client?.sessionId && client.phase !== 'closed';
    const disabled =
      !connected || client?.phase !== 'ready' || loading || pending || !!state?.permissions.length;
    const unavailable = loading ? '读取中' : connected ? 'Agent 未提供' : '连接后可用';
    const options = connected ? (client?.configOptions ?? []) : [];
    const modes = connected ? client?.modes : undefined;
    const next = JSON.stringify([
      agent,
      record?.id,
      client?.sessionId,
      client?.phase,
      loading,
      options,
      modes,
      pending,
      action?.error,
      state?.permissions.length,
      client?.info?.authMethods,
    ]);
    if (next === signature && previousClient === client) return pending;
    signature = next;
    previousClient = client;
    const fields = el('session-options');
    fields.dataset.record = record?.id ?? '';
    const focused = fields.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).id
      : '';
    const moreOpen = fields.querySelector('details')?.open ?? false;
    fields.replaceChildren();
    const parts = sessionOptions(agent, options);

    /** Add a labelled field; disabled explanations remain visible and accessible beside the control. */
    function field(name: string, key: string, parent: HTMLElement): HTMLLabelElement {
      const label = document.createElement('label');
      label.className = 'session-option';
      label.htmlFor = `option-${key}`;
      const caption = document.createElement('span');
      caption.textContent = name;
      label.append(caption);
      parent.append(label);
      return label;
    }

    /** Render advertised selects with optgroups or an explicit boolean switch, preserving opaque IDs and values. */
    function config(
      name: string,
      key: string,
      option?: SessionConfigOption,
      parent = fields,
    ): void {
      const label = field(name, key, parent);
      if (!option) {
        const value = document.createElement('span');
        value.id = `option-${key}`;
        value.className = 'option-unavailable';
        value.textContent = unavailable;
        value.setAttribute('aria-disabled', 'true');
        value.setAttribute('aria-label', `${name}：${unavailable}`);
        label.append(value);
        return;
      }
      if (option.type === 'boolean' || key === 'fast') {
        const button = document.createElement('button');
        button.id = `option-${key}`;
        button.type = 'button';
        button.className = 'option-switch';
        button.setAttribute('aria-describedby', 'config-status');
        const on = option.type === 'boolean' ? option.currentValue : option.currentValue === 'on';
        const known = option.type === 'boolean' || ['on', 'off'].includes(option.currentValue);
        if (known) {
          button.setAttribute('role', 'switch');
          button.setAttribute('aria-checked', String(on));
        }
        button.setAttribute('aria-label', name);
        button.textContent = known ? (on ? '开启' : '关闭') : '当前值未知';
        button.disabled = disabled || !known;
        button.title = option.description ?? name;
        button.addEventListener('click', () => {
          const value = option.type === 'boolean' ? !on : on ? 'off' : 'on';
          void apply(record!.id, client!, () => client!.setConfigOption(option.id, value));
        });
        label.append(button);
      } else {
        select(label, key, option.currentValue, option.options, (value) =>
          client!.setConfigOption(option.id, value),
        );
      }
    }

    /** Build a native keyboard-accessible menu without flattening provider groups or inventing a default selection. */
    function select(
      label: HTMLLabelElement,
      key: string,
      current: string,
      choices: Extract<SessionConfigOption, { type: 'select' }>['options'],
      change: (value: string) => Promise<void>,
    ): void {
      const control = document.createElement('select');
      control.id = `option-${key}`;
      control.setAttribute('aria-describedby', 'config-status');
      let count = 0;
      for (const item of choices) {
        const parent = 'group' in item ? document.createElement('optgroup') : control;
        if (parent instanceof HTMLOptGroupElement) parent.label = item.name;
        for (const choice of 'group' in item ? item.options : [item]) {
          const entry = document.createElement('option');
          entry.value = choice.value;
          entry.textContent = choice.name;
          parent.append(entry);
          count++;
        }
        if (parent !== control) control.append(parent);
      }
      if (!Array.from(control.options).some((item) => item.value === current)) {
        const unknown = document.createElement('option');
        unknown.value = current;
        unknown.textContent = '当前值未知';
        unknown.disabled = true;
        control.prepend(unknown);
      }
      control.value = current;
      control.disabled = disabled || count < 2;
      control.title = control.selectedOptions[0]?.textContent ?? '';
      control.addEventListener('change', () => {
        const value = control.value;
        control.value = current;
        void apply(record!.id, client!, () => change(value));
      });
      label.append(control);
    }

    config('模型', 'model', parts.model);
    config('Effort', 'effort', parts.effort);
    config('Fast mode', 'fast', parts.fast);
    if (modes?.availableModes.length) {
      const label = field('操作模式', 'mode', fields);
      select(
        label,
        'mode',
        modes.currentModeId,
        modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
        (value) => client!.setMode(value),
      );
    }
    if (parts.other.length) {
      const more = document.createElement('details');
      more.className = 'session-more';
      more.open = moreOpen;
      const summary = document.createElement('summary');
      summary.textContent = '更多选项';
      const panel = document.createElement('div');
      panel.className = 'session-more-panel';
      parts.other.forEach((option, index) => config(option.name, `extra-${index}`, option, panel));
      more.append(summary, panel);
      more.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          more.open = false;
          summary.focus();
          event.stopPropagation();
        }
      });
      fields.append(more);
    }
    el('config-status').textContent =
      pending || client?.phase === 'configuring'
        ? '正在应用…'
        : state?.permissions.length
          ? '等待审批，暂不可修改配置'
          : client?.phase === 'prompting'
            ? '正在回复，暂不可修改配置'
            : client?.phase === 'cancelling'
              ? '正在停止…'
              : loading
                ? '正在读取会话配置…'
                : '';
    const feedback = el('config-error');
    feedback.replaceChildren();
    feedback.hidden = !action?.error;
    if (action?.error) {
      const text = document.createElement('span');
      text.textContent = `操作失败：${action.error}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.disabled =
        client?.phase !== 'ready' || loading || pending || !!state?.permissions.length;
      const operation = action.retry;
      retry.addEventListener('click', () => void apply(record!.id, client!, operation));
      feedback.append(text, retry);
    }
    const auth = el('session-auth');
    auth.replaceChildren();
    if (
      record &&
      client &&
      client.phase !== 'closed' &&
      !client.sessionId &&
      client.info?.authMethods?.length
    ) {
      const help = document.createElement('span');
      help.textContent = AGENTS[agent].authHelp;
      auth.append(help);
      for (const method of client.info.authMethods) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet-button';
        button.textContent = method.name;
        button.disabled = client.phase !== 'ready' || loading || pending;
        button.addEventListener(
          'click',
          () =>
            void apply(record.id, client, async () => {
              await client.authenticate(method.id);
              if (
                !disposed &&
                workspace.state(record.id).client === client &&
                client.phase === 'ready'
              )
                await workspace.connect(record.id);
            }),
        );
        auth.append(button);
      }
    }
    if (focused) fields.querySelector<HTMLElement>(`#${focused}`)?.focus();
    return pending;
  }

  /** Discard page-owned feedback and ignore promises completing after logout/unmount. */
  function dispose(): void {
    disposed = true;
    actions.clear();
  }
  return { render, dispose };
}
