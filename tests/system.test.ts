import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { migrate } from '../src/server/database.js';
import { proxyHosts } from '../src/shared/system.js';
import { cachedBalance } from '../src/server/balance.js';
import { CaptchaClient } from '../src/server/integrations/captcha.js';

test('settings persist, jobs snapshot proxy, telemetry and diagnostics survive migration and exclude failures from averages', async () => {
  const { db, config } = await setup();
  const repo = new Repository(db, config);
  try {
    await repo.saveSettings({ proxyMode: proxyHosts[0], solverId: '2captcha' });
    const { check } = await repo.enqueue('TESTSERIAL1', randomUUID());
    const job = (await repo.claim())!;
    assert.equal(job.proxy, proxyHosts[0]);
    await repo.saveSettings({ proxyMode: proxyHosts[1], solverId: '2captcha' });
    assert.equal((await new Repository(db, config).settings()).proxyMode, proxyHosts[1]);
    const measurement = await repo.beginCaptcha(job.id, job.token, '2captcha');
    await repo.endCaptcha(job.id, job.token, measurement, 1250, 'completed');
    await repo.diagnostic(
      job.id,
      job.token,
      'safe',
      `Code ERROR_ZERO_BALANCE ${config.SESSION_SECRET} https://user:password@host/secret`,
    );
    await repo.diagnostic(job.id, randomUUID(), 'stale', 'must not be written');
    await repo.finish(job.id, job.token, null, null);
    const result = (await repo.get(check.id))!;
    assert.equal(result.runs?.[0].proxy, proxyHosts[0]);
    assert.equal(result.runs?.[0].captchaMs, 1250);
    assert.equal(result.runs?.[0].captchaCalls, 1);
    assert.ok(result.runs?.[0].durationMs != null);
    assert.equal(result.diagnostics?.length, 1);
    assert.ok(!JSON.stringify(result.diagnostics).includes(config.SESSION_SECRET));
    assert.ok(!JSON.stringify(result.diagnostics).includes('user:password'));
    await db.query('UPDATE queue_state SET last_started=NULL');
    await repo.enqueue('TESTSERIAL2', randomUUID());
    const failed = (await repo.claim())!;
    assert.equal(failed.proxy, proxyHosts[1]);
    await repo.finish(failed.id, failed.token, null, 'PROXY_ERROR');
    await migrate(db);
    assert.equal((await repo.get(check.id))?.runs?.length, 1);
    const stats = await repo.system();
    assert.equal(stats.samples, 1);
    assert.equal(stats.proxies.find((r) => r.name === proxyHosts[1])?.averageMs, null);
    assert.equal(stats.proxies.find((r) => r.name === proxyHosts[1])?.failed, 1);
    assert.equal(stats.solvers[0].averageMs, 1250);
    assert.equal(stats.solvers[0].total, 1);
    assert.equal((await repo.list('', '', 1)).items[0].diagnostics, undefined);
  } finally {
    await db.close();
  }
});

test('random uses allowlisted proxies and recovery retains each attempt, with stale telemetry rejected', async () => {
  const { db, config } = await setup();
  const repo = new Repository(db, config);
  try {
    await repo.saveSettings({ proxyMode: 'random', solverId: '2captcha' });
    await repo.enqueue('TESTSERIAL3', randomUUID());
    const first = (await repo.claim())!;
    assert.ok(proxyHosts.some((p) => p === first.proxy));
    const measurement = await repo.beginCaptcha(first.id, first.token, '2captcha');
    await db.query("UPDATE checks SET lease_until=now()-interval '1 second'");
    await repo.recover();
    await db.query('UPDATE queue_state SET last_started=NULL');
    const second = (await repo.claim())!;
    assert.ok(proxyHosts.some((p) => p === second.proxy));
    await assert.rejects(repo.beginCaptcha(first.id, first.token, '2captcha'));
    await repo.endCaptcha(first.id, first.token, measurement, 1000, 'completed');
    assert.equal(await repo.finish(first.id, first.token, null, null), false);
    await repo.finish(second.id, second.token, null, 'PAGE_CHANGED');
    const result = (await repo.get(first.id))!;
    assert.equal(result.runs?.length, 2);
    assert.equal(result.runs?.[0].status, 'interrupted');
    assert.equal(result.runs?.[0].durationMs, null);
    assert.equal(result.runs?.[1].status, 'failed');
    const stats = await repo.system();
    assert.equal(stats.samples, 0);
    assert.equal(stats.solvers[0].interrupted, 1);
  } finally {
    await db.close();
  }
});

test('balance accepts zero, collapses concurrent calls and reports errors without inventing a zero balance', async () => {
  const solver = new CaptchaClient('key', 1000, (async () =>
    Response.json({ errorId: 0, balance: 0 })) as typeof fetch);
  assert.equal(await solver.getBalance(), 0);
  let calls = 0;
  const read = cachedBalance(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return 0;
  });
  const results = await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  assert.equal(results[0].balance, 0);
  assert.equal(results[0].status, 'ok');
  await read();
  assert.equal(calls, 1);
  const failed = await cachedBalance(async () => {
    throw new Error('secret');
  })();
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.balance, null);
  assert.ok(!JSON.stringify(failed).includes('secret'));
  assert.equal((await cachedBalance(undefined)()).status, 'not_configured');
});
