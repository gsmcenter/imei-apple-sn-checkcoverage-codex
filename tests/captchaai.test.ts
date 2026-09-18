import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaAiClient } from '../src/server/integrations/captchaai.js';
import { createSolver } from '../src/server/integrations/solvers.js';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { randomUUID } from 'node:crypto';
const image = `data:image/png;base64,${Buffer.alloc(120, 1).toString('base64')}`;

test('CaptchaAI submits multipart once, polls the same task, preserves case and reports incorrect results', async () => {
  let submissions = 0,
    polls = 0;
  const reports: string[] = [];
  const fetcher = (async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.ok(!String(url).includes('private-key'));
    const form = init!.body as FormData;
    assert.equal(form.get('key'), 'private-key');
    assert.equal(form.get('json'), '1');
    if (String(url).endsWith('in.php')) {
      submissions++;
      assert.equal(form.get('method'), 'post');
      assert.equal(form.get('regsense'), '1');
      assert.equal((form.get('file') as Blob).size, 120);
      return Response.json({ status: 1, request: '00012345678901234567890' });
    }
    assert.equal(form.get('id'), '00012345678901234567890');
    if (form.get('action') === 'reportbad') {
      reports.push(String(form.get('id')));
      return Response.json({ status: 1, request: 'OK_REPORT_RECORDED' });
    }
    return Response.json(
      ++polls === 1 ? { status: 0, request: 'CAPCHA_NOT_READY' } : { status: 1, request: 'aBc12' },
    );
  }) as typeof fetch;
  const client = new CaptchaAiClient('private-key', 1000, fetcher, 1);
  const result = await client.solve(image, new AbortController().signal);
  assert.equal(result.text, 'aBc12');
  assert.equal(submissions, 1);
  assert.equal(polls, 2);
  await client.reportIncorrect(result.taskId);
  assert.equal(reports.length, 1);
});

test('CaptchaAI failure and timeout never create duplicate paid tasks or reveal response secrets', async () => {
  let calls = 0;
  const logs: string[] = [];
  const bad = (async () => {
    calls++;
    return Response.json({ status: 0, request: 'private-key in arbitrary error' });
  }) as typeof fetch;
  await assert.rejects(
    new CaptchaAiClient('private-key', 1000, bad, 1, async (_, message) => {
      logs.push(message);
    }).solve(image, new AbortController().signal),
    (e) => (e as { code: string }).code === 'CAPTCHA_SERVICE',
  );
  assert.equal(calls, 1);
  assert.ok(!logs.join().includes('private-key'));
  let submissions = 0;
  const pending = (async (url) => {
    if (String(url).endsWith('in.php')) {
      submissions++;
      return Response.json({ status: 1, request: '123' });
    }
    return Response.json({ status: 0, request: 'CAPCHA_NOT_READY' });
  }) as typeof fetch;
  await assert.rejects(
    new CaptchaAiClient('key', 20, pending, 1).solve(image, new AbortController().signal),
    (e) => (e as { code: string }).code === 'CAPTCHA_TIMEOUT',
  );
  assert.equal(submissions, 1);
});

test('switching solvers preserves historical attribution and groups full-check and solver durations separately', async () => {
  const { db, config } = await setup();
  config.CAPTCHAAI_API_KEY = 'captchaai-test-key';
  const repo = new Repository(db, config);
  try {
    assert.ok(createSolver('captchaai', config) instanceof CaptchaAiClient);
    await repo.saveSettings({ proxyMode: 'open.proxymesh.com:31280', solverId: 'captchaai' });
    await repo.enqueue('TESTSERIAL1', randomUUID());
    const job = (await repo.claim())!;
    assert.equal(job.solver, 'captchaai');
    await repo.saveSettings({ proxyMode: 'random', solverId: '2captcha' });
    const measurement = await repo.beginCaptcha(job.id, job.token, job.solver);
    await repo.endCaptcha(job.id, job.token, measurement, 4000, 'completed');
    await repo.finish(job.id, job.token, null, null);
    const stats = await repo.system();
    const ai = stats.solvers.find((r) => r.name === 'captchaai')!;
    assert.equal(ai.averageMs, 4000);
    assert.equal(ai.checkSamples, 1);
    assert.ok(ai.averageCheckMs != null);
    assert.equal(stats.solvers.find((r) => r.name === '2captcha')?.total, 0);
    assert.equal((await repo.get(job.id))?.runs?.[0].solver, 'captchaai');
  } finally {
    await db.close();
  }
});
