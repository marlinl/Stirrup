import type { SettingsSummary } from '../../../shared/models.ts';

/** Show authenticated storage metadata, keeping actual backend state distinct from Agent-owned context. */
export function renderStorage(host: HTMLElement, summary: SettingsSummary): void {
  host.innerHTML = `<section class="settings-card glass"><h3>应用数据</h3><dl class="settings-facts" id="storage-facts"></dl>
    <p class="muted">此处保存项目、页面对话、消息和草稿。各 Agent 自行管理模型上下文，能否继续会话取决于 Agent 的恢复能力。</p>
    <p class="muted">迁移、备份及回退需在本机停止服务后操作；此页面只读。</p></section>`;
  const s = summary.storage;
  for (const [label, value] of [
    ['当前存储方式', s.backend === 'sqlite' ? 'SQLite' : 'JSON 文件'],
    ['应用数据位置', s.location],
    ['结构版本', s.schemaVersion === null ? '不适用' : `v${s.schemaVersion}`],
    ['项目数量', s.projectCount],
    ['对话数量', s.conversationCount],
    ['消息数量', s.messageCount],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = String(label);
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    host.querySelector('#storage-facts')!.append(dt, dd);
  }
}
