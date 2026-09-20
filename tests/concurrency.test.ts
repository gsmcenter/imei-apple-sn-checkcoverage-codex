import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { migrate } from '../src/server/database.js';
import { createApp } from '../src/server/app.js';
import { startWorker } from '../src/server/worker.js';
import { AppError } from '../src/server/errors.js';

test('saved concurrency overrides environment globally, persists and drains running jobs when reduced', async () => {
  const { db, config } = await setup();
  config.MIN_CHECK_INTERVAL_MS = 0;
  const repo = new Repository(db, config),
    other = new Repository(db, { ...config, WORKER_CONCURRENCY: 8 });
  try {
    assert.equal(await repo.concurrency(), config.WORKER_CONCURRENCY);
    const settings = await repo.settings();
    const since = (await repo.resetStatistics()).statisticsSince;
    for (let i = 0; i < 5; i++) await repo.enqueue(`CONCUR000${i}`, randomUUID());
    await repo.saveConcurrency(1);
    const first = (await repo.claim())!;
    assert.ok(first);
    assert.equal(await other.claim(), null);
    await other.saveConcurrency(3);
    const second = (await repo.claim())!,
      third = (await other.claim())!;
    assert.ok(second);
    assert.ok(third);
    assert.equal(await repo.claim(), null);
    await repo.saveConcurrency(1);
    await migrate(db);
    assert.equal(await other.concurrency(), 1);
    assert.equal((await other.system()).concurrency, 1);
    assert.equal((await repo.system()).statisticsSince, since);
    assert.deepEqual(await repo.settings(), settings);
    assert.equal((await repo.system()).running, 3);
    await repo.finish(first.id, first.token, null, 'SERIAL_NOT_FOUND');
    await repo.finish(second.id, second.token, null, 'SERIAL_NOT_FOUND');
    assert.equal(await other.claim(), null);
    assert.equal((await repo.get(third.id))?.status, 'running');
    await repo.finish(third.id, third.token, null, 'SERIAL_NOT_FOUND');
    assert.ok(await other.claim());
    for (const n of [0, 9, 1.5, NaN]) await assert.rejects(repo.saveConcurrency(n));
    assert.equal(await repo.concurrency(), 1);
  } finally {
    await db.close();
  }
});

test('concurrency endpoint requires authentication and origin, rejects invalid limits and preserves other settings', async () => {
  const { db, config } = await setup();
  const repo = new Repository(db, config),
    app = await createApp(config, repo, { logger: false });
  try {
    const url = '/api/v1/system/concurrency';
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { origin: config.APP_ORIGIN },
          payload: { concurrency: 3 },
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
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          cookies,
          headers: { origin: 'https://evil.example' },
          payload: { concurrency: 3 },
        })
      ).statusCode,
      403,
    );
    for (const payload of [
      { concurrency: 0 },
      { concurrency: 9 },
      { concurrency: 1.5 },
      { concurrency: '3' },
      { concurrency: 2, solverId: 'captchaai' },
      {},
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            cookies,
            headers: { origin: config.APP_ORIGIN },
            payload,
          })
        ).statusCode,
        400,
      );
    }
    const r = await app.inject({
      method: 'POST',
      url,
      cookies,
      headers: { origin: config.APP_ORIGIN },
      payload: { concurrency: 4 },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { concurrency: 4 });
    assert.equal((await app.inject({ url: '/api/v1/system', cookies })).json().concurrency, 4);
  } finally {
    await app.close();
    await db.close();
  }
});

test('running worker applies a higher saved limit without restart and does not abort jobs after lowering it', async () => {
  const { db, config } = await setup();
  config.WORKER_CONCURRENCY = 1;
  config.MIN_CHECK_INTERVAL_MS = 0;
  const repo = new Repository(db, config);
  const gates: Array<() => void> = [];
  let active = 0,
    aborted = 0;
  let worker: ReturnType<typeof startWorker> | undefined;
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 12000;
    while (!predicate() && Date.now() < deadline) await delay(50);
    assert.ok(predicate(), 'Worker did not reach expected state');
  }
  try {
    for (let i = 0; i < 5; i++) await repo.enqueue(`WORKER000${i}`, randomUUID());
    worker = startWorker(
      repo,
      {
        async check(_serial, signal) {
          active++;
          try {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                aborted++;
                reject(new Error('stopped'));
              };
              signal.addEventListener('abort', onAbort, { once: true });
              gates.push(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
              });
            });
            throw new AppError('SERIAL_NOT_FOUND');
          } finally {
            active--;
          }
        },
      },
      true,
    );
    await until(() => gates.length === 1);
    await repo.saveConcurrency(3);
    await until(() => gates.length === 3);
    assert.equal(active, 3);
    await repo.saveConcurrency(1);
    gates[0]();
    gates[1]();
    await until(() => active === 1);
    await delay(2300); // Observe a worker polling cycle while exactly at the lowered limit.
    assert.equal(gates.length, 3);
    assert.equal(aborted, 0);
    gates[2]();
    await until(() => gates.length === 4);
    assert.equal(active, 1);
    assert.equal(aborted, 0);
  } finally {
    await worker?.close();
    await db.close();
  }
});
