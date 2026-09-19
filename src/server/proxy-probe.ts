import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { ProxyProbeResult, ProxyTest } from '../shared/system.js';
import { SESSION_TOKEN, materializeProxy, type InternalProxy } from './proxies.js';
const paramNames =
  'country|region|city|state|zip|session|hardsession|lockedsession|lifetime|isp|asn|fraudscore|device|latency|pool|response|connection|udp|quic';
export function splitPassword(password: string) {
  const start = password.search(new RegExp(`_(?:${paramNames})-`, 'i'));
  return start < 0
    ? { base: password, params: [] as string[] }
    : { base: password.slice(0, start), params: password.slice(start + 1).split('_') };
}
export function stripPasswordParams(url: string) {
  const u = new URL(url.replaceAll(SESSION_TOKEN, 'diag0001'));
  u.password = encodeURIComponent(splitPassword(decodeURIComponent(u.password)).base);
  return u.toString();
}
export function describeProxyCredentials(url: string): ProxyTest['info'] {
  const u = new URL(url.replaceAll(SESSION_TOKEN, 'diag0001')),
    user = decodeURIComponent(u.username),
    pass = decodeURIComponent(u.password),
    { base, params } = splitPassword(pass),
    warnings: string[] = [];
  if (!user || !pass) warnings.push('Brak loginu lub hasła.');
  if (
    /^(login|username|user|haslo|hasło|password|pass)$/i.test(user) ||
    /^(login|haslo|hasło|password|pass)$/i.test(base)
  )
    warnings.push('Nieuzupełniony wzór LOGIN / HASLO / PASSWORD.');
  if (/["'<>\s]/.test(user + pass))
    warnings.push('Login lub hasło zawiera cudzysłowy, spacje albo nawiasy.');
  if (!u.port) warnings.push('Brak jawnego portu (Evomi HTTP: 1000).');
  const safeParams = params.map((p) => {
    const dash = p.indexOf('-'),
      name = p.slice(0, dash).toLowerCase(),
      value = p.slice(dash + 1);
    if (['session', 'hardsession', 'lockedsession'].includes(name)) {
      if (!/^[A-Za-z0-9]{6,10}$/.test(value))
        warnings.push('Identyfikator sesji musi mieć 6–10 znaków alfanumerycznych.');
      return `${name}-${url.includes(SESSION_TOKEN) ? SESSION_TOKEN : '[stały identyfikator]'}`;
    }
    if (name === 'lifetime') {
      if (!/^\d+$/.test(value) || +value < 1 || +value > 1440)
        warnings.push('lifetime musi być całkowitą liczbą minut 1–1440.');
      return `lifetime-${/^\d{1,4}$/.test(value) ? value : '[niepoprawny]'}`;
    }
    if (name === 'country') {
      if (!/^[A-Za-z]{2}$/.test(value)) warnings.push('country musi być dwuliterowym kodem kraju.');
      return `country-${/^[A-Za-z]{2}$/.test(value) ? value : '[niepoprawny]'}`;
    }
    return new RegExp(`^(${paramNames})$`, 'i').test(name)
      ? `${name}-[ustawiono]`
      : '[nierozpoznany parametr]';
  });
  if (
    params.some((p) => /^lifetime-/i.test(p)) &&
    (!params.some((p) => /^session-/i.test(p)) ||
      params.some((p) => /^(hard|locked)session-/i.test(p)))
  )
    warnings.push('lifetime działa tylko z session, bez hardsession / lockedsession.');
  if (
    u.hostname.endsWith('.evomi.com') &&
    !params.some((p) => /^(session|hardsession|lockedsession)-/i.test(p))
  )
    warnings.push(
      'Brak sticky session — rotating może przerwać sesję CAPTCHA. Dodaj session-{session}_lifetime-10.',
    );
  return {
    username:
      user.length <= 4 ? '•'.repeat(user.length) : `${user.slice(0, 2)}•••${user.slice(-2)}`,
    passwordLength: pass.length,
    basePasswordLength: base.length,
    params: safeParams,
    warnings,
  };
}
export function probeProxy(url: string, timeoutMs = 15000): Promise<ProxyProbeResult> {
  const u = new URL(url.replaceAll(SESSION_TOKEN, 'diag0001')),
    user = decodeURIComponent(u.username),
    pass = decodeURIComponent(u.password),
    auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const started = performance.now(),
    ms = () => Math.round(performance.now() - started);
  return new Promise((resolve) => {
    let settled = false,
      bodyTimer: ReturnType<typeof setTimeout> | undefined,
      socket: import('node:net').Socket | undefined;
    const finish = (r: ProxyProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(bodyTimer);
      socket?.destroy();
      req.destroy();
      resolve(r);
    };
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: 'checkcoverage.apple.com:443',
      headers: {
        Host: 'checkcoverage.apple.com:443',
        ...(user ? { 'Proxy-Authorization': `Basic ${auth}` } : {}),
      },
      agent: false,
    });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          ms: ms(),
          reason: 'Nie udało się połączyć: brak odpowiedzi w limicie czasu.',
        }),
      timeoutMs,
    );
    req.once('error', () =>
      finish({
        ok: false,
        ms: ms(),
        reason: 'Nie udało się połączyć z serwerem proxy. Sprawdź host, port i dostęp sieciowy.',
      }),
    );
    req.once('connect', (res, s, head) => {
      socket = s;
      const status = res.statusCode ?? 0,
        reported = res.headers['x-proxymesh-ip'];
      if (status === 200) {
        const ip =
          typeof reported === 'string' && isIP(reported) && u.hostname.endsWith('.proxymesh.com')
            ? reported
            : undefined;
        finish({ ok: true, status, ms: ms(), ...(ip ? { exitIp: ip } : {}) });
        return;
      }
      let body = head.subarray(0, 4096).toString('utf8');
      const done = () => {
        for (const secret of [pass, splitPassword(pass).base, user, encodeURIComponent(pass), auth]
          .filter(Boolean)
          .sort((a, b) => b.length - a.length))
          body = body.split(secret).join('[ukryto]');
        const reason = body
          .replace(/https?:\/\/\S+|Basic\s+\S+/gi, '[ukryto]')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160);
        finish({
          ok: false,
          status,
          ms: ms(),
          reason: reason || `Proxy odpowiedziało HTTP ${status}.`,
        });
      };
      s.on('data', (chunk: Buffer) => {
        if (body.length < 4096) body += chunk.toString('utf8').slice(0, 4096 - body.length);
      });
      s.once('close', done);
      s.once('error', done);
      bodyTimer = setTimeout(done, 400);
      s.resume();
    });
    req.end();
  });
}
export function diagnoseProxy(a: ProxyProbeResult, b: ProxyProbeResult) {
  if (a.ok) return 'Działa: tunel CONNECT zestawiony. Nie wysyłano żądania HTTP do Apple.';
  if (a.status === 407 && b.ok)
    return 'Login i hasło działają, ale dostawca odrzuca parametry. Sprawdź składnię parametrów w haśle.';
  if (a.status === 407 && b.status === 407)
    return 'Dostawca odrzuca login/hasło także bez parametrów. Możliwe: literówka (0/O, l/I), zresetowany klucz, nieaktywny plan, brak transferu lub IP spoza listy autoryzowanych. Skopiuj hasło ikonką z panelu.';
  if (!a.status)
    return 'Nie udało się połączyć. Sprawdź host, port i dostęp sieciowy; sam timeout nie rozstrzyga przyczyny.';
  return `Proxy odpowiedziało HTTP ${a.status}. ${b.status === undefined ? 'Test bez parametrów nie otrzymał odpowiedzi.' : ''}`.trim();
}
export async function testProxy(p: InternalProxy): Promise<ProxyTest> {
  const info = describeProxyCredentials(p.url),
    v = materializeProxy(p, 'diag0001'),
    u = new URL(v.server);
  u.username = encodeURIComponent(v.username);
  u.password = encodeURIComponent(v.password);
  const configured = await probeProxy(u.toString());
  const bareUrl = p.provider === 'proxymesh' ? p.url : stripPasswordParams(p.url);
  const bare = await probeProxy(bareUrl);
  return { label: p.label, info, configured, bare, diagnosis: diagnoseProxy(configured, bare) };
}
