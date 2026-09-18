import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import type { Database } from '../src/server/database.js';
let db: Database;
let repo: Repository;
before(async () => {
  const ctx = await setup();
  db = ctx.db;
  repo = new Repository(db, ctx.config);
});
after(async () => db?.close());
beforeEach(async () => {
  await db.query('TRUNCATE checks,captcha_usage; UPDATE queue_state SET last_started=NULL');
  repo.config.MAX_CHECKS_PER_DAY = 1500;
  repo.config.MAX_CAPTCHAS_PER_DAY = 3000;
});

test('idempotency and active serial deduplication prevent duplicate paid jobs', async () => {
  const key = randomUUID();
  const a = await repo.enqueue('C39ABCDEFG12', key);
  assert.equal((await repo.enqueue('C39ABCDEFG12', key)).check.id, a.check.id);
  assert.equal((await repo.enqueue('C39ABCDEFG12', randomUUID())).check.id, a.check.id);
  await assert.rejects(repo.enqueue('C39ABCDEFG13', key), /innego SN/);
  assert.equal((await repo.list('', '', 1)).total, 1);
});
test('global daily checks and captcha quotas are enforced', async () => {
  repo.config.MAX_CHECKS_PER_DAY = 1;
  repo.config.MAX_CAPTCHAS_PER_DAY = 1;
  await repo.enqueue('C39ABCDEFG12', randomUUID());
  await assert.rejects(
    repo.enqueue('C39ABCDEFG13', randomUUID()),
    (e) => (e as { code: string }).code === 'DAILY_LIMIT',
  );
  await repo.reserveCaptcha();
  await assert.rejects(
    repo.reserveCaptcha(),
    (e) => (e as { code: string }).code === 'CAPTCHA_LIMIT',
  );
});
test('expired leases requeue, old workers cannot overwrite results, retries are bounded', async () => {
  const { check } = await repo.enqueue('C39ABCDEFG12', randomUUID());
  const first = await repo.claim();
  assert.ok(first);
  assert.equal(await repo.finish(check.id, randomUUID(), null, 'APPLE_UNAVAILABLE'), false);
  await db.query("UPDATE checks SET lease_until=now()-interval '1 second'");
  await repo.recover();
  assert.equal((await repo.get(check.id))?.status, 'queued');
  await db.query('UPDATE queue_state SET last_started=NULL');
  const second = await repo.claim();
  assert.ok(second);
  assert.notEqual(first.token, second.token);
  assert.equal(await repo.finish(check.id, first.token, null, 'APPLE_UNAVAILABLE'), false);
  await db.query("UPDATE checks SET lease_until=now()-interval '1 second'");
  await repo.recover();
  assert.equal((await repo.get(check.id))?.errorCode, 'WORKER_INTERRUPTED');
});
test('claim concurrency is global and retains completed history', async () => {
  repo.config.WORKER_CONCURRENCY = 1;
  await repo.enqueue('C39ABCDEFG12', randomUUID());
  await repo.enqueue('C39ABCDEFG13', randomUUID());
  const first = await repo.claim();
  assert.ok(first);
  await db.query('UPDATE queue_state SET last_started=NULL');
  assert.equal(await repo.claim(), null);
  await repo.finish(first.id, first.token, null, 'SERIAL_NOT_FOUND');
  assert.ok(await repo.claim());
  await repo.cleanupEphemeral();
  assert.equal((await repo.list('', '', 1)).total, 2);
});
test(
  'parallel PostgreSQL claims cannot claim a job twice',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    repo.config.WORKER_CONCURRENCY = 2;
    await repo.enqueue('C39ABCDEFG12', randomUUID());
    const claimed = (await Promise.all([repo.claim(), repo.claim(), repo.claim()])).filter(Boolean);
    assert.equal(claimed.length, 1);
  },
);
