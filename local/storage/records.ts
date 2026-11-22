import type { Message } from '../../src/domain/models.ts';
import { HttpError } from '../errors.ts';
import { string } from '../validation.ts';

/** Validate a bounded saved message while retaining optional ACP tool details. */
export function parseMessage(item: unknown): Message {
  if (!item || typeof item !== 'object') throw new HttpError(400, '消息格式无效');
  const row = item as Record<string, unknown>;
  if (
    !['user', 'assistant', 'thought', 'tool', 'plan', 'notice', 'error', 'event'].includes(
      String(row.kind),
    )
  )
    throw new HttpError(400, '消息类型无效');
  return {
    id: string(row.id, 128),
    kind: row.kind as Message['kind'],
    text: string(row.text, 1_000_000, true),
    ...(row.title !== undefined ? { title: string(row.title, 2000, true) } : {}),
    ...(row.status !== undefined ? { status: string(row.status, 128, true) } : {}),
    ...(row.toolCallId !== undefined ? { toolCallId: string(row.toolCallId, 256) } : {}),
    ...(row.details && typeof row.details === 'object' && !Array.isArray(row.details)
      ? { details: row.details as Record<string, unknown> }
      : {}),
  };
}
