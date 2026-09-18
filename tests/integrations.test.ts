import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoverage, appleError } from '../src/server/integrations/parser.js';
import { CaptchaClient } from '../src/server/integrations/captcha.js';
import { hashPassword, verifyPassword } from '../src/server/security.js';
import { browserErrorCode, AppError } from '../src/server/errors.js';
const serial = 'C39ABCDEFG12';
test('browser network timeout is not mistaken for a changed Apple page', () => {
  assert.equal(browserErrorCode(new Error('page.goto: net::ERR_TIMED_OUT')), 'CHECK_TIMEOUT');
  assert.equal(browserErrorCode(new Error('net::ERR_TUNNEL_CONNECTION_FAILED')), 'PROXY_ERROR');
  assert.equal(browserErrorCode(new AppError('APPLE_BLOCKED')), 'APPLE_BLOCKED');
  assert.equal(browserErrorCode(new Error('unknown'), true), 'CHECK_TIMEOUT');
});

test('parser extracts explicit coverage labels and keeps original dates and response', () => {
  const r = parseCoverage(
    `iPhone 16 Pro\nSerial Number: ${serial}\nLimited Warranty\nExpires: September 18, 2027\nPurchase Date: September 18, 2026\nHardware Service\nNeed help?`,
    ['iPhone 16 Pro', 'Limited Warranty'],
    serial,
  );
  assert.equal(r.coverageStatus, 'active');
  assert.equal(r.expirationDate, 'September 18, 2027');
  assert.match(r.rawText, /Hardware Service/);
  const expired = parseCoverage(
    `MacBook Pro\n${serial}\nCoverage Expired`,
    ['MacBook Pro', 'Coverage Expired'],
    serial,
  );
  assert.equal(expired.coverageStatus, 'expired');
});
test('parser fails closed on unrelated pages and never infers active status from a promotional AppleCare link', () => {
  assert.throws(() => parseCoverage('View coverage\nBuy AppleCare+', ['View coverage'], serial));
  const r = parseCoverage(
    `iPhone 16\n${serial}\nGet AppleCare+ coverage today\nAppleCare+`,
    ['iPhone 16'],
    serial,
  );
  assert.equal(r.coverageStatus, 'unknown');
  assert.equal(r.expirationDate, null);
  assert.equal(appleError('Please enter a valid serial number.'), 'SERIAL_NOT_FOUND');
  assert.equal(appleError('The code is incorrect. Try again.'), 'CAPTCHA_REJECTED');
});
test('a plan renewal date is not represented as a warranty expiration date', () => {
  const r = parseCoverage(
    `iPhone 16\n${serial}\nAppleCare+\nRenews on October 18, 2026`,
    ['iPhone 16', 'AppleCare+'],
    serial,
  );
  assert.equal(r.renewalDate, 'October 18, 2026');
  assert.equal(r.expirationDate, null);
});
const image = 'data:image/png;base64,aGVsbG8=';
test('2Captcha creates one task, polls processing, and returns solution', async () => {
  const methods: string[] = [];
  let reads = 0;
  const mock = (async (url: string | URL | Request, options: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    methods.push(method);
    const body = JSON.parse(String(options.body));
    assert.equal(body.clientKey, 'private-key');
    return Response.json(
      method === 'createTask'
        ? { errorId: 0, taskId: 12 }
        : ++reads === 1
          ? { errorId: 0, status: 'processing' }
          : { errorId: 0, status: 'ready', solution: { text: 'ABC12' } },
    );
  }) as typeof fetch;
  const result = await new CaptchaClient('private-key', 1000, mock, 1).solve(
    image,
    new AbortController().signal,
  );
  assert.deepEqual(result, { taskId: 12, text: 'ABC12' });
  assert.equal(methods.filter((m) => m === 'createTask').length, 1);
});
test('2Captcha errors and timeouts never automatically create another paid task', async () => {
  let calls = 0;
  const bad = (async () => {
    calls++;
    return Response.json({ errorId: 10, errorDescription: 'private-key must never be exposed' });
  }) as typeof fetch;
  await assert.rejects(
    new CaptchaClient('key', 1000, bad, 1).solve(image, new AbortController().signal),
    (e) =>
      (e as { code: string }).code === 'CAPTCHA_SERVICE' &&
      !(e as Error).message.includes('private-key'),
  );
  assert.equal(calls, 1);
  const pending = (async (url: string) =>
    Response.json(
      url.endsWith('createTask')
        ? { errorId: 0, taskId: 12 }
        : { errorId: 0, status: 'processing' },
    )) as typeof fetch;
  await assert.rejects(
    new CaptchaClient('key', 20, pending, 1).solve(image, new AbortController().signal),
    (e) => (e as { code: string }).code === 'CAPTCHA_TIMEOUT',
  );
});
test('password hashing verifies secrets without storing plaintext', async () => {
  const hash = await hashPassword('example-secure-password');
  assert.ok(!hash.includes('example'));
  assert.equal(await verifyPassword('example-secure-password', hash), true);
  assert.equal(await verifyPassword('incorrect-password', hash), false);
});
