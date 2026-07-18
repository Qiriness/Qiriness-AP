import { createHash } from 'node:crypto';

export function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
