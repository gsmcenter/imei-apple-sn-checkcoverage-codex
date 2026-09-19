import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { BatchRepository, batchCsv, type BatchInput } from '../src/server/batches.js';
import { parseSerials } from '../src/shared/batches.js';
import { createApp } from '../src/server/app.js';
import { migrate } from '../src/server/database.js';

let ctx: Awaited<ReturnType<typeof setup>>, repo: Repository, batches: BatchRepository;
const input = (text: string, extra: Partial<BatchInput> = {}): BatchInput => ({
  name: 'Dostawa testowa',
  notes: 'Notatka',
  text,
  ignoreInvalid: false,
  paused: false,
  ...extra,
});
before(async () => {
  ctx = await setup();
  repo = new Repository(ctx.db, ctx.config);
  batches = new BatchRepository(repo);
});
after(async () => {
  await ctx.db.close();
});
beforeEach(async () => {
  await ctx.db.query(
    'TRUNCATE batch_items,batches,captcha_measurements,checks,captcha_usage,rate_limits; UPDATE queue_state SET last_started=NULL',
  );
  ctx.config.MAX_PENDING_CHECKS = 200;
  ctx.config.MAX_CHECKS_PER_DAY = 1500;
  ctx.config.MAX_CAPTCHAS_PER_DAY = 3000;
  ctx.config.MIN_CHECK_INTERVAL_MS = 0;
});

test('import normalizes a one-column file, reports invalid entries and deduplicates without guessing serials', () => {
  const p = parseSerials('\uFEFFSN\r\n"testsn0001";TESTSN0001\tTESTSN0002,123456789012345\nBAD!');
  assert.deepEqual(p, {
    serials: ['TESTSN0001', 'TESTSN0002'],
    invalid: ['123456789012345', 'BAD!'],
    duplicates: 1,
    total: 5,
  });
});
test('batch creation is atomic and idempotent, validates imports, and survives migration/restart', async () => {
  await assert.rejects(batches.create(input('TESTSN0001 BAD!'), randomUUID()));
  assert.equal((await batches.list('', 1)).total, 0);
  const payload = input('TESTSN0001 TESTSN0001 BAD!', { ignoreInvalid: true, paused: true });
  const key = randomUUID(),
    a = await batches.create(payload, key),
    b = await batches.create(payload, key);
  assert.equal(a.id, b.id);
  assert.equal(b.reused, true);
  await assert.rejects(batches.create({ ...payload, name: 'inna' }, key));
  const d = await batches.detail(a.id);
  assert.equal(d.batch.duplicates, 1);
  assert.equal(d.batch.invalid, 1);
  assert.equal(d.batch.waiting, 1);
  await migrate(ctx.db);
  await new BatchRepository(repo).dispatch();
  assert.equal((await batches.get(a.id)).waiting, 1);
  const full = Array.from({ length: 5000 }, (_, i) => `TEST${String(i).padStart(6, '0')}`).join(
    '\n',
  );
  const big = await batches.create(input(full, { paused: true }), randomUUID());
  assert.equal((await batches.get(big.id)).total, 5000);
  await assert.rejects(batches.create(input(full + '\nTEST999999'), randomUUID()));
});
test('large batches fill available queue slots, share active checks, and resume when daily capacity returns', async () => {
  ctx.config.MAX_PENDING_CHECKS = 2;
  ctx.config.MAX_CHECKS_PER_DAY = 2;
  const existing = await repo.enqueue('TESTSN0001', randomUUID());
  const a = await batches.create(input('TESTSN0001 TESTSN0002 TESTSN0003'), randomUUID());
  await batches.dispatch();
  let d = await batches.detail(a.id);
  assert.equal(d.items[0].check?.id, existing.check.id);
  assert.equal(d.batch.queued, 2);
  assert.equal(d.batch.waiting, 1);
  await ctx.db.query(
    "UPDATE checks SET status='failed',stage='done',error_code='CHECK_TIMEOUT',finished_at=now()",
  );
  await batches.dispatch();
  assert.equal((await batches.get(a.id)).waiting, 1); // daily limit is still reached
  await ctx.db.query("UPDATE checks SET created_at=now()-interval '1 day'");
  await new BatchRepository(repo).dispatch();
  assert.equal((await batches.get(a.id)).waiting, 0);
});
test('pause and cancellation preserve queued work and historical results; retry snapshots only failures', async () => {
  ctx.config.MAX_PENDING_CHECKS = 1;
  const a = await batches.create(input('TESTSN0001 TESTSN0002 TESTSN0003'), randomUUID());
  await batches.dispatch();
  await batches.update(a.id, { state: 'paused', name: 'Zmieniona paczka', notes: 'nowa notatka' });
  await ctx.db.query(
    "UPDATE checks SET status='failed',stage='done',error_code='CHECK_TIMEOUT',finished_at=now()",
  );
  await batches.dispatch();
  assert.equal((await batches.get(a.id)).waiting, 2);
  await batches.update(a.id, { state: 'active' });
  await batches.dispatch();
  await batches.update(a.id, { state: 'cancelled' });
  let d = await batches.detail(a.id);
  assert.equal(d.batch.cancelled, 1);
  assert.equal(d.batch.queued, 1);
  assert.equal(d.batch.failed, 1);
  assert.equal(d.batch.name, 'Zmieniona paczka');
  await assert.rejects(batches.update(a.id, { state: 'active' }));
  const key = randomUUID(),
    retry = await batches.create(input('', { name: 'Ponowienie' }), key, a.id);
  await ctx.db.query(
    "UPDATE checks SET status='failed',error_code='CHECK_TIMEOUT',finished_at=now() WHERE status='queued'",
  );
  assert.equal((await batches.create(input('', { name: 'Ponowienie' }), key, a.id)).id, retry.id);
  assert.equal((await batches.get(retry.id)).total, 1);
  assert.equal((await batches.get(retry.id)).sourceId, a.id);
  await batches.dispatch();
  d = await batches.detail(retry.id);
  assert.notEqual(d.items[0].check?.id, (await batches.detail(a.id)).items[0].check?.id);
});
test('fair dispatch alternates batches and CAPTCHA quota keeps queued checks waiting', async () => {
  ctx.config.MAX_PENDING_CHECKS = 2;
  const a = await batches.create(input('TESTSN0001 TESTSN0002'), randomUUID()),
    b = await batches.create(input('TESTSN0003 TESTSN0004'), randomUUID());
  await batches.dispatch();
  assert.equal((await batches.get(a.id)).queued, 1);
  assert.equal((await batches.get(b.id)).queued, 1);
  ctx.config.MAX_CAPTCHAS_PER_DAY = 1;
  await repo.reserveCaptcha();
  assert.equal(await repo.claim(), null);
  await ctx.db.query('TRUNCATE captcha_usage');
  assert.ok(await repo.claim());
});
test('batch detail filters and paginates; export includes all matching rows and neutralizes spreadsheet formulas', async () => {
  const a = await batches.create(
    input(Array.from({ length: 55 }, (_, i) => `TEST${String(i).padStart(6, '0')}`).join('\n'), {
      name: '=HYPERLINK("bad")',
      paused: true,
    }),
    randomUUID(),
  );
  const first = await batches.detail(a.id),
    second = await batches.detail(a.id, '', '', 2);
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 5);
  assert.equal((await batches.detail(a.id, 'TEST000054', 'waiting')).total, 1);
  const csv = batchCsv(await batches.detail(a.id, '', '', 1, true));
  assert.equal(csv.split('\r\n').length, 56);
  assert.match(csv, /"'=HYPERLINK/);
  assert.ok(csv.startsWith('\uFEFF'));
});

test(
  'concurrent PostgreSQL dispatchers and single submissions cannot exceed capacity or duplicate active SN',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    ctx.config.MAX_PENDING_CHECKS = 3;
    const a = await batches.create(
      input('TESTSN0001 TESTSN0002 TESTSN0003 TESTSN0004'),
      randomUUID(),
    );
    await Promise.all([
      batches.dispatch(),
      new BatchRepository(repo).dispatch(),
      repo.enqueue('TESTSN0001', randomUUID()),
    ]);
    const d = await batches.detail(a.id);
    assert.equal(d.batch.queued, 3);
    assert.equal(d.batch.waiting, 1);
    const counts = (
      await ctx.db.query<{ count: string; unique_count: string }>(
        'SELECT count(*) AS count,count(DISTINCT serial) AS unique_count FROM checks',
      )
    ).rows[0];
    assert.equal(Number(counts.count), 3);
    assert.equal(counts.count, counts.unique_count);
  },
);
test('batch APIs require a session and same origin, support imports over 4KB, and protect exports', async () => {
  const app = await createApp(ctx.config, repo, { logger: false });
  try {
    assert.equal((await app.inject('/api/v1/batches')).statusCode, 401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ctx.config.APP_ORIGIN },
      payload: { password: 'correct-test-password' },
    });
    const cookies = { coverage_session: login.cookies[0].value };
    const payload = input(
      Array.from({ length: 500 }, (_, i) => `TEST${String(i).padStart(6, '0')}`).join('\n'),
      { paused: true },
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/batches',
          cookies,
          headers: { origin: 'https://evil.example', 'idempotency-key': randomUUID() },
          payload,
        })
      ).statusCode,
      403,
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/batches',
      cookies,
      headers: { origin: ctx.config.APP_ORIGIN, 'idempotency-key': randomUUID() },
      payload,
    });
    assert.equal(r.statusCode, 202, r.body);
    const id = r.json().id;
    assert.equal((await app.inject(`/api/v1/batches/${id}/export.csv`)).statusCode, 401);
    const csv = await app.inject({ url: `/api/v1/batches/${id}/export.csv`, cookies });
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.body.split('\r\n').length, 501);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/batches',
      cookies,
      headers: { origin: ctx.config.APP_ORIGIN, 'idempotency-key': randomUUID() },
      payload: input('BAD!'),
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /Popraw/);
  } finally {
    await app.close();
  }
});
