import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  parseExtraProxies,
  proxyCatalog,
  materializeProxy,
  redactProxySecrets,
} from '../src/server/proxies.js';
import { probeProxy, testProxy, describeProxyCredentials } from '../src/server/proxy-probe.js';
import { setup } from './helpers.js';
import { Repository } from '../src/server/repository.js';
import { createApp } from '../src/server/app.js';
import { BatchRepository, batchCsv } from '../src/server/batches.js';
import { AppleProvider, type Execution } from '../src/server/integrations/apple.js';
import type { SessionMeasurement } from '../src/shared/system.js';
import type { Browser, Page } from 'playwright';
const secret = 'safe-test-private-key';
const extra = `evomi-de=http://privateuser:${secret}_country-DE_session-{session}_lifetime-10@core-residential.evomi.com:1000`;

test('extra proxy parser accepts named/unnamed entries and rejects malformed values without echoing credentials', () => {
  const p = parseExtraProxies(extra + ',\nhttp://user:pw@localhost:1234');
  assert.equal(p.length, 2);
  assert.equal(p[1].label, 'localhost:1234');
  for (const raw of [
    extra.replace('http:', 'https:'),
    extra + '\n' + extra,
    extra.replace('evomi-de=', 'random='),
    extra.replace('evomi-de=', 'direct='),
    `http://user:${secret}`,
    `=http://user:${secret}@localhost:1`,
    `${secret}@wrong=http://user:pass@host:1`,
    extra.replace(':1000', ':99999'),
  ])
    assert.throws(
      () => parseExtraProxies(raw),
      (e) => e instanceof Error && !e.message.includes(secret),
    );
});
test('sessions are fresh, preserve lifetime and never put provider headers on Chromium requests', async () => {
  const { db, config } = await setup();
  try {
    config.PROXY_EXTRA_URLS = extra;
    const p = proxyCatalog(config).find((x) => x.label === 'evomi-de')!;
    const a = materializeProxy(p),
      b = materializeProxy(p);
    assert.notEqual(a.password, b.password);
    assert.match(a.password, /_session-[a-f0-9]{8}_lifetime-10$/);
    assert.equal(a.username, 'privateuser');
    assert.equal(a.server, 'http://core-residential.evomi.com:1000');
    assert.deepEqual(Object.keys(a).sort(), ['password', 'server', 'username']);
    assert.ok(
      !redactProxySecrets(`${p.url} ${secret} ${encodeURIComponent(secret)}`, config).includes(
        secret,
      ),
    );
    const info = describeProxyCredentials(
      `http://LOGIN:PASSWORD_country-GERMANY_session-x_lifetime-1441@host`,
    );
    assert.ok(info.warnings.length >= 4);
    assert.ok(!JSON.stringify(info).includes('PASSWORD_country'));
  } finally {
    await db.close();
  }
});
async function fakeProxy(rejectParams = false, delayMs = 0) {
  const requests: http.IncomingHttpHeaders[] = [],
    targets: string[] = [];
  const server = http.createServer();
  server.on('connect', (req, socket) => {
    requests.push(req.headers);
    targets.push(req.url!);
    const auth = Buffer.from(
      String(req.headers['proxy-authorization']).replace('Basic ', ''),
      'base64',
    ).toString();
    const good =
      auth === `privateuser:${secret}` ||
      (!rejectParams && auth.startsWith(`privateuser:${secret}_`));
    setTimeout(() => {
      socket.write(
        `HTTP/1.1 ${good ? '200 Connection Established' : '407 Proxy Authentication Required'}\r\n\r\n`,
      );
      if (!good) setTimeout(() => socket.end('Something went wrong'), 25);
      else socket.end();
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://privateuser:${secret}_country-DE_session-{session}_lifetime-10@127.0.0.1:${port}`,
    requests,
    targets,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
test('CONNECT diagnostics separate credentials/parameters/connectivity, read delayed 407 body and send no target request or ProxyMesh headers', async () => {
  for (const mode of ['ok', 'parameters', 'credentials'] as const) {
    const fake = await fakeProxy(mode === 'parameters', 10);
    try {
      const r = await testProxy({
        label: 'evomi-test',
        provider: 'evomi',
        url: mode === 'credentials' ? fake.url.replace(secret, 'wrong-secret') : fake.url,
      });
      if (mode === 'ok') {
        assert.equal(r.configured.status, 200);
        assert.equal(r.configured.exitIp, undefined);
      }
      if (mode === 'parameters') {
        assert.equal(r.configured.status, 407);
        assert.equal(r.bare.status, 200);
        assert.match(r.diagnosis, /parametry/);
      }
      if (mode === 'credentials') {
        assert.equal(r.configured.reason, 'Something went wrong');
        assert.equal(r.bare.status, 407);
        assert.match(r.diagnosis, /login\/hasło/);
      }
      assert.ok(!JSON.stringify(r).includes(secret));
      assert.ok(
        fake.requests.every((h) => Object.keys(h).every((k) => !k.startsWith('x-proxymesh-'))),
      );
      assert.deepEqual(fake.targets, [
        'checkcoverage.apple.com:443',
        'checkcoverage.apple.com:443',
      ]);
    } finally {
      await fake.close();
    }
  }
  const closed = await fakeProxy();
  await closed.close();
  const r = await probeProxy(closed.url, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.status, undefined);
  assert.match(r.reason!, /Nie udało/);
});
test('stored settings validate independently, checks keep proxy across retries, telemetry medians and API/CSV contain no secrets', async () => {
  const { db, config } = await setup();
  config.PROXY_EXTRA_URLS = extra;
  const repo = new Repository(db, config);
  try {
    await repo.saveSettings({ proxyMode: 'evomi-de', solverId: 'captchaai' });
    config.PROXY_EXTRA_URLS = extra.replace('evomi-de=', 'evomi-nl=');
    assert.equal((await repo.settings()).solverId, 'captchaai');
    assert.notEqual((await repo.settings()).proxyMode, 'evomi-de');
    await repo.saveSettings({ proxyMode: 'evomi-nl', solverId: '2captcha' });
    await repo.enqueue('TESTSN0001', randomUUID());
    const batches = new BatchRepository(repo);
    const batch = await batches.create(
      { name: 'Evomi test', notes: '', text: 'TESTSN0001', ignoreInvalid: false, paused: false },
      randomUUID(),
    );
    await batches.dispatch();
    const first = (await repo.claim())!;
    const sid = await repo.beginSession(first.id, first.token, first.proxy);
    await repo.endSession(first.id, first.token, sid, {
      appleMs: 100,
      limited: true,
      stage: 'captcha',
      stages: ['opening', 'captcha'],
      outcome: 'rate_limited',
    });
    await db.query("UPDATE checks SET lease_until=now()-interval '1 second'");
    await repo.recover();
    await db.query('UPDATE queue_state SET last_started=NULL');
    await repo.saveSettings({ proxyMode: 'random', solverId: '2captcha' });
    const second = (await repo.claim())!;
    assert.equal(second.proxy, 'evomi-nl');
    assert.equal(second.priorRateLimits, 1);
    const sid2 = await repo.beginSession(second.id, second.token, second.proxy);
    await repo.endSession(second.id, second.token, sid2, {
      appleMs: 300,
      limited: false,
      stage: 'result',
      stages: ['opening', 'captcha', 'submit', 'result'],
      outcome: 'completed',
    });
    await repo.diagnostic(second.id, second.token, 'redact', extra + ' ' + secret);
    await repo.finish(second.id, second.token, null, null);
    const stats = await repo.system();
    assert.equal(stats.proxyPerformance[0].averageMs, 400);
    assert.equal(stats.proxyPerformance[0].medianMs, 400);
    assert.equal(stats.proxyPerformance[0].sessions, 2);
    assert.equal(
      stats.limits.find((x) => x.dimension === 'stage' && x.name === 'captcha')?.limited,
      1,
    );
    const app = await createApp(config, repo, { logger: false });
    try {
      assert.equal((await app.inject('/api/health')).statusCode, 200);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/proxies/test',
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
      for (const url of ['/api/v1/system', '/api/v1/overview', `/api/v1/checks/${first.id}`]) {
        const r = await app.inject({ url, cookies });
        assert.equal(r.statusCode, 200);
        assert.ok(!r.body.includes(secret));
        assert.ok(!r.body.includes('privateuser'));
      }
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/proxies/test',
            cookies,
            headers: { origin: 'https://evil.example' },
            payload: {},
          })
        ).statusCode,
        403,
      );
      const dump = await db.query('SELECT to_jsonb(c) AS data FROM checks c');
      assert.ok(!JSON.stringify(dump.rows).includes(secret));
      const csv = batchCsv(await batches.detail(batch.id));
      assert.ok(csv.includes('evomi-nl'));
      assert.ok(csv.includes('Apple ms'));
      assert.ok(!csv.includes(secret));
      assert.ok(!csv.includes('privateuser'));
      const sessions = (await repo.get(first.id))!.proxySessions!;
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].limited, true);
      assert.equal(sessions[0].proxy, 'evomi-nl');
    } finally {
      await app.close();
    }
  } finally {
    await db.close();
  }
});

test('authenticated proxy diagnostics execute only configured labels and never expose credentials', async () => {
  const { db, config } = await setup();
  const fake = await fakeProxy();
  config.PROXY_EXTRA_URLS = `evomi-test=${fake.url}`;
  const app = await createApp(config, new Repository(db, config), { logger: false });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: config.APP_ORIGIN },
      payload: { password: 'correct-test-password' },
    });
    const cookies = { coverage_session: login.cookies[0].value };
    const request = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/proxies/test',
        headers: { origin: config.APP_ORIGIN },
        cookies,
        payload: payload as object,
      });
    assert.equal((await request({ url: fake.url })).statusCode, 400);
    assert.equal((await request({ label: 'not-configured' })).statusCode, 400);
    const result = await request({ label: 'evomi-test' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().items[0].configured.status, 200);
    assert.equal(result.json().items[0].bare.status, 200);
    assert.ok(!result.body.includes(secret));
    assert.ok(!result.body.includes('privateuser'));
    assert.equal(fake.requests.length, 2);
  } finally {
    await app.close();
    await fake.close();
    await db.close();
  }
});

function fakeBrowser(rateAt: 'opening' | 'captcha' | null): Browser {
  let reads = 0,
    submitted = false,
    serial = '',
    captcha = '';
  const body = () => {
    reads++;
    if (rateAt === 'opening' || (rateAt === 'captcha' && reads >= 3))
      return "We'll be back. We're busy updating our support tools.";
    return submitted
      ? `iPhone 16\nSerial Number: TESTSN0001\nLimited Warranty`
      : 'Enter a serial number';
  };
  const input = (cap = false) => ({
    isVisible: async () => !submitted,
    inputValue: async () => (cap ? captcha : serial),
    fill: async (v: string) => {
      if (cap) captcha = v;
      else serial = v;
    },
    pressSequentially: async (v: string) => {
      if (cap) captcha += v;
      else serial += v;
    },
    press: async () => {},
  });
  const page = {
    setDefaultTimeout: () => {},
    goto: async () => ({ status: () => 200, ok: () => true }),
    url: () => 'https://checkcoverage.apple.com/',
    isClosed: () => false,
    locator: (s: string) =>
      s === 'body'
        ? { innerText: async () => body() }
        : s === '#serial-number-input'
          ? input()
          : s === '#captcha-input'
            ? input(true)
            : { allInnerTexts: async () => ['iPhone 16', 'Limited Warranty'] },
    getByRole: (role: string) =>
      role === 'img'
        ? {
            isVisible: async () => true,
            getAttribute: async () => 'data:image/png;base64,' + 'YQ=='.repeat(50),
          }
        : {
            click: async () => {
              submitted = true;
            },
          },
    waitForFunction: async () => {},
  } as unknown as Page;
  return {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {},
  } as unknown as Browser;
}
test('Apple rate limits on landing and CAPTCHA get fresh sessions on the same proxy; exhausted limits never pay for CAPTCHA', async () => {
  const { db, config } = await setup();
  config.PROXY_EXTRA_URLS = extra;
  try {
    for (const phase of ['opening', 'captcha'] as const) {
      const records: SessionMeasurement[] = [],
        passwords: string[] = [],
        events: string[] = [];
      let calls = 0,
        paid = 0;
      const exec: Execution = {
        proxy: 'evomi-de',
        solver: '2captcha',
        beginSession: async () => randomUUID(),
        endSession: async (_, m) => {
          records.push(m);
        },
        log: async (step) => {
          events.push(step);
        },
        beginCaptcha: async () => randomUUID(),
        endCaptcha: async () => {},
      };
      const provider = new AppleProvider(
        config,
        async () => {
          paid++;
        },
        async (options) => {
          passwords.push(options!.proxy!.password!);
          return fakeBrowser(calls++ === 0 ? phase : null);
        },
        () => ({
          solve: async () => ({ text: 'ABCD', taskId: '1' }),
          reportIncorrect: async () => {},
        }),
      );
      await provider.check('TESTSN0001', new AbortController().signal, async () => {}, exec);
      assert.equal(records.length, 2);
      assert.equal(records[0].limited, true);
      assert.equal(records[0].stage, phase);
      assert.equal(records[1].outcome, 'completed');
      assert.notEqual(passwords[0], passwords[1]);
      assert.equal(paid, 1);
      assert.ok(events.includes('apple_rate_limit'));
      calls = 0;
      paid = 0;
      records.length = 0;
      const always = new AppleProvider(
        config,
        async () => {
          paid++;
        },
        async () => {
          calls++;
          return fakeBrowser(phase);
        },
      );
      await assert.rejects(
        always.check('TESTSN0001', new AbortController().signal, async () => {}, exec),
        (e: unknown) => (e as { code: string }).code === 'APPLE_RATE_LIMITED',
      );
      assert.equal(calls, config.RATE_LIMIT_RETRIES + 1);
      assert.equal(paid, 0);
      assert.equal(records.filter((r) => r.limited).length, 4);
    }
  } finally {
    await db.close();
  }
});
