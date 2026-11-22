import codexLight from './assets/codex-light.png';
import codexDark from './assets/codex-dark.png';
import dsh from './assets/dsh.svg';

const paths = {
  logo: '<path d="M7 5h10v4l-2 2v6a3 3 0 0 1-6 0v-6L7 9Z"/><path d="M9 15h6M7 5V3m10 2V3"/>',
  settings:
    '<path d="m9 4 1-2h4l1 2 2 1 2-.1 2 3-1 2v3l1 2-2 3h-2l-2 1-1 2h-4l-1-2-2-1H5l-2-3 1-2v-3L3 8l2-3 2 .1Z"/><circle cx="12" cy="11.5" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder:
    '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chat: '<path d="M20 11a8 8 0 0 1-8 8H5l-3 3v-11a9 9 0 0 1 18 0Z"/><path d="M7 10h8m-8 4h5"/>',
  sliders:
    '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  disconnect:
    '<path d="m8 5 2 2m4 10 2 2m-9-9 10 10m-3-9 3-3m-1-3 4 4M8 13l-3 3m-1-2 4 4M4 4l16 16"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
} as const;

/** Render curated vector paths; agent or user strings never become SVG markup. */
export function icon(name: keyof typeof paths | 'codex' | 'dsh'): string {
  if (name === 'codex')
    return `<span class="brand-codex" aria-hidden="true"><img class="brand-light" src="${codexLight}" alt=""><img class="brand-dark" src="${codexDark}" alt=""></span>`;
  if (name === 'dsh') return `<img class="brand-dsh" src="${dsh}" alt="" aria-hidden="true">`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
