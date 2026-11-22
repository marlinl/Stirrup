import { el } from '../dom';
let dialogReturn: HTMLElement | null = null;
/** Open a focus-managed native modal without navigating to a third page. */
export function openDialog(title: string, html: string): void {
  const dialog = el<HTMLDialogElement>('dialog');
  if (!dialog.open) dialogReturn = document.activeElement as HTMLElement;
  el('dialog-title').textContent = title;
  el('dialog-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

/** Bind closing and focus return once for the currently mounted dialog host. */
export function installDialog(): void {
  dialogReturn = null;
  el('close-dialog').addEventListener('click', () => el<HTMLDialogElement>('dialog').close());
  el('dialog').addEventListener('close', () => dialogReturn?.focus());
}
