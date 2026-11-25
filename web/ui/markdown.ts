import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Escape literal text when raw HTML appears in an agent message. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!,
  );
}
marked.use({
  renderer: {
    /** Keep raw agent-provided HTML as visible text, never executable markup. */
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

/** Render safe Markdown without remote images, form controls or executable HTML. */
export function markdown(text: string): string {
  if (!DOMPurify.isSupported) return escapeHtml(text);
  return DOMPurify.sanitize(marked.parse(text, { async: false }), {
    FORBID_TAGS: ['img', 'svg', 'style', 'iframe', 'form', 'input', 'button', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
}
