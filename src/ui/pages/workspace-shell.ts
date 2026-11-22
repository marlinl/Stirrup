import { icon } from '../icons';
import { el } from '../dom';
/** Mount the stable workspace regions; the workspace page owns event binding and updates. */
export function renderWorkspaceShell(): void {
  el('app').innerHTML = /* HTML */ `<main class="workspace" id="workspace">
    <nav class="agent-rail glass" aria-label="Agent 导航">
      <div class="rail-logo" title="Stirrup">${icon('logo')}</div>
      <div class="rail-agents">
        <button class="agent-button" data-agent="codex" aria-label="Codex" title="Codex">
          ${icon('codex')}<span class="agent-badge" hidden></span>
        </button>
        <button class="agent-button" data-agent="dsh" aria-label="DSH" title="DeepSeek Harness">
          ${icon('dsh')}<span class="agent-badge" hidden></span>
        </button>
      </div>
      <button
        id="settings"
        class="icon-button agent-button rail-settings"
        aria-label="设置"
        title="设置"
      >
        ${icon('settings')}
      </button>
    </nav>
    <div id="drawer-backdrop" hidden></div>
    <aside class="session-panel glass" id="session-panel" aria-label="项目和会话">
      <div id="chat-sidebar" class="sidebar-content">
        <header class="panel-header">
          <div>
            <h1 id="agent-title"></h1>
            <p>你的项目与对话</p>
          </div>
          <button id="new-chat" class="icon-button" title="新建对话" aria-label="新建对话">
            ${icon('plus')}
          </button>
        </header>
        <div id="project-list" class="project-list"></div>
        <button id="add-project" class="add-project">
          ${icon('folder')}<span>添加项目</span>${icon('plus')}
        </button>
      </div>
      <div id="settings-sidebar" class="sidebar-content" hidden>
        <header class="panel-header">
          <div>
            <h1>设置</h1>
            <p>按你的习惯工作</p>
          </div>
        </header>
        <nav id="settings-navigation" aria-label="设置分类"></nav>
      </div>
      <div class="panel-footer"><span class="local-indicator"></span>本地工作空间</div>
    </aside>
    <div
      id="resizer"
      class="resizer"
      role="separator"
      aria-label="调整会话栏宽度"
      aria-orientation="vertical"
      tabindex="0"
    ></div>
    <section id="chat-panel" class="chat-panel" aria-label="对话">
      <header class="chat-header">
        <div class="chat-heading">
          <button id="open-drawer" class="icon-button" aria-label="打开会话列表">
            ${icon('sidebar')}
          </button>
          <div>
            <div class="breadcrumb" id="breadcrumb"></div>
            <h2 id="conversation-title">新对话</h2>
          </div>
        </div>
        <div class="chat-actions">
          <span id="connection-status" class="status-pill"></span
          ><button id="connect-session" class="quiet-button">连接会话</button
          ><button
            id="disconnect-session"
            class="icon-button"
            aria-label="断开当前会话"
            title="断开当前会话"
          >
            ${icon('disconnect')}
          </button>
        </div>
      </header>
      <div id="messages" class="messages" role="log" aria-label="对话消息">
        <div id="empty" class="empty">
          <div class="welcome-symbol">${icon('sparkle')}</div>
          <p class="eyebrow" id="welcome-agent"></p>
          <h2>有什么想一起完成的？</h2>
          <p>从一个问题开始，让思路慢慢展开。</p>
          <div class="suggestions">
            <button data-suggestion="请介绍这个项目的目录结构和主要模块。">
              ${icon('folder')}了解这个项目</button
            ><button data-suggestion="请先了解项目，再与我一起梳理下一步的实现思路。">
              ${icon('chat')}梳理实现思路
            </button>
          </div>
        </div>
        <div id="transcript" class="transcript"></div>
      </div>
      <div class="composer-region">
        <button id="new-content" class="new-content" hidden>回到底部 · 有新内容</button>
        <section id="permissions" class="permissions" aria-label="待处理审批" hidden></section>
        <div id="save-error" class="save-error" role="alert" hidden></div>
        <div id="session-auth" class="session-auth"></div>
        <div id="session-hint" class="session-hint"></div>
        <form id="composer" class="composer glass">
          <label class="sr-only" for="prompt">消息</label
          ><textarea
            id="prompt"
            placeholder="描述你的想法，或交给 Agent 一个任务…"
            rows="2"
          ></textarea>
          <div class="composer-footer">
            <div id="session-options" class="session-options" aria-label="会话选项"></div>
            <div class="composer-actions">
              <button type="button" id="cancel" class="stop-button" hidden>
                ${icon('stop')}停止</button
              ><button type="submit" id="send" class="send-button">发送</button>
            </div>
          </div>
          <div id="config-status" class="config-status" role="status"></div>
          <div id="config-error" class="config-error" role="alert" hidden></div>
        </form>
        <p class="composer-note">Agent 的操作以当前项目和实际权限为准，请检查重要结果。</p>
      </div>
    </section>
    <section id="settings-panel" class="settings-panel" aria-label="设置内容" hidden>
      <header class="settings-header">
        <button id="open-settings-drawer" class="icon-button" aria-label="打开设置分类">
          ${icon('sidebar')}
        </button>
        <div>
          <div class="breadcrumb">设置</div>
          <h2 id="settings-title" tabindex="-1"></h2>
        </div>
      </header>
      <div id="settings-content" class="settings-content"></div>
    </section>
    <dialog id="dialog" class="glass">
      <div class="dialog-header">
        <h2 id="dialog-title"></h2>
        <button id="close-dialog" class="icon-button" aria-label="关闭">${icon('close')}</button>
      </div>
      <div id="dialog-body"></div>
    </dialog>
  </main>`;
}
