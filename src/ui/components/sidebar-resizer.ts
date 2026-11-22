import { el } from '../dom';
import { sidebarWidth } from '../layout';
import { savePreferences, type Preferences } from '../../app/preferences';
/** Open the mobile session drawer without changing desktop width preferences. */
export function drawer(open: boolean): void {
  el('workspace').classList.toggle('drawer-open', open);
  el('drawer-backdrop').hidden = !open;
}
/** Mount sidebar resize interactions and return the explicit window/settings resize action. */
export function createSidebarResizer(preferences: Preferences): () => void {
  /** Measure the actual grid content box, excluding page padding from percentage calculations. */
  function workspaceWidth(): number {
    const shell = el('workspace');
    const style = getComputedStyle(shell);
    return shell.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
  }

  /** Apply sidebar proportions while retaining usable desktop chat width. */
  function sizeSidebar(): void {
    const shell = el('workspace');
    const width = workspaceWidth();
    const pixels = sidebarWidth(width, preferences.ratio);
    shell.style.setProperty('--sidebar-width', `${pixels}px`);
    el('resizer').setAttribute('aria-valuemin', '200');
    el('resizer').setAttribute('aria-valuemax', String(Math.round(Math.min(width * 0.5, width - 524))));
    el('resizer').setAttribute('aria-valuenow', String(Math.round(pixels)));
    if (window.innerWidth >= 1024) drawer(false);
  }

  /** Handle captured dragging, cancellation rollback, keyboard resizing and default-width reset. */
  function installResizer(): void {
    const handle = el('resizer');
    let startX = 0;
    let startWidth = 0;
    let oldRatio = 0.2;
    let dragging = false;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      startX = event.clientX;
      oldRatio = preferences.ratio;
      startWidth = el('session-panel').getBoundingClientRect().width;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const width = workspaceWidth();
      preferences.ratio = sidebarWidth(width, (startWidth + event.clientX - startX) / width) / width;
      sizeSidebar();
    });
    /** Commit a finished drag, or restore the starting ratio on cancellation. */
    const finish = (cancelled: boolean): void => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      if (cancelled) preferences.ratio = oldRatio;
      savePreferences(preferences);
      sizeSidebar();
    };
    handle.addEventListener('pointerup', () => finish(false));
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish(false));
    handle.addEventListener('dblclick', () => {
      preferences.ratio = 0.2;
      savePreferences(preferences);
      sizeSidebar();
    });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') {
        finish(true);
        return;
      }
      const width = workspaceWidth();
      const current = sidebarWidth(width, preferences.ratio);
      const target =
        event.key === 'Home'
          ? 200
          : event.key === 'End'
            ? width * 0.5
            : current + (event.key === 'ArrowLeft' ? -10 : 10);
      preferences.ratio = sidebarWidth(width, target / width) / width;
      savePreferences(preferences);
      sizeSidebar();
    });
  }
  installResizer();
  sizeSidebar();
  return sizeSidebar;
}
