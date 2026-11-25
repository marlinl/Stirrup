/** Clamp desktop sidebar width to 20% by default, at most 50%, reserving room for conversation content. */
export function sidebarWidth(width: number, ratio: number): number {
  const maximum = Math.max(0, Math.min(width * 0.5, width - 64 - 40 - 420));
  return Math.max(
    Math.min(200, maximum),
    Math.min(Number.isFinite(ratio) ? ratio * width : width * 0.2, maximum),
  );
}
