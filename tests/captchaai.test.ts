import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaAiClient } from '../src/server/integrations/captchaai.js';
import { createSolver } from '../src/server/integrations/solvers.js';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { randomUUID } from 'node:crypto';
import { cachedCaptchaAiAccount } from '../src/server/balance.js';
const image = `data:image/png;base64,${Buffer.alloc(120, 1).toString('base64')}`;
const hasCode = (code: string) => (e: unknown) => (e as { code: string }).code === code;

for (const id of [5259922783, '00012345678901234567890']) {
  test(`CaptchaAI accepts real numeric and string IDs (${typeof id}), polls by GET and preserves case`, async () => {
    let submissions = 0,
      polls = 0;
    const reports: string[] = [];
    const fetcher = (async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('in.php')) {
        assert.equal(init?.method, 'POST');
        const form = init!.body as FormData;
        assert.equal(form.get('key'), 'private-key');
        assert.equal(form.get('json'), '1');
        assert.equal(form.get('method'), 'post');
        assert.equal(form.get('regsense'), '1');
        assert.equal((form.get('file') as Blob).size, 120);
        submissions++;
        return Response.json({ status: 1, request: id });
      }
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(parsed.searchParams.get('key'), 'private-key');
      assert.equal(parsed.searchParams.get('id'), String(id));
      if (parsed.searchParams.get('action') === 'reportbad') {
        reports.push(String(id));
        return new Response('OK_REPORT_RECORDED');
      }
      return Response.json(
        ++polls === 1
          ? { status: '0', request: 'CAPCHA_NOT_READY' }
          : { status: '1', request: 'aBc12' },
      );
    }) as typeof fetch;
    const client = new CaptchaAiClient('private-key', 1000, fetcher, 1);
    assert.deepEqual(await client.solve(image, new AbortController().signal), {
      taskId: String(id),
      text: 'aBc12',
    });
    assert.equal(submissions, 1);
    assert.equal(polls, 2);
    await client.reportIncorrect(id);
    assert.equal(reports.length, 1);
  });
}

test('CaptchaAI supports legacy text replies and waits only after explicit busy rejection', async () => {
  let submits = 0,
    polls = 0;
  const logs: string[] = [];
  const fetcher = (async (url) => {
    if (String(url).endsWith('in.php')) {
      submits++;
      return submits === 1
        ? new Response('ERROR_ZERO_BALANCE')
        : submits === 2
          ? Response.json({ status: 0, request: 'ERROR_NO_SLOT_AVAILABLE' })
          : new Response('OK|1234');
    }
    polls++;
    return new Response(polls === 1 ? 'CAPCHA_NOT_READY' : 'OK|AB12');
  }) as typeof fetch;
  const result = await new CaptchaAiClient(
    'key',
    1000,
    fetcher,
    1,
    async (_, m) => {
      logs.push(m);
    },
    1,
  ).solve(image, new AbortController().signal);
  assert.equal(result.text, 'AB12');
  assert.equal(submits, 3);
  assert.equal(polls, 2);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((m) => m.includes('abonamentu')));
});

test('busy subscription has bounded waiting; cancellation does not submit another task', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ status: 0, request: 'ERROR_ZERO_BALANCE' });
  }) as typeof fetch;
  await assert.rejects(
    new CaptchaAiClient('key', 1000, fetcher, 1, undefined, 1, 12).solve(
      image,
      new AbortController().signal,
    ),
    hasCode('CAPTCHAAI_BUSY'),
  );
  assert.ok(calls >= 1 && calls < 15);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    new CaptchaAiClient(
      'key',
      1000,
      fetcher,
      1,
      async () => {
        controller.abort();
      },
      1,
    ).solve(image, controller.signal),
    hasCode('CAPTCHA_TIMEOUT'),
  );
  assert.equal(calls, 1);
});

test('transport, unknown response and invalid key errors are distinct and never resubmit or reveal secrets', async () => {
  for (const mode of ['network', 'response', 'key', 'http', 'poll-network']) {
    let calls = 0,
      submissions = 0;
    const logs: string[] = [];
    const fetcher = (async (url) => {
      calls++;
      if (String(url).endsWith('in.php')) {
        submissions++;
        if (mode === 'poll-network') return Response.json({ status: 1, request: 123 });
      }
      if (mode === 'network' || mode === 'poll-network')
        throw new Error('https://ocr.captchaai.com/res.php?key=private-key');
      if (mode === 'http') return new Response('private-key', { status: 503 });
      return Response.json({
        status: 0,
        request: mode === 'key' ? 'ERROR_KEY_DOES_NOT_EXIST' : 'private-key in arbitrary error',
      });
    }) as typeof fetch;
    const expected =
      mode === 'key'
        ? 'CAPTCHAAI_KEY'
        : mode === 'response'
          ? 'CAPTCHAAI_RESPONSE'
          : 'CAPTCHAAI_NETWORK';
    await assert.rejects(
      new CaptchaAiClient('private-key', 1000, fetcher, 1, async (_, m) => {
        logs.push(m);
      }).solve(image, new AbortController().signal),
      (e) => {
        assert.ok(!String(e).includes('private-key'));
        return hasCode(expected)(e);
      },
    );
    assert.equal(submissions, 1);
    assert.equal(calls, mode === 'poll-network' ? 2 : 1);
    assert.ok(!logs.join().includes('private-key'));
  }
});

test('pending result timeout polls the same task without duplicate submission', async () => {
  let submissions = 0;
  const fetcher = (async (url) => {
    if (String(url).endsWith('in.php')) {
      submissions++;
      return Response.json({ status: 1, request: 123 });
    }
    return Response.json({ status: 0, request: 'CAPCHA_NOT_READY' });
  }) as typeof fetch;
  await assert.rejects(
    new CaptchaAiClient('key', 20, fetcher, 1).solve(image, new AbortController().signal),
    hasCode('CAPTCHA_TIMEOUT'),
  );
  assert.equal(submissions, 1);
});

test('subscription counters have no status field and zero threads is not a money balance', async () => {
  for (const total of ['5', 0]) {
    const c = new CaptchaAiClient('private-key', 1000, (async (url, init) => {
      assert.equal(init?.method, 'POST');
      assert.ok(!String(url).includes('private-key'));
      assert.equal((init!.body as URLSearchParams).get('action'), 'threadsinfo');
      return Response.json({ threads: total, working_threads: 0 });
    }) as typeof fetch);
    assert.deepEqual(await c.getAccount(), { total: Number(total), busy: 0 });
  }
  for (const data of [
    { threads: '5' },
    { threads: null, working_threads: 0 },
    { threads: -1, working_threads: 0 },
    { status: 0, request: 'ERROR_KEY_DOES_NOT_EXIST' },
  ]) {
    await assert.rejects(
      new CaptchaAiClient('key', 1000, (async () =>
        Response.json(data)) as typeof fetch).getAccount(),
    );
  }
  let calls = 0;
  const cached = cachedCaptchaAiAccount(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { total: 5, busy: 2 };
  });
  const result = await Promise.all([cached(), cached(), cached()]);
  await cached();
  assert.equal(calls, 1);
  assert.equal(result[0].available, 3);
  assert.equal(result[0].status, 'ok');
  assert.ok(!('balance' in result[0]));
  const failed = await cachedCaptchaAiAccount(async () => {
    throw new Error('private-key');
  })();
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.total, null);
  assert.equal(failed.busy, null);
  assert.ok(!JSON.stringify(failed).includes('private-key'));
  assert.equal((await cachedCaptchaAiAccount(undefined)()).status, 'not_configured');
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
