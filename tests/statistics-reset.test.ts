import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { migrate } from '../src/server/database.js';
import { createApp } from '../src/server/app.js';

test('reset starts a persistent measurement period, excluding old queued/running checks without changing history, settings or quotas', async () => {
  const { db, config } = await setup();
  config.MIN_CHECK_INTERVAL_MS = 0;
  const repo = new Repository(db, config);
  async function finish(
    job: NonNullable<Awaited<ReturnType<Repository['claim']>>>,
    ms: number,
    limited = false,
  ) {
    const session = await repo.beginSession(job.id, job.token, job.proxy);
    await repo.endSession(job.id, job.token, session, {
      appleMs: ms,
      limited,
      stage: 'captcha',
      stages: ['opening', 'captcha'],
      outcome: limited ? 'rate_limited' : 'completed',
    });
    const captcha = await repo.beginCaptcha(job.id, job.token, job.solver);
    await repo.endCaptcha(job.id, job.token, captcha, ms * 2, 'completed');
    await repo.finish(job.id, job.token, null, null);
  }
  try {
    await repo.enqueue('RESETOLD01', randomUUID());
    const completed = (await repo.claim())!;
    await finish(completed, 900, true);
    await repo.enqueue('RESETRUN01', randomUUID());
    const running = (await repo.claim())!;
    await repo.enqueue('RESETQUE01', randomUUID());
    // Deterministic pre-boundary fixtures; no sleeps or clock assumptions.
    await db.query("UPDATE checks SET created_at=now()-interval '1 hour'");
    await repo.reserveCaptcha();
    const before = await repo.system();
    assert.equal(before.samples, 1);
    assert.equal(before.proxyPerformance[0].averageMs, 900);
    assert.equal(before.solvers[0].averageMs, 1800);
    assert.ok(before.limits.some((x) => x.limited === 1));
    const history = await repo.get(completed.id);
    const quotasBefore = (await db.query('SELECT * FROM captcha_usage')).rows;
    const settingsBefore = await repo.settings();
    const reset = await repo.resetStatistics();
    await migrate(db);
    await repo.saveSettings(settingsBefore);
    let stats = await new Repository(db, config).system();
    assert.equal(stats.statisticsSince, reset.statisticsSince);
    assert.equal(stats.samples, 0);
    assert.equal(stats.averageMs, null);
    assert.equal(stats.averageQueueMs, null);
    assert.deepEqual(stats.proxies, []);
    assert.deepEqual(stats.proxyPerformance, []);
    assert.deepEqual(stats.limits, []);
    assert.ok(
      stats.solvers.every((s) => s.total === 0 && s.averageMs === null && s.checkSamples === 0),
    );
    assert.equal(stats.running, 1);
    assert.equal(stats.queued, 1);
    assert.deepEqual(await repo.get(completed.id), history);
    assert.deepEqual((await db.query('SELECT * FROM captcha_usage')).rows, quotasBefore);
    assert.deepEqual(await repo.settings(), settingsBefore);
    await finish(running, 700, true);
    const oldQueued = (await repo.claim())!;
    await finish(oldQueued, 600, true);
    stats = await repo.system();
    assert.equal(stats.samples, 0);
    assert.equal(stats.solvers[0].total, 0);
    assert.deepEqual(stats.limits, []);
    await repo.enqueue('RESETNEW01', randomUUID());
    await finish((await repo.claim())!, 80);
    stats = await repo.system();
    assert.equal(stats.samples, 1);
    assert.equal(stats.proxies[0].total, 1);
    assert.equal(stats.proxyPerformance[0].averageMs, 80);
    assert.equal(stats.proxyPerformance[0].medianMs, 80);
    assert.equal(stats.proxyPerformance[0].sessions, 1);
    assert.equal(stats.solvers[0].total, 1);
    assert.equal(stats.solvers[0].averageMs, 160);
    assert.equal(stats.solvers[0].checkSamples, 1);
    assert.ok(stats.limits.every((x) => x.sessions === 1 && x.limited === 0));
    assert.equal((await repo.list('', '', 1)).total, 4);
  } finally {
    await db.close();
  }
});

test('statistics reset requires authentication and same origin and accepts no client cutoff date', async () => {
  const { db, config } = await setup();
  const repo = new Repository(db, config);
  const app = await createApp(config, repo, { logger: false });
  try {
    const url = '/api/v1/system/statistics/reset';
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { origin: config.APP_ORIGIN },
          payload: {},
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: config.APP_ORIGIN },
      payload: { password: 'correct-test-password' },
    });
    const cookies = { coverage_session: login.cookies[0].value };
    assert.equal((await app.inject({ method: 'POST', url, cookies, payload: {} })).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          cookies,
          headers: { origin: 'https://evil.example' },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          cookies,
          headers: { origin: config.APP_ORIGIN },
          payload: { statisticsSince: '2099-01-01' },
        })
      ).statusCode,
      400,
    );
    assert.equal((await repo.system()).statisticsSince, null);
    const response = await app.inject({
      method: 'POST',
      url,
      cookies,
      headers: { origin: config.APP_ORIGIN },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.ok(Number.isFinite(Date.parse(response.json().statisticsSince)));
    assert.equal((await repo.system()).statisticsSince, response.json().statisticsSince);
  } finally {
    await app.close();
    await db.close();
  }
});
