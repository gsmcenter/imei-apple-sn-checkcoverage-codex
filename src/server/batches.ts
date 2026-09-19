import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_BATCH_SIZE,
  parseSerials,
  type Batch,
  type BatchDetail,
  type BatchItem,
  type BatchState,
} from '../shared/batches.js';
import { Repository, publicCheck } from './repository.js';
import { AppError } from './errors.js';

function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode, publicMessage: message });
}
const summary = `SELECT b.*,
 count(i.position)::int AS total,
 count(*) FILTER(WHERE i.check_id IS NULL AND NOT i.cancelled)::int AS waiting,
 count(*) FILTER(WHERE c.status='queued')::int AS queued,
 count(*) FILTER(WHERE c.status='running')::int AS running,
 count(*) FILTER(WHERE c.status='completed')::int AS completed,
 count(*) FILTER(WHERE c.status='failed')::int AS failed,
 count(*) FILTER(WHERE i.cancelled)::int AS cancelled,
 avg((c.runs->-1->>'durationMs')::double precision) FILTER(WHERE c.status='completed') AS average_ms
 FROM batches b JOIN batch_items i ON i.batch_id=b.id LEFT JOIN checks c ON c.id=i.check_id`;
type BatchRow = Omit<Batch, 'createdAt' | 'sourceId' | 'averageMs'> & {
  created_at: string | Date;
  source_id: string | null;
  average_ms: number | null;
};
const mapBatch = (r: BatchRow): Batch => ({
  id: r.id,
  name: r.name,
  notes: r.notes,
  state: r.state,
  createdAt: new Date(r.created_at).toISOString(),
  sourceId: r.source_id,
  total: r.total,
  waiting: r.waiting,
  queued: r.queued,
  running: r.running,
  completed: r.completed,
  failed: r.failed,
  cancelled: r.cancelled,
  duplicates: r.duplicates,
  invalid: r.invalid,
  averageMs: r.average_ms == null ? null : Number(r.average_ms),
});
export interface BatchInput {
  name: string;
  notes: string;
  text: string;
  ignoreInvalid: boolean;
  paused: boolean;
}

export class BatchRepository {
  constructor(private repo: Repository) {}
  async create(
    input: BatchInput,
    key: string,
    sourceId: string | null = null,
  ): Promise<{ id: string; reused: boolean }> {
    const hash = createHash('sha256')
      .update(JSON.stringify({ ...input, sourceId }))
      .digest('hex');
    return this.repo.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(710432)');
      const prior = (
        await sql.query<{ id: string; request_hash: string }>(
          'SELECT id,request_hash FROM batches WHERE idempotency_key=$1',
          [key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) fail('Klucz żądania został użyty dla innej paczki.', 409);
        return { id: prior.id, reused: true };
      }
      let parsed = parseSerials(input.text);
      if (sourceId) {
        if (!(await sql.query('SELECT id FROM batches WHERE id=$1', [sourceId])).rows.length)
          fail('Nie znaleziono paczki.', 404);
        const failed = (
          await sql.query<{ serial: string }>(
            `SELECT i.serial FROM batch_items i JOIN checks c ON c.id=i.check_id WHERE i.batch_id=$1 AND c.status='failed' ORDER BY i.position`,
            [sourceId],
          )
        ).rows;
        parsed = parseSerials(failed.map((i) => i.serial).join('\n'));
      }
      if (parsed.invalid.length && !input.ignoreInvalid)
        fail('Popraw błędne numery lub zaznacz pominięcie niepoprawnych wpisów.');
      if (!parsed.serials.length || parsed.serials.length > MAX_BATCH_SIZE)
        fail(`Paczka musi zawierać od 1 do ${MAX_BATCH_SIZE} poprawnych, unikalnych SN.`);
      const backlog = (
        await sql.query<{ count: string }>(
          `SELECT count(*) FROM batch_items WHERE check_id IS NULL AND NOT cancelled`,
        )
      ).rows[0];
      if (Number(backlog.count) + parsed.serials.length > 50000)
        fail('Osiągnięto limit 50 000 oczekujących pozycji paczek.', 429);
      const id = randomUUID();
      await sql.query(
        `INSERT INTO batches(id,name,notes,state,idempotency_key,request_hash,source_id,duplicates,invalid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          input.name.trim(),
          input.notes.trim(),
          input.paused ? 'paused' : 'active',
          key,
          hash,
          sourceId,
          parsed.duplicates,
          parsed.invalid.length,
        ],
      );
      await sql.query(
        `INSERT INTO batch_items(batch_id,position,serial) SELECT $1,ordinality::int,value FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY`,
        [id, JSON.stringify(parsed.serials)],
      );
      return { id, reused: false };
    });
  }
  async list(search: string, page: number) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = (
      await this.repo.db.query<BatchRow>(
        `${summary} WHERE b.id IN (SELECT id FROM batches WHERE name ILIKE $1 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $2) GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC`,
        [pattern, (page - 1) * 25],
      )
    ).rows;
    const total = (
      await this.repo.db.query<{ count: string }>(
        'SELECT count(*) FROM batches WHERE name ILIKE $1',
        [pattern],
      )
    ).rows[0];
    return { items: rows.map(mapBatch), total: Number(total.count), page, pageSize: 25 };
  }
  async get(id: string): Promise<Batch> {
    const row = (await this.repo.db.query<BatchRow>(`${summary} WHERE b.id=$1 GROUP BY b.id`, [id]))
      .rows[0];
    if (!row) fail('Nie znaleziono paczki.', 404);
    return mapBatch(row);
  }
  async detail(id: string, search = '', status = '', page = 1, all = false): Promise<BatchDetail> {
    const batch = await this.get(id);
    const where = `i.batch_id=$1 AND i.serial LIKE $2 AND ($3='' OR CASE WHEN i.cancelled THEN 'cancelled' WHEN i.check_id IS NULL THEN 'waiting' ELSE c.status END=$3)`;
    const values = [id, `%${search}%`, status];
    const total = (
      await this.repo.db.query<{ count: string }>(
        `SELECT count(*) FROM batch_items i LEFT JOIN checks c ON c.id=i.check_id WHERE ${where}`,
        values,
      )
    ).rows[0];
    const rows = (
      await this.repo.db.query<{
        position: number;
        serial: string;
        cancelled: boolean;
        check: Parameters<typeof publicCheck>[0] | null;
      }>(
        `SELECT i.position,i.serial,i.cancelled,CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c)-'diagnostics' END AS check FROM batch_items i LEFT JOIN checks c ON c.id=i.check_id WHERE ${where} ORDER BY i.position LIMIT $4 OFFSET $5`,
        [...values, all ? MAX_BATCH_SIZE : 50, all ? 0 : (page - 1) * 50],
      )
    ).rows;
    const items: BatchItem[] = rows.map((r) => ({
      position: r.position,
      serial: r.serial,
      status: r.cancelled ? 'cancelled' : (r.check?.status ?? 'waiting'),
      check: r.check ? publicCheck(r.check) : null,
    }));
    return { batch, items, total: Number(total.count), page, pageSize: all ? MAX_BATCH_SIZE : 50 };
  }
  async update(id: string, patch: { name?: string; notes?: string; state?: BatchState }) {
    await this.repo.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(710432)');
      const row = (
        await sql.query<{ state: BatchState }>('SELECT state FROM batches WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (!row) fail('Nie znaleziono paczki.', 404);
      if (row.state === 'cancelled' && patch.state && patch.state !== 'cancelled')
        fail('Anulowanej paczki nie można wznowić. Utwórz nową paczkę.', 409);
      await sql.query(
        'UPDATE batches SET name=coalesce($2,name),notes=coalesce($3,notes),state=coalesce($4,state) WHERE id=$1',
        [id, patch.name?.trim() ?? null, patch.notes?.trim() ?? null, patch.state ?? null],
      );
      if (patch.state === 'cancelled')
        await sql.query(
          'UPDATE batch_items SET cancelled=true WHERE batch_id=$1 AND check_id IS NULL',
          [id],
        );
    });
    return this.get(id);
  }
  async dispatch() {
    // Share the enqueue quota lock with single checks, every replica, pause and cancellation.
    for (let n = 0; n < 10; n++) {
      const added = await this.repo.db.transaction(async (sql) => {
        await sql.query('SELECT pg_advisory_xact_lock(710432)');
        const item = (
          await sql.query<{ batch_id: string; position: number; serial: string }>(
            `SELECT i.batch_id,i.position,i.serial FROM batch_items i JOIN batches b ON b.id=i.batch_id WHERE b.state='active' AND i.check_id IS NULL AND NOT i.cancelled ORDER BY b.last_dispatched,b.created_at,b.id,i.position LIMIT 1 FOR UPDATE OF b,i`,
            [],
          )
        ).rows[0];
        if (!item) return false;
        try {
          const result = await this.repo.enqueueIn(sql, item.serial, randomUUID());
          await sql.query('UPDATE batch_items SET check_id=$3 WHERE batch_id=$1 AND position=$2', [
            item.batch_id,
            item.position,
            result.check.id,
          ]);
          await sql.query('UPDATE batches SET last_dispatched=clock_timestamp() WHERE id=$1', [
            item.batch_id,
          ]);
          return true;
        } catch (e) {
          if (e instanceof AppError && ['QUEUE_FULL', 'DAILY_LIMIT'].includes(e.code)) return false;
          throw e;
        }
      });
      if (!added) break;
    }
  }
}

export function batchCsv(detail: BatchDetail): string {
  const cell = (value: unknown) => {
    let s = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const rows: unknown[][] = [
    [
      'Paczka',
      'Pozycja',
      'SN',
      'Status',
      'Model',
      'Ochrona',
      'Koniec ochrony',
      'Zakup',
      'Kod błędu',
      'Opis błędu',
      'Proxy (ostatnia próba)',
      'Solver (ostatnia próba)',
      'Czas ostatniej próby ms',
      'CAPTCHA ostatniej próby ms',
      'Liczba prób',
      'ID sprawdzenia',
      'Zlecono',
      'Zakończono',
      'Apple ms (ostatnia próba)',
      'Sesje (ostatnia próba)',
      'Limity (ostatnia próba)',
    ],
  ];
  for (const i of detail.items) {
    const c = i.check,
      r = c?.runs?.at(-1);
    rows.push([
      detail.batch.name,
      i.position,
      i.serial,
      i.status,
      c?.result?.model,
      c?.result?.coverageLabel,
      c?.result?.expirationDate,
      c?.result?.purchaseDate,
      c?.errorCode,
      c?.errorMessage,
      r?.proxy,
      r?.solver,
      r?.durationMs,
      r?.captchaMs,
      c?.attempts,
      c?.id,
      c?.createdAt,
      c?.finishedAt,
      r?.appleMs,
      r?.sessions,
      r?.rateLimits,
    ]);
  }
  return '\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}
