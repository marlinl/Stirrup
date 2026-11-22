import { AGENTS, type AgentId } from '../../acp/agents';
import type { Identity, Project } from '../../domain/models';
import type { WorkspaceController } from '../../domain/workspace';
import { savePreferences, type Preferences } from '../../app/preferences';
import {
  readChatRoute,
  writeChatRoute,
  readWorkspaceView,
  writeSettingsRoute,
  type SettingsSection,
} from '../../app/routes';
import { el, run } from '../dom';
import type { MessageViewState } from '../view-state';
import { renderWorkspaceShell } from './workspace-shell';
import { renderProjects } from '../components/projects';
import { createMessageList } from '../components/messages';
import { renderPermissions } from '../components/permissions';
import { renderControls as renderComposer } from '../components/composer';
import { createSidebarResizer, drawer } from '../components/sidebar-resizer';
import { installDialog } from '../dialogs/modal';
import { addProject } from '../dialogs/project';
import { createSessionOptions } from '../components/session-options';
import { createSettingsPage } from './settings';
import type { Api } from '../../api/client';

/** Mount workspace interaction state and coordinate small renderers without owning HTTP or login state. */
export function createWorkspacePage(
  workspace: WorkspaceController,
  preferences: Preferences,
  identity: Identity,
  logout: () => Promise<void>,
  api: Api,
) {
  const initialView = readWorkspaceView();
  let settingsSection: SettingsSection | undefined;
  let lastSection: SettingsSection = 'appearance';
  let settingsPage: ReturnType<typeof createSettingsPage>;
  const route = readChatRoute(preferences);
  let agent = route.agent;
  let selected = workspace.conversations.find(
    (item) => item.id === route.session && item.agentId === agent,
  )?.id;
  let projectId = selected ? workspace.record(selected).projectId : workspace.projects[0]?.id;
  let displayed: string | undefined;
  let frame = 0;
  let disposed = false;
  let sizeSidebar: () => void;
  const collapsed = new Set<string>();
  const reading = new Map<string, MessageViewState>();
  const messages = createMessageList();
  const options = createSessionOptions(workspace, renderControls);
  let resizeObserver: ResizeObserver | undefined;

  /** Keep each conversation's reading position and disclosure state outside the ACP/domain layer. */
  function viewState(id: string): MessageViewState {
    let state = reading.get(id);
    if (!state) {
      state = { scroll: 0, follow: true, expanded: new Set() };
      reading.set(id, state);
    }
    return state;
  }

  /** Apply the selected conversation's current lifecycle to composer controls. */
  function renderControls(): void {
    const record = selected ? workspace.record(selected) : undefined;
    const state = record ? workspace.state(record.id) : undefined;
    const pending = options.render(agent, record, state);
    renderComposer(record, state, pending);
    restoreReading();
  }

  /** Preserve the selected transcript anchor when composer, permissions or viewport height changes. */
  function restoreReading(): void {
    if (disposed || !selected || settingsSection) return;
    const view = el('messages');
    const state = viewState(selected);
    view.scrollTop = state.follow ? view.scrollHeight : state.scroll;
  }

  /** Open project registration and select the new project's empty conversation view. */
  function showAddProject(): void {
    addProject(workspace, (project: Project) => {
      projectId = project.id;
      selected = undefined;
      updateRoute();
      render();
    });
  }

  /** Build stable regions and bind interactions once per authenticated page mount. */
  function renderShell(): void {
    renderWorkspaceShell();
    displayed = undefined;
    messages.reset();
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-agent]'))
      button.addEventListener('click', () => chooseAgent(button.dataset.agent as AgentId));
    el('settings').addEventListener('click', () => showSettings(settingsSection ?? lastSection));
    el('new-chat').addEventListener('click', () => void run(() => newConversation()));
    el('add-project').addEventListener('click', showAddProject);
    el('connect-session').addEventListener(
      'click',
      () =>
        void run(async () => {
          if (selected) await workspace.connect(selected);
        }),
    );
    el('disconnect-session').addEventListener('click', () => {
      if (selected) workspace.state(selected).client?.close();
    });
    el('cancel').addEventListener(
      'click',
      () =>
        void run(async () => {
          if (selected) await workspace.state(selected).client?.cancel();
        }),
    );
    el('open-drawer').addEventListener('click', () => drawer(true));
    el('drawer-backdrop').addEventListener('click', () => drawer(false));
    installDialog();
    el('messages').addEventListener('scroll', () => {
      if (!selected || settingsSection) return;
      const view = el('messages');
      const state = viewState(selected);
      state.scroll = view.scrollTop;
      state.follow = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
      if (state.follow) el('new-content').hidden = true;
    });
    el('new-content').addEventListener('click', () => {
      if (selected) viewState(selected).follow = true;
      el('messages').scrollTop = el('messages').scrollHeight;
      el('new-content').hidden = true;
    });
    el('prompt').addEventListener('input', () => {
      if (selected) workspace.draft(selected, el<HTMLTextAreaElement>('prompt').value);
      renderControls();
    });
    el('prompt').addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        el<HTMLFormElement>('composer').requestSubmit();
      }
    });
    el('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const id = selected;
      const text = el<HTMLTextAreaElement>('prompt').value;
      if (id && text.trim() && !el<HTMLButtonElement>('send').disabled)
        void run(() => workspace.send(id, text));
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-suggestion]'))
      button.addEventListener(
        'click',
        () =>
          void run(async () => {
            if (!selected) await newConversation();
            if (selected) {
              workspace.draft(selected, button.dataset.suggestion!);
              el<HTMLTextAreaElement>('prompt').value = button.dataset.suggestion!;
              renderControls();
              el('prompt').focus();
            }
          }),
      );
    sizeSidebar = createSidebarResizer(preferences);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(restoreReading);
      resizeObserver.observe(el('messages'));
    }
  }

  /** Save view selection to UI preferences and delegate URL encoding to the route module. */
  function updateRoute(push = false): void {
    if (selected) preferences.selected[agent] = selected;
    preferences.agent = agent;
    savePreferences(preferences);
    writeChatRoute(agent, projectId, selected, push);
  }

  /** Change the visible agent while keeping independent ACP connections alive. */
  function chooseAgent(value: AgentId): void {
    const fromSettings = !!settingsSection;
    if (settingsSection) settingsPage.hide();
    settingsSection = undefined;
    agent = value;
    const candidate = preferences.selected[agent];
    selected = workspace.conversations.find(
      (item) => item.id === candidate && item.agentId === agent,
    )?.id;
    projectId = selected ? workspace.record(selected).projectId : workspace.projects[0]?.id;
    updateRoute(fromSettings);
    drawer(false);
    render();
  }

  /** Enter a settings category without unmounting chat, reconnecting clients or losing in-flight output. */
  function showSettings(section: SettingsSection, historyNavigation = false): void {
    const entering = !settingsSection;
    settingsSection = lastSection = section;
    writeSettingsRoute(section, entering && !historyNavigation);
    drawer(false);
    render();
    settingsPage.show(section);
    el('settings-title').focus();
  }

  /** Restore browser history selections while keeping the existing workspace controller and pending requests. */
  function navigateHistory(): void {
    const view = readWorkspaceView();
    if (view.kind === 'settings') showSettings(view.section, true);
    else {
      settingsPage.hide();
      settingsSection = undefined;
      const route = readChatRoute(preferences);
      agent = route.agent;
      selected = workspace.conversations.find(
        (c) => c.id === route.session && c.agentId === agent,
      )?.id;
      projectId = selected ? workspace.record(selected).projectId : workspace.projects[0]?.id;
      updateRoute();
      drawer(false);
      render();
    }
  }

  /** Close only the narrow category/session drawer on Escape; settings itself remains a routed view. */
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && el('workspace').classList.contains('drawer-open')) drawer(false);
  }

  /** Select a record without silently restoring context or sending prompts. */
  function chooseConversation(id: string): void {
    selected = id;
    const record = workspace.record(id);
    agent = record.agentId;
    projectId = record.projectId;
    updateRoute();
    drawer(false);
    render();
  }

  /** Create and connect a project-bound record, preserving failures as retryable conversations. */
  async function newConversation(id = projectId): Promise<void> {
    if (!id) {
      showAddProject();
      return;
    }
    const targetAgent = agent;
    const record = await workspace.create(id, targetAgent);
    if (!settingsSection && agent === targetAgent) chooseConversation(record.id);
    await workspace.connect(record.id);
    if (!disposed && !settingsSection && selected === record.id) el('prompt').focus();
  }

  /** Coalesce streamed view updates while retaining inactive conversation state. */
  function scheduleRender(): void {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed) render();
    });
  }

  /** Render live status and the selected record without replacing the composer or unrelated messages. */
  function render(): void {
    if (disposed) return;
    const record = selected ? workspace.record(selected) : undefined;
    el('chat-sidebar').hidden = !!settingsSection;
    el('settings-sidebar').hidden = !settingsSection;
    el('chat-panel').hidden = !!settingsSection;
    el('settings-panel').hidden = !settingsSection;
    el('settings').setAttribute('aria-pressed', String(!!settingsSection));
    el('session-panel').setAttribute('aria-label', settingsSection ? '设置分类' : '项目和会话');
    el('resizer').setAttribute('aria-label', settingsSection ? '调整设置栏宽度' : '调整会话栏宽度');
    el('agent-title').textContent = AGENTS[agent].name;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-agent]')) {
      button.setAttribute(
        'aria-pressed',
        String(!settingsSection && button.dataset.agent === agent),
      );
      const pending = workspace.conversations
        .filter((item) => item.agentId === button.dataset.agent)
        .reduce((sum, item) => sum + workspace.state(item.id).permissions.length, 0);
      const badge = button.querySelector<HTMLElement>('.agent-badge')!;
      const running = workspace.conversations
        .filter((item) => item.agentId === button.dataset.agent)
        .some((item) => {
          const state = workspace.live.get(item.id);
          return (
            state?.opening || (state?.client && !['ready', 'closed'].includes(state.client.phase))
          );
        });
      badge.hidden = pending === 0 && !running;
      badge.textContent = pending ? String(pending) : '•';
      badge.title = pending ? `${pending} 项待审批` : '有操作正在进行';
    }
    if (settingsSection) {
      settingsPage?.update();
      return;
    }
    renderProjects(workspace, agent, selected, collapsed, {
      toggle: (id) => {
        collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        render();
      },
      create: newConversation,
      select: chooseConversation,
    });
    el('breadcrumb').textContent =
      `${workspace.projects.find((item) => item.id === projectId)?.name ?? '选择一个项目'} / ${AGENTS[agent].name}`;
    el('conversation-title').textContent = record?.title ?? '新的开始';
    el('welcome-agent').textContent = `${AGENTS[agent].name} · 你的编程伙伴`;
    document.title = `${record?.title ?? AGENTS[agent].name} · Stirrup`;
    if (displayed !== selected) {
      messages.reset();
      el<HTMLTextAreaElement>('prompt').value = record?.draft ?? '';
      displayed = selected;
    } else if (record && el<HTMLTextAreaElement>('prompt').value !== record.draft)
      el<HTMLTextAreaElement>('prompt').value = record.draft;
    messages.render(record, record ? viewState(record.id) : undefined);
    renderPermissions(record ? workspace.state(record.id) : undefined);
    renderControls();
    const error = record ? workspace.state(record.id).saveError : undefined;
    el('save-error').hidden = !error;
    el('save-error').textContent = error ? `未能保存本轮修改：${error}` : '';
  }

  /** Cancel scheduled view updates and discard reading state after the page is unmounted. */
  function dispose(): void {
    disposed = true;
    cancelAnimationFrame(frame);
    reading.clear();
    options.dispose();
    resizeObserver?.disconnect();
    settingsPage.hide();
    window.removeEventListener('popstate', navigateHistory);
    document.removeEventListener('keydown', keydown);
    document.body.classList.remove('resizing');
  }
  renderShell();
  settingsPage = createSettingsPage(
    api,
    workspace,
    preferences,
    () => sizeSidebar(),
    chooseAgent,
    showSettings,
    logout,
  );
  window.addEventListener('popstate', navigateHistory);
  document.addEventListener('keydown', keydown);
  if (initialView.kind === 'settings') showSettings(initialView.section, true);
  else {
    updateRoute();
    render();
  }
  return {
    scheduleRender,
    resize: () => {
      sizeSidebar();
      renderControls();
    },
    dispose,
  };
}
