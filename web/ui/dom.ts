/** Find a required element in the mounted page. */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

let toastTimer: ReturnType<typeof setTimeout>;
/** Surface failures without replacing unsent drafts or conversation content. */
export function toast(text: string): void {
  clearTimeout(toastTimer);
  el('toast').textContent = text;
  el('toast').hidden = false;
  toastTimer = setTimeout(() => {
    el('toast').hidden = true;
  }, 7000);
}

/** Consume action failures so DOM callbacks never leak unhandled promise rejections. */
export async function run(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    toast(error instanceof Error ? error.message : '操作未完成');
  }
}
