import { randomUUID } from 'node:crypto';
import type { Check, CoverageResult, Overview, Stage } from '../shared/types.js';
import type { Config } from './config.js';
import type { Database } from './database.js';
import { AppError, errors, type ErrorCode } from './errors.js';

type Row = {
  id: string;
  serial: string;
  status: Check['status'];
  stage: Stage;
  attempts: number;
  result: CoverageResult | null;
  error_code: ErrorCode | null;
  created_at: Date | string;
  finished_at: Date | string | null;
  lease_token: string | null;
};
const iso = (value: Date | string) => new Date(value).toISOString();
export const publicCheck = (r: Row): Check => ({
  id: r.id,
  serial: r.serial,
  status: r.status,
  stage: r.stage,
  attempts: r.attempts,
  result: r.result,
  errorCode: r.error_code,
  errorMessage: r.error_code ? (errors[r.error_code] ?? errors.INTERNAL_ERROR) : null,
  createdAt: iso(r.created_at),
  finishedAt: r.finished_at ? iso(r.finished_at) : null,
});

export class Repository {
  constructor(
    public db: Database,
    public config: Config,
  ) {}

  async enqueue(serial: string, key: string): Promise<{ check: Check; reused: boolean }> {
    return this.db.transaction(async (sql) => {
      // A short database lock makes global quotas and duplicate prevention atomic across web replicas.
      await sql.query('SELECT pg_advisory_xact_lock(710432)');
      const prior = (await sql.query<Row>('SELECT * FROM checks WHERE idempotency_key=$1', [key]))
        .rows[0];
      if (prior) {
        if (prior.serial !== serial)
          throw Object.assign(new Error('Ten klucz żądania został już użyty dla innego SN.'), {
            statusCode: 409,
          });
        return { check: publicCheck(prior), reused: true };
      }
      const active = (
        await sql.query<Row>(
          "SELECT * FROM checks WHERE serial=$1 AND status IN ('queued','running')",
          [serial],
        )
      ).rows[0];
      if (active) return { check: publicCheck(active), reused: true };
      const counts = (
        await sql.query<{ today: string; pending: string }>(`SELECT
        count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today,
        count(*) FILTER (WHERE status IN ('queued','running')) AS pending FROM checks`)
      ).rows[0];
      if (Number(counts.today) >= this.config.MAX_CHECKS_PER_DAY)
        throw new AppError('DAILY_LIMIT', 429);
      if (Number(counts.pending) >= this.config.MAX_PENDING_CHECKS)
        throw new AppError('QUEUE_FULL', 429);
      const row = (
        await sql.query<Row>(
          'INSERT INTO checks(id,serial,idempotency_key) VALUES($1,$2,$3) RETURNING *',
          [randomUUID(), serial, key],
        )
      ).rows[0];
      return { check: publicCheck(row), reused: false };
    });
  }
  async get(id: string): Promise<Check | null> {
    const row = (await this.db.query<Row>('SELECT * FROM checks WHERE id=$1', [id])).rows[0];
    return row ? publicCheck(row) : null;
  }
  async list(search: string, status: string, page: number) {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`serial LIKE $${values.length}`);
    }
    if (status) {
      values.push(status);
      clauses.push(`status=$${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = (
      await this.db.query<{ count: string }>(`SELECT count(*) FROM checks ${where}`, values)
    ).rows[0];
    const rows = (
      await this.db.query<Row>(
        `SELECT * FROM checks ${where} ORDER BY created_at DESC, id DESC LIMIT 25 OFFSET $${values.length + 1}`,
        [...values, (page - 1) * 25],
      )
    ).rows;
    return { items: rows.map(publicCheck), total: Number(count.count), page, pageSize: 25 };
  }
  async overview(demo = false): Promise<Overview> {
    const r = (
      await this.db.query<Record<string, string>>(`SELECT count(*) AS total,
      count(*) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today,
      count(*) FILTER (WHERE status='completed') AS completed,
      count(*) FILTER (WHERE status='failed') AS failed,
      count(*) FILTER (WHERE status IN ('queued','running')) AS pending FROM checks`)
    ).rows[0];
    const usage = (
      await this.db.query<{ count: number }>(
        "SELECT count FROM captcha_usage WHERE day=(now() AT TIME ZONE 'UTC')::date",
      )
    ).rows[0];
    return {
      total: Number(r.total),
      today: Number(r.today),
      completed: Number(r.completed),
      failed: Number(r.failed),
      pending: Number(r.pending),
      dailyLimit: this.config.MAX_CHECKS_PER_DAY,
      captchaToday: usage?.count ?? 0,
      captchaDailyLimit: this.config.MAX_CAPTCHAS_PER_DAY,
      integrations: {
        captcha: !!this.config.TWOCAPTCHA_API_KEY,
        proxy: !!(
          this.config.PROXY_SERVER &&
          this.config.PROXY_USERNAME &&
          this.config.PROXY_PASSWORD
        ),
        worker: await this.workerOnline(),
      },
      demo,
    };
  }
  async workerOnline() {
    return (
      (
        await this.db.query(
          "SELECT id FROM worker_heartbeats WHERE seen_at > now()-interval '45 seconds' LIMIT 1",
        )
      ).rows.length > 0
    );
  }
  async workerHeartbeat(id: string) {
    await this.db.query(
      'INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET seen_at=now()',
      [id],
    );
  }
  async recover() {
    await this.db
      .query(`UPDATE checks SET status=CASE WHEN attempts >= 2 THEN 'failed' ELSE 'queued' END,
      stage=CASE WHEN attempts >= 2 THEN 'done' ELSE 'queued' END,
      error_code=CASE WHEN attempts >= 2 THEN 'WORKER_INTERRUPTED' ELSE NULL END,
      finished_at=CASE WHEN attempts >= 2 THEN now() ELSE NULL END,
      updated_at=now(),lease_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until < now()`);
  }
  async claim(): Promise<{ id: string; serial: string; token: string } | null> {
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(710433)');
      const active = (
        await sql.query<{ count: string }>(
          "SELECT count(*) FROM checks WHERE status='running' AND lease_until>now()",
        )
      ).rows[0];
      if (Number(active.count) >= this.config.WORKER_CONCURRENCY) return null;
      const throttle = await sql.query(
        "SELECT id FROM queue_state WHERE last_started IS NULL OR last_started < now()-($1::double precision*interval '1 millisecond')",
        [this.config.MIN_CHECK_INTERVAL_MS],
      );
      if (!throttle.rows.length) return null;
      const token = randomUUID();
      const row = (
        await sql.query<Row>(
          `UPDATE checks SET status='running',stage='opening',attempts=attempts+1,
        lease_token=$1,lease_until=now()+interval '60 seconds',updated_at=now()
        WHERE id=(SELECT id FROM checks WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [token],
        )
      ).rows[0];
      if (!row) return null;
      await sql.query('UPDATE queue_state SET last_started=now() WHERE id=1');
      return { id: row.id, serial: row.serial, token };
    });
  }
  async renew(id: string, token: string) {
    return (
      (
        await this.db.query(
          "UPDATE checks SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id",
          [id, token],
        )
      ).rows.length === 1
    );
  }
  async stage(id: string, token: string, stage: Stage) {
    const r = await this.db.query(
      "UPDATE checks SET stage=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id",
      [id, token, stage],
    );
    if (!r.rows.length) throw new AppError('WORKER_INTERRUPTED');
  }
  async finish(id: string, token: string, result: CoverageResult | null, error: ErrorCode | null) {
    return (
      (
        await this.db.query(
          `UPDATE checks SET status=$3, stage='done', result=$4::jsonb,error_code=$5,
      finished_at=now(),updated_at=now(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id`,
          [
            id,
            token,
            error ? 'failed' : 'completed',
            result ? JSON.stringify(result) : null,
            error,
          ],
        )
      ).rows.length === 1
    );
  }
  async reserveCaptcha() {
    const r = await this.db.query(
      `INSERT INTO captcha_usage(day,count) VALUES((now() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(day) DO UPDATE SET count=captcha_usage.count+1 WHERE captcha_usage.count<$1 RETURNING count`,
      [this.config.MAX_CAPTCHAS_PER_DAY],
    );
    if (!r.rows.length) throw new AppError('CAPTCHA_LIMIT', 429);
  }
  async rateLimit(key: string, max: number, seconds: number) {
    const r = (
      await this.db.query<{ count: number }>(
        `INSERT INTO rate_limits(key,window_start,count)
      VALUES($1,to_timestamp(floor(extract(epoch FROM now())/$2)*$2),1)
      ON CONFLICT(key,window_start) DO UPDATE SET count=rate_limits.count+1 RETURNING count`,
        [key, seconds],
      )
    ).rows[0];
    return r.count <= max;
  }
  async cleanupEphemeral() {
    await this.db.query(
      "DELETE FROM sessions WHERE expires_at<now(); DELETE FROM rate_limits WHERE window_start<now()-interval '1 day'; DELETE FROM worker_heartbeats WHERE seen_at<now()-interval '1 day'",
    );
  }
}
