import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '../src/server/database.js';

// Development/test only. Production always uses the external PostgreSQL service.
export async function embeddedDatabase(): Promise<Database> {
  const engine = new PGlite();
  await engine.waitReady;
  function adapter(target: Pick<PGlite, 'query' | 'exec'>): Sql {
    return {
      async query<T>(text: string, values?: unknown[]) {
        if (!values && text.split(';').filter((s) => s.trim()).length > 1) {
          const result = await target.exec(text);
          return { rows: (result.at(-1)?.rows ?? []) as T[] };
        }
        const result = await target.query<T>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows };
      },
    };
  }
  return {
    ...adapter(engine),
    transaction: (fn) => engine.transaction((tx) => fn(adapter(tx))),
    close: () => engine.close(),
  };
}
