import type { Check } from './types.js';

export const MAX_BATCH_SIZE = 5000;
export const MAX_IMPORT_BYTES = 250000;
export function parseSerials(text: string) {
  const tokens = text
    .replace(/^\uFEFF/, '')
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^"|"$/g, '').toUpperCase())
    .filter(Boolean);
  if (['SN', 'SERIAL', 'SERIAL_NUMBER'].includes(tokens[0])) tokens.shift();
  const serials: string[] = [],
    invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const token of tokens) {
    if (!/^[A-Z0-9]{8,12}$/.test(token) || /^\d+$/.test(token)) invalid.push(token);
    else if (seen.has(token)) duplicates++;
    else {
      seen.add(token);
      serials.push(token);
    }
  }
  return { serials, invalid, duplicates, total: tokens.length };
}
export type BatchState = 'active' | 'paused' | 'cancelled';
export interface Batch {
  id: string;
  name: string;
  notes: string;
  state: BatchState;
  createdAt: string;
  sourceId: string | null;
  total: number;
  waiting: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  duplicates: number;
  invalid: number;
  averageMs: number | null;
}
export interface BatchItem {
  position: number;
  serial: string;
  status: 'waiting' | 'cancelled' | Check['status'];
  check: Check | null;
}
export interface BatchDetail {
  batch: Batch;
  items: BatchItem[];
  total: number;
  page: number;
  pageSize: number;
}
export const batchStatus = (b: Batch) =>
  b.waiting + b.queued + b.running === 0
    ? b.cancelled
      ? 'Zakończona z anulowanymi pozycjami'
      : b.failed
        ? 'Zakończona z błędami'
        : 'Zakończona'
    : b.state === 'paused'
      ? 'Wstrzymana'
      : b.state === 'cancelled'
        ? 'Anulowanie pozostałych'
        : 'W realizacji';
export const itemStatus = {
  waiting: 'Oczekuje na kolejkę',
  queued: 'W kolejce',
  running: 'W trakcie',
  completed: 'Ukończono',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};
