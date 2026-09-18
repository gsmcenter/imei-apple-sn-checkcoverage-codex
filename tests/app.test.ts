import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { createApp } from '../src/server/app.js';
let ctx: Awaited<ReturnType<typeof setup>>;
let repo: Repository;
let app: Awaited<ReturnType<typeof createApp>>;
let session = '';
const origin = 'http://localhost:3000';
before(async () => {
  ctx = await setup();
  repo = new Repository(ctx.db, ctx.config);
  app = await createApp(ctx.config, repo, { logger: false, readBalance: async () => 12.34 });
});
after(async () => {
  await app?.close();
  await ctx?.db.close();
});
beforeEach(async () => {
  await ctx.db.query('TRUNCATE captcha_measurements,system_settings,rate_limits,checks');
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password: 'correct-test-password' },
  });
  session = res.cookies[0].value;
});
test('history is private, login rejects wrong password, and sessions are httpOnly', async () => {
  assert.equal((await app.inject('/api/v1/checks')).statusCode, 401);
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password: 'incorrect' },
  });
  assert.equal(login.statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/v1/checks', cookies: { coverage_session: session } }))
      .statusCode,
    200,
  );
  const success = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password: 'correct-test-password' },
  });
  assert.match(String(success.headers['set-cookie']), /HttpOnly/);
  assert.match(String(success.headers['set-cookie']), /SameSite=Strict/);
});
test('cross-origin and missing-origin requests are denied', async () => {
  for (const headers of [{ origin: 'https://evil.example' }, {}]) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/checks',
      headers,
      cookies: { coverage_session: session },
      payload: { serial: 'C39ABCDEFG12' },
    });
    assert.equal(r.statusCode, 403);
  }
});
test('invalid serial and IMEI do not create a job; worker and valid idempotency key are required', async () => {
  for (const serial of ['123456789012345', 'BAD<script>', 'short']) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/checks',
      headers: { origin, 'idempotency-key': randomUUID() },
      cookies: { coverage_session: session },
      payload: { serial },
    });
    assert.equal(r.statusCode, 400);
  }
  assert.equal((await repo.list('', '', 1)).total, 0);
  const request = {
    method: 'POST' as const,
    url: '/api/v1/checks',
    headers: { origin, 'idempotency-key': randomUUID() },
    cookies: { coverage_session: session },
    payload: { serial: ' c39abcdefg12 ' },
  };
  assert.equal((await app.inject(request)).statusCode, 503);
  await repo.workerHeartbeat(randomUUID());
  const accepted = await app.inject(request);
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().check.serial, 'C39ABCDEFG12');
  assert.equal((await app.inject(request)).statusCode, 200);
});
test('logout invalidates server session', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { origin },
    cookies: { coverage_session: session },
    payload: {},
  });
  assert.equal(r.statusCode, 200);
  assert.equal(
    (await app.inject({ url: '/api/v1/checks', cookies: { coverage_session: session } }))
      .statusCode,
    401,
  );
});
test('login attempts are rate limited in the database', async () => {
  for (let i = 0; i < 10; i++)
    await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin },
      payload: { password: 'wrong' },
    });
  const r = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password: 'correct-test-password' },
  });
  assert.equal(r.statusCode, 429);
});

test('system settings and balance are private; only supported integrations and same-origin writes are allowed', async () => {
  for (const url of ['/api/v1/system', '/api/v1/system/balance'])
    assert.equal((await app.inject(url)).statusCode, 401);
  const cookies = { coverage_session: session };
  assert.equal((await app.inject({ url: '/api/v1/system', cookies })).statusCode, 200);
  const balance = await app.inject({ url: '/api/v1/system/balance', cookies });
  assert.equal(balance.json().balance, 12.34);
  for (const payload of [
    { proxyMode: 'http://attacker.invalid', solverId: '2captcha' },
    { proxyMode: 'random', solverId: 'unknown' },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/system/settings',
          cookies,
          headers: { origin },
          payload,
        })
      ).statusCode,
      400,
    );
  }
  const request = {
    method: 'POST' as const,
    url: '/api/v1/system/settings',
    cookies,
    payload: { proxyMode: 'random', solverId: '2captcha' },
  };
  assert.equal((await app.inject(request)).statusCode, 403);
  assert.equal((await app.inject({ ...request, headers: { origin } })).statusCode, 200);
  assert.equal((await repo.settings()).proxyMode, 'random');
});
