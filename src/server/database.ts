import pg from 'pg';
export interface SqlResult<T> {
  rows: T[];
  rowCount?: number | null;
}
export interface Sql {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<SqlResult<T>>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function connectDatabase(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  pool.on('error', () => console.error('Database connection error'));
  return {
    query: async <T>(text: string, values?: unknown[]) => {
      const result = await pool.query(text, values);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export const migration = `
CREATE TABLE IF NOT EXISTS checks (
 id UUID PRIMARY KEY, serial TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')) DEFAULT 'queued',
 stage TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 result JSONB, error_code TEXT, idempotency_key UUID UNIQUE,
 lease_token UUID, lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS checks_active_serial ON checks(serial) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS checks_history ON checks(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS checks_serial_history ON checks(serial, created_at DESC);
CREATE INDEX IF NOT EXISTS checks_queue ON checks(status, created_at);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, window_start TIMESTAMPTZ NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key, window_start));
CREATE TABLE IF NOT EXISTS captcha_usage (day DATE PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS worker_heartbeats (id UUID PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS queue_state (id INTEGER PRIMARY KEY, last_started TIMESTAMPTZ);
INSERT INTO queue_state (id, last_started) VALUES (1, NULL) ON CONFLICT DO NOTHING;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS runs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS system_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), proxy_mode TEXT NOT NULL,
 solver_id TEXT NOT NULL DEFAULT '2captcha', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS captcha_measurements (
 id UUID PRIMARY KEY, check_id UUID NOT NULL REFERENCES checks(id), token UUID NOT NULL,
 solver TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 duration_ms DOUBLE PRECISION, outcome TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS captcha_measurements_check ON captcha_measurements(check_id);
CREATE TABLE IF NOT EXISTS batches (
 id UUID PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','cancelled')),
 idempotency_key UUID NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 source_id UUID REFERENCES batches(id), duplicates INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_dispatched TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS batch_items (
 batch_id UUID NOT NULL REFERENCES batches(id), position INTEGER NOT NULL, serial TEXT NOT NULL,
 check_id UUID REFERENCES checks(id), cancelled BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(batch_id,position), UNIQUE(batch_id,serial)
);
CREATE INDEX IF NOT EXISTS batch_items_waiting ON batch_items(batch_id,position) WHERE check_id IS NULL AND NOT cancelled;
CREATE INDEX IF NOT EXISTS batch_items_check ON batch_items(check_id);
CREATE INDEX IF NOT EXISTS batches_history ON batches(created_at DESC,id DESC);
ALTER TABLE checks ADD COLUMN IF NOT EXISTS selected_proxy TEXT;
CREATE TABLE IF NOT EXISTS apple_sessions (
 id UUID PRIMARY KEY,check_id UUID NOT NULL REFERENCES checks(id),token UUID NOT NULL,proxy TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),finished_at TIMESTAMPTZ,
 apple_ms DOUBLE PRECISION,limited BOOLEAN NOT NULL DEFAULT false,limit_stage TEXT,
 exit_ip TEXT,stages TEXT[] NOT NULL DEFAULT ARRAY['opening']::text[],
 concurrency INTEGER NOT NULL,queued INTEGER NOT NULL,outcome TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS apple_sessions_check ON apple_sessions(check_id,token);
`;

export async function migrate(db: Database): Promise<void> {
  await db.transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(710431)');
    await sql.query(migration);
  });
}
