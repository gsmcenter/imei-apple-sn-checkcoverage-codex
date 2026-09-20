import type { Database } from './database.js';
import type { LimitMetric, ProxyPerformance } from '../shared/system.js';
export async function proxyStatistics(db: Database, since: string | null = null) {
  const window = [since];
  const checkWindow =
    'EXISTS(SELECT 1 FROM checks c WHERE c.id=apple_sessions.check_id AND ($1::timestamptz IS NULL OR c.created_at >= $1::timestamptz))';
  const rows = (
    await db.query<Record<string, string | null>>(
      `WITH measured AS (
    SELECT check_id,proxy,sum(apple_ms) AS ms,count(*) AS sessions,count(*) FILTER(WHERE limited) AS limits FROM apple_sessions WHERE ${checkWindow} GROUP BY check_id,proxy
  ) SELECT m.proxy AS name,count(*) AS total,count(*) FILTER(WHERE c.status='completed') AS completed,count(*) FILTER(WHERE c.status='failed') AS failed,
    avg(m.ms) FILTER(WHERE c.status='completed') AS average,percentile_cont(0.5) WITHIN GROUP(ORDER BY m.ms) FILTER(WHERE c.status='completed') AS median,
    sum(m.sessions) AS sessions,sum(m.limits) AS limits,count(*) FILTER(WHERE c.error_code IN ('PROXY_ERROR','PROXY_AUTH','PROXY_REMOVED')) AS proxy_errors
    FROM measured m JOIN checks c ON c.id=m.check_id GROUP BY m.proxy`,
      window,
    )
  ).rows;
  const proxyPerformance: ProxyPerformance[] = rows.map((r) => ({
    name: r.name!,
    total: Number(r.total),
    completed: Number(r.completed),
    failed: Number(r.failed),
    averageMs: r.average == null ? null : Number(r.average),
    medianMs: r.median == null ? null : Number(r.median),
    sessions: Number(r.sessions),
    limits: Number(r.limits),
    proxyErrors: Number(r.proxy_errors),
  }));
  const limits: LimitMetric[] = [];
  for (const dimension of ['proxy', 'concurrency', 'stage', 'hour'] as const) {
    const expr =
      dimension === 'proxy'
        ? 'proxy'
        : dimension === 'concurrency'
          ? 'concurrency::text'
          : dimension === 'stage'
            ? 'stage'
            : "to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:00')";
    const rs = (
      await db.query<{ name: string; sessions: string; limited: string }>(
        `SELECT ${expr} AS name,count(*) AS sessions,count(*) FILTER(WHERE limited ${dimension === 'stage' ? 'AND limit_stage=stage' : ''}) AS limited FROM apple_sessions ${dimension === 'stage' ? 'CROSS JOIN LATERAL unnest(stages) AS stage' : ''} WHERE ${checkWindow} GROUP BY ${expr} ORDER BY name DESC ${dimension === 'hour' ? 'LIMIT 168' : ''}`,
        window,
      )
    ).rows;
    limits.push(
      ...rs.map((r) => ({
        dimension,
        name: r.name,
        sessions: Number(r.sessions),
        limited: Number(r.limited),
      })),
    );
  }
  return { proxyPerformance, limits };
}
