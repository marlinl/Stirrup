import type { WorkspaceController } from '../../domain/workspace';
import type { AgentId } from '../../acp/agents';
import { icon } from '../icons';
import { el, run } from '../dom';
import { status } from '../status';
/** Group the current agent's conversations under canonical projects and preserve list scroll. */
export function renderProjects(
  workspace: WorkspaceController,
  agent: AgentId,
  selected: string | undefined,
  collapsed: Set<string>,
  actions: {
    toggle(id: string): void;
    create(id: string): Promise<void>;
    select(id: string): void;
  },
): void {
  const list = el('project-list');
  const scroll = list.scrollTop;
  list.replaceChildren();
  for (const project of workspace.projects) {
    const group = document.createElement('section');
    group.className = 'project-group';
    const header = document.createElement('div');
    header.className = 'project-heading';
    const toggle = document.createElement('button');
    toggle.className = 'project-toggle';
    toggle.innerHTML = /* HTML */ `${icon('chevron')}${icon('folder')}<span></span>`;
    toggle.querySelector('span')!.textContent = project.name;
    toggle.title = project.cwd;
    toggle.setAttribute('aria-expanded', String(!collapsed.has(project.id)));
    toggle.addEventListener('click', () => actions.toggle(project.id));
    const add = document.createElement('button');
    add.className = 'icon-button project-add';
    add.innerHTML = icon('plus');
    add.title = `在 ${project.name} 新建对话`;
    add.setAttribute('aria-label', add.title);
    add.addEventListener('click', () => void run(() => actions.create(project.id)));
    header.append(toggle, add);
    group.append(header);
    if (!collapsed.has(project.id)) {
      const sessions = workspace.conversations
        .filter((item) => item.projectId === project.id && item.agentId === agent)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const record of sessions) {
        const row = document.createElement('button');
        row.className = `session-row ${record.id === selected ? 'selected' : ''}`;
        row.setAttribute('aria-current', String(record.id === selected));
        row.title = record.title;
        const title = document.createElement('span');
        title.className = 'session-name';
        title.textContent = record.title;
        const state = status(record, workspace.state(record.id));
        const meta = document.createElement('small');
        meta.textContent = ['正在回复', '等待审批', '正在停止', '正在连接'].includes(state)
          ? state
          : new Date(record.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
        if (state === '等待审批') meta.className = 'approval-label';
        row.append(title, meta);
        row.addEventListener('click', () => actions.select(record.id));
        group.append(row);
      }
      if (!sessions.length) {
        const empty = document.createElement('p');
        empty.className = 'project-empty';
        empty.textContent = '还没有对话';
        group.append(empty);
      }
    }
    list.append(group);
  }
  list.scrollTop = scroll;
}
