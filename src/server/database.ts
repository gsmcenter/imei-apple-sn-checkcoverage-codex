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
`;

export async function migrate(db: Database): Promise<void> {
  await db.transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(710431)');
    await sql.query(migration);
  });
}
