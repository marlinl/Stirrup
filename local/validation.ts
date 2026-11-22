import { HttpError } from './errors.ts';

/** Validate bounded strings without converting untrusted values to filesystem or command inputs. */
export function string(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    throw new HttpError(400, '字段格式无效');
  return value;
}
