import type { WorkspaceController } from '../../domain/workspace';
import type { Project } from '../../../shared/models.ts';
import { openDialog } from './modal';
import { el, run } from '../dom';
/** Register a local project path, presenting validation errors alongside the form. */
export function addProject(workspace: WorkspaceController, created: (project: Project) => void): void {
  openDialog(
    '添加项目',
    /* HTML */ `<form id="project-form" class="stack-form">
      <p class="muted">每个项目对应本机上的一个工作目录。</p>
      <label for="project-name">项目名称</label
      ><input id="project-name" maxlength="80" placeholder="例如：我的应用" /><label for="project-cwd"
        >本地绝对路径</label
      ><input id="project-cwd" placeholder="/Users/you/Projects/my-app" required />
      <p id="project-error" class="inline-error" role="alert"></p>
      <button class="primary">添加项目</button>
    </form>`,
  );
  el('project-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const button = el('project-form').querySelector('button')!;
      button.disabled = true;
      try {
        const project = await workspace.addProject(
          el<HTMLInputElement>('project-name').value,
          el<HTMLInputElement>('project-cwd').value,
        );
        created(project);
        el<HTMLDialogElement>('dialog').close();
      } catch (error) {
        el('project-error').textContent = error instanceof Error ? error.message : '添加失败';
      } finally {
        button.disabled = false;
      }
    });
  });
}
