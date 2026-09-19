import type { SolverId } from '../shared/system.js';
import { randomUUID, randomInt } from 'node:crypto';
import {
  solverIds,
  type SystemSettings,
  type Run,
  type Diagnostic,
  type SystemStatus,
  type Metric,
} from '../shared/system.js';
import type { Check, CoverageResult, Overview, Stage } from '../shared/types.js';
import { solverConfigured, type Config } from './config.js';
import type { Database, Sql } from './database.js';
import { AppError, errors, type ErrorCode } from './errors.js';
import { proxyChoices, redactProxySecrets } from './proxies.js';
import { proxyStatistics } from './proxy-statistics.js';

type Row = {
  selected_proxy: string | null;
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
  runs: Run[];
  diagnostics: Diagnostic[];
};
const iso = (value: Date | string) => new Date(value).toISOString();
export const publicCheck = (r: Row): Check => ({
  id: r.id,
  serial: r.serial,
  status: r.status,
  stage: r.stage,
  attempts: r.attempts,
  runs: r.runs ?? [],
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
    return this.db.transaction((sql) => this.enqueueIn(sql, serial, key));
  }
  async enqueueIn(
    sql: Sql,
    serial: string,
    key: string,
  ): Promise<{ check: Check; reused: boolean }> {
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
  }
  async get(id: string): Promise<Check | null> {
    const row = (await this.db.query<Row>('SELECT * FROM checks WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    const sessions = (
      await this.db.query<NonNullable<Check['proxySessions']>[number]>(
        `SELECT id,proxy,started_at AS "startedAt",finished_at AS "finishedAt",apple_ms AS "appleMs",limited,limit_stage AS stage,concurrency,queued,exit_ip AS "exitIp",outcome FROM apple_sessions WHERE check_id=$1 ORDER BY started_at`,
        [id],
      )
    ).rows;
    return {
      ...publicCheck(row),
      diagnostics: row.diagnostics ?? [],
      proxySessions: sessions.map((s) => ({
        ...s,
        startedAt: iso(s.startedAt),
        finishedAt: s.finishedAt ? iso(s.finishedAt) : null,
      })),
    };
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
        captcha: solverConfigured(this.config, (await this.settings()).solverId),
        proxy: proxyChoices(this.config).length > 0,
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
    await this.db.transaction(async (sql) => {
      const rows = (
        await sql.query<Row>(
          "SELECT * FROM checks WHERE status='running' AND lease_until<now() FOR UPDATE SKIP LOCKED",
        )
      ).rows;
      for (const row of rows) {
        const run = row.runs.find((r) => r.token === row.lease_token);
        if (run) {
          run.status = 'interrupted';
          run.finishedAt = new Date().toISOString();
          const m = (
            await sql.query<{ ms: string; calls: string }>(
              'SELECT coalesce(sum(duration_ms),0) AS ms,count(*) AS calls FROM captcha_measurements WHERE token=$1',
              [row.lease_token],
            )
          ).rows[0];
          run.captchaMs = Number(m.ms);
          run.captchaCalls = Number(m.calls);
        }
        await sql.query(
          `UPDATE checks SET status=CASE WHEN attempts >= 2 THEN 'failed' ELSE 'queued' END,
      stage=CASE WHEN attempts >= 2 THEN 'done' ELSE 'queued' END,
      error_code=CASE WHEN attempts >= 2 THEN 'WORKER_INTERRUPTED' ELSE NULL END,
      finished_at=CASE WHEN attempts >= 2 THEN now() ELSE NULL END,
      updated_at=now(),lease_token=NULL,lease_until=NULL,runs=$2::jsonb,
      diagnostics=diagnostics || $3::jsonb WHERE id=$1`,
          [
            row.id,
            JSON.stringify(row.runs),
            JSON.stringify([
              {
                at: new Date().toISOString(),
                attempt: row.attempts,
                step: 'worker_interrupted',
                message:
                  'Wygasła dzierżawa workera. Czas przerwanej próby nie jest uwzględniany w średniej.',
              },
            ]),
          ],
        );
        await sql.query(
          "UPDATE captcha_measurements SET outcome='interrupted' WHERE check_id=$1 AND token=$2 AND outcome='running'",
          [row.id, row.lease_token],
        );
        await sql.query(
          "UPDATE apple_sessions SET outcome='interrupted',finished_at=now() WHERE check_id=$1 AND token=$2 AND outcome='running'",
          [row.id, row.lease_token],
        );
      }
    });
  }
  async claim(): Promise<{
    id: string;
    serial: string;
    token: string;
    proxy: string;
    solver: SolverId;
    priorRateLimits: number;
  } | null> {
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(710433)');
      const active = (
        await sql.query<{ count: string }>(
          "SELECT count(*) FROM checks WHERE status='running' AND lease_until>now()",
        )
      ).rows[0];
      if (Number(active.count) >= this.config.WORKER_CONCURRENCY) return null;
      const quota = await sql.query(
        "SELECT day FROM captcha_usage WHERE day=(now() AT TIME ZONE 'UTC')::date AND count >= $1",
        [this.config.MAX_CAPTCHAS_PER_DAY],
      );
      if (quota.rows.length) return null;
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
      const settings = await this.settings(sql);
      const choices = proxyChoices(this.config, true);
      const proxy =
        row.selected_proxy ??
        row.runs[0]?.proxy ??
        (settings.proxyMode === 'random'
          ? choices[randomInt(choices.length)].label
          : settings.proxyMode);
      const run: Run = {
        token,
        attempt: row.attempts,
        proxy,
        solver: settings.solverId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        durationMs: null,
        queueMs: Math.max(0, Date.now() - new Date(row.created_at).getTime()),
        captchaMs: 0,
        captchaCalls: 0,
      };
      await sql.query('UPDATE checks SET runs=runs || $2::jsonb,selected_proxy=$3 WHERE id=$1', [
        row.id,
        JSON.stringify([run]),
        proxy,
      ]);
      await sql.query('UPDATE queue_state SET last_started=now() WHERE id=1');
      const priorLimits = (
        await sql.query<{ count: string }>(
          'SELECT count(*) AS count FROM apple_sessions WHERE check_id=$1 AND limited',
          [row.id],
        )
      ).rows[0];
      return {
        id: row.id,
        serial: row.serial,
        token,
        proxy,
        solver: settings.solverId,
        priorRateLimits: Number(priorLimits.count),
      };
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
    return this.db.transaction(async (sql) => {
      const row = (
        await sql.query<Row>(
          "SELECT * FROM checks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
          [id, token],
        )
      ).rows[0];
      if (!row) return false;
      const run = row.runs.find((r) => r.token === token);
      if (run) {
        run.status = error ? 'failed' : 'completed';
        run.finishedAt = new Date().toISOString();
        run.durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
        const m = (
          await sql.query<{ ms: string; calls: string }>(
            'SELECT coalesce(sum(duration_ms),0) AS ms,count(*) AS calls FROM captcha_measurements WHERE token=$1',
            [token],
          )
        ).rows[0];
        run.captchaMs = Number(m.ms);
        run.captchaCalls = Number(m.calls);
        const s = (
          await sql.query<{ ms: string; sessions: string; limits: string }>(
            'SELECT coalesce(sum(apple_ms),0) AS ms,count(*) AS sessions,count(*) FILTER(WHERE limited) AS limits FROM apple_sessions WHERE token=$1',
            [token],
          )
        ).rows[0];
        run.appleMs = Number(s.ms);
        run.sessions = Number(s.sessions);
        run.rateLimits = Number(s.limits);
      }
      await sql.query(
        `UPDATE checks SET status=$3, stage='done', result=$4::jsonb,error_code=$5,
      finished_at=now(),updated_at=now(),lease_token=NULL,lease_until=NULL,runs=$6::jsonb
      WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id`,
        [
          id,
          token,
          error ? 'failed' : 'completed',
          result ? JSON.stringify(result) : null,
          error,
          JSON.stringify(row.runs),
        ],
      );
      return true;
    });
  }
  async settings(sql: Sql = this.db): Promise<SystemSettings> {
    const configured = this.config.PROXY_SERVER ? new URL(this.config.PROXY_SERVER).host : '';
    const choices = proxyChoices(this.config, true);
    const initial =
      choices.find((x) => x.label === configured)?.label ?? choices[0]?.label ?? 'random';
    await sql.query(
      'INSERT INTO system_settings(id,proxy_mode,solver_id) VALUES(1,$1,$2) ON CONFLICT DO NOTHING',
      [
        initial,
        this.config.TWOCAPTCHA_API_KEY || !this.config.CAPTCHAAI_API_KEY ? '2captcha' : 'captchaai',
      ],
    );
    const row = (
      await sql.query<{ proxy_mode: SystemSettings['proxyMode']; solver_id: SolverId }>(
        'SELECT proxy_mode,solver_id FROM system_settings WHERE id=1',
      )
    ).rows[0];
    const proxyMode =
      choices.some((x) => x.label === row.proxy_mode) ||
      (row.proxy_mode === 'random' && choices.length >= 2)
        ? row.proxy_mode
        : initial;
    const solverId = solverIds.includes(row.solver_id) ? row.solver_id : '2captcha';
    if (proxyMode !== row.proxy_mode || solverId !== row.solver_id)
      await sql.query('UPDATE system_settings SET proxy_mode=$1,solver_id=$2 WHERE id=1', [
        proxyMode,
        solverId,
      ]);
    return { proxyMode, solverId };
  }
  async saveSettings(settings: SystemSettings) {
    const choices = proxyChoices(this.config, true);
    if (
      !(
        choices.some((x) => x.label === settings.proxyMode) ||
        (settings.proxyMode === 'random' && choices.length >= 2)
      ) ||
      !solverIds.includes(settings.solverId)
    )
      throw Object.assign(new Error('Unsupported integration'), { statusCode: 400 });
    await this.settings();
    await this.db.query(
      'UPDATE system_settings SET proxy_mode=$1,solver_id=$2,updated_at=now() WHERE id=1',
      [settings.proxyMode, settings.solverId],
    );
    return settings;
  }
  async diagnostic(id: string, token: string, step: string, message: string) {
    let safe = redactProxySecrets(message, this.config);
    for (const secret of [
      this.config.TWOCAPTCHA_API_KEY,
      this.config.CAPTCHAAI_API_KEY,
      this.config.PROXY_PASSWORD,
      this.config.PROXY_USERNAME,
      this.config.SESSION_SECRET,
      this.config.ADMIN_PASSWORD_HASH,
    ])
      if (secret) safe = safe.split(secret).join('[ukryto]');
    safe = safe
      .replace(/data:image\/[^\s]+/g, '[obraz CAPTCHA]')
      .replace(/https?:\/\/[^\s]+/g, '[adres URL]');
    await this.db.query(
      `UPDATE checks SET diagnostics=diagnostics || jsonb_build_array(jsonb_build_object('at',$3::text,'attempt',attempts,'step',$4::text,'message',$5::text))
      WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() AND jsonb_array_length(diagnostics)<100`,
      [id, token, new Date().toISOString(), step.slice(0, 80), safe.slice(0, 1800)],
    );
  }
  async beginCaptcha(id: string, token: string, solver: string) {
    const measurement = randomUUID();
    const result = await this.db.query(
      `INSERT INTO captcha_measurements(id,check_id,token,solver)
      SELECT $3,id,$2,$4 FROM checks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id`,
      [id, token, measurement, solver],
    );
    if (!result.rows.length) throw new AppError('WORKER_INTERRUPTED');
    return measurement;
  }
  async endCaptcha(
    id: string,
    token: string,
    measurement: string,
    durationMs: number,
    outcome: 'completed' | 'failed' | 'rejected',
  ) {
    await this.db.query(
      `UPDATE captcha_measurements SET duration_ms=$4,outcome=$5 WHERE id=$3 AND token=$2
      AND EXISTS(SELECT 1 FROM checks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now())`,
      [id, token, measurement, durationMs, outcome],
    );
  }
  async system(demo = false): Promise<SystemStatus> {
    const proxyStats = await proxyStatistics(this.db);
    const aggregate = (
      await this.db.query<{
        samples: string;
        average: string | null;
        queue: string | null;
      }>(`SELECT count(*) AS samples,
      avg((r->>'durationMs')::double precision) AS average,avg((r->>'queueMs')::double precision) AS queue
      FROM checks CROSS JOIN LATERAL jsonb_array_elements(runs) r WHERE r->>'status'='completed'`)
    ).rows[0];
    const rows = (
      await this.db.query<
        Record<string, string | null>
      >(`SELECT r->>'proxy' AS name,count(*) AS total,
      count(*) FILTER(WHERE r->>'status'='completed') AS completed,
      count(*) FILTER(WHERE r->>'status'='failed') AS failed,count(*) FILTER(WHERE r->>'status'='interrupted') AS interrupted,
      avg((r->>'durationMs')::double precision) FILTER(WHERE r->>'status'='completed') AS average,
      avg((r->>'captchaMs')::double precision) FILTER(WHERE r->>'status'='completed') AS captcha
      FROM checks CROSS JOIN LATERAL jsonb_array_elements(runs) r GROUP BY r->>'proxy'`)
    ).rows;
    const solvers = (
      await this.db.query<Record<string, string | null>>(`SELECT solver AS name,count(*) AS total,
      count(*) FILTER(WHERE outcome='completed') AS completed,
      count(*) FILTER(WHERE outcome IN ('failed','rejected')) AS failed,count(*) FILTER(WHERE outcome='interrupted') AS interrupted,
      avg(duration_ms) FILTER(WHERE outcome='completed') AS average FROM captcha_measurements GROUP BY solver`)
    ).rows;
    const checkSolvers = (
      await this.db.query<{
        name: string;
        average: string | null;
        samples: string;
      }>(`SELECT r->>'solver' AS name,
      avg((r->>'durationMs')::double precision) FILTER(WHERE r->>'status'='completed') AS average,
      count(*) FILTER(WHERE r->>'status'='completed') AS samples FROM checks CROSS JOIN LATERAL jsonb_array_elements(runs) r GROUP BY r->>'solver'`)
    ).rows;
    const map = (r: Record<string, string | null>): Metric => ({
      name: r.name!,
      total: Number(r.total),
      completed: Number(r.completed),
      failed: Number(r.failed),
      interrupted: Number(r.interrupted),
      averageMs: r.average == null ? null : Number(r.average),
      averageCaptchaMs: r.captcha == null ? null : Number(r.captcha),
    });
    const workers = (
      await this.db.query<{ count: string }>(
        "SELECT count(*) FROM worker_heartbeats WHERE seen_at>now()-interval '45 seconds'",
      )
    ).rows[0];
    const counts = (
      await this.db.query<{ queued: string; running: string }>(
        "SELECT count(*) FILTER(WHERE status='queued') AS queued,count(*) FILTER(WHERE status='running') AS running FROM checks",
      )
    ).rows[0];
    return {
      ...proxyStats,
      proxyOptions: proxyChoices(this.config, demo),
      settings: await this.settings(),
      proxies: rows.map(map),
      solvers: solverIds.map((name) => {
        const r = solvers.find((row) => row.name === name);
        const checks = checkSolvers.find((row) => row.name === name);
        return {
          ...(r
            ? map(r)
            : {
                name,
                total: 0,
                completed: 0,
                failed: 0,
                interrupted: 0,
                averageMs: null,
                averageCaptchaMs: null,
              }),
          averageCheckMs: checks?.average == null ? null : Number(checks.average),
          checkSamples: Number(checks?.samples ?? 0),
        };
      }),
      samples: Number(aggregate.samples),
      averageMs: aggregate.average == null ? null : Number(aggregate.average),
      averageQueueMs: aggregate.queue == null ? null : Number(aggregate.queue),
      activeWorkers: Number(workers.count),
      queued: Number(counts.queued),
      running: Number(counts.running),
      concurrency: this.config.WORKER_CONCURRENCY,
      intervalMs: this.config.MIN_CHECK_INTERVAL_MS,
      timeoutMs: this.config.CHECK_TIMEOUT_MS,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      nodeVersion: process.version,
      role: this.config.APP_ROLE,
      demo,
      solverConfigured: {
        '2captcha': demo || solverConfigured(this.config, '2captcha'),
        captchaai: demo || solverConfigured(this.config, 'captchaai'),
      },
    };
  }
  async reserveCaptcha() {
    const r = await this.db.query(
      `INSERT INTO captcha_usage(day,count) VALUES((now() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(day) DO UPDATE SET count=captcha_usage.count+1 WHERE captcha_usage.count<$1 RETURNING count`,
      [this.config.MAX_CAPTCHAS_PER_DAY],
    );
    if (!r.rows.length) throw new AppError('CAPTCHA_LIMIT', 429);
  }
  async beginSession(id: string, token: string, proxy: string) {
    const sid = randomUUID();
    const r = await this.db.query(
      `INSERT INTO apple_sessions(id,check_id,token,proxy,concurrency,queued)
      SELECT $3,id,$2,$4,(SELECT count(*)::int FROM checks WHERE status='running'),(SELECT count(*)::int FROM checks WHERE status='queued')
      FROM checks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id`,
      [id, token, sid, proxy],
    );
    if (!r.rows.length) throw new AppError('WORKER_INTERRUPTED');
    return sid;
  }
  async endSession(
    id: string,
    token: string,
    sid: string,
    m: import('../shared/system.js').SessionMeasurement,
  ) {
    await this.db.query(
      `UPDATE apple_sessions SET finished_at=clock_timestamp(),apple_ms=$4,limited=$5,limit_stage=$6,stages=$7,outcome=$8
      WHERE id=$3 AND token=$2 AND EXISTS(SELECT 1 FROM checks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now())`,
      [id, token, sid, m.appleMs, m.limited, m.limited ? m.stage : null, m.stages, m.outcome],
    );
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
