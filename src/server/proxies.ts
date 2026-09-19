import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { proxyHosts } from '../shared/system.js';
export const SESSION_TOKEN = '{session}';
export interface ExtraProxy {
  label: string;
  url: string;
}
export interface InternalProxy extends ExtraProxy {
  provider: 'proxymesh' | 'evomi' | 'other';
}
function invalid(field: string, why: string): never {
  throw new Error(`Niepoprawna konfiguracja: ${field}: ${why}`);
}
export function proxyUrl(raw: string, field = 'PROXY_EXTRA_URLS') {
  try {
    const p = new URL(raw.replaceAll(SESSION_TOKEN, 'sessiontoken'));
    if (p.protocol !== 'http:' || p.pathname !== '/' || p.search || p.hash || !p.hostname)
      invalid(field, 'wymagany adres http://login:haslo@host:port bez ścieżki i parametrów URL');
    decodeURIComponent(p.username);
    decodeURIComponent(p.password);
    if (
      raw.includes(SESSION_TOKEN) &&
      !decodeURIComponent(p.username + ' ' + p.password).includes('sessiontoken')
    )
      invalid(field, 'token sesji jest dozwolony wyłącznie w danych logowania');
    return p;
  } catch {
    invalid(field, 'wymagany poprawny adres HTTP; hasła i znaki specjalne koduj procentowo');
  }
}
export function parseExtraProxies(raw: string | undefined): ExtraProxy[] {
  const extras: ExtraProxy[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const eq = entry.indexOf('='),
      labelled = eq > 0 && !entry.slice(0, eq).includes('://');
    const url = labelled ? entry.slice(eq + 1) : entry,
      p = proxyUrl(url);
    const label = (labelled ? entry.slice(0, eq) : p.host).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{0,59}$/.test(label) || ['random', 'direct'].includes(label))
      invalid('PROXY_EXTRA_URLS', 'niedozwolona nazwa wpisu');
    if (extras.some((x) => x.label === label))
      invalid('PROXY_EXTRA_URLS', 'nazwy wpisów muszą być unikalne');
    extras.push({ label, url });
  }
  if (extras.length > 30) invalid('PROXY_EXTRA_URLS', 'maksymalnie 30 wpisów');
  return extras;
}
export function meshHosts(c: Config): string[] {
  const hosts = (c.PROXY_HOSTS ?? proxyHosts.join(','))
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  if (
    hosts.some(
      (x) =>
        !/^([a-z0-9-]+\.)*proxymesh\.com:\d{1,5}$/.test(x) ||
        Number(x.split(':')[1]) < 1 ||
        Number(x.split(':')[1]) > 65535,
    ) ||
    new Set(hosts).size !== hosts.length
  )
    invalid('PROXY_HOSTS', 'wymagane unikalne hosty ProxyMesh z portem');
  return hosts;
}
export function proxyCatalog(c: Config): InternalProxy[] {
  const hosts = meshHosts(c),
    extras = parseExtraProxies(c.PROXY_EXTRA_URLS);
  if (extras.some((x) => hosts.includes(x.label)))
    invalid('PROXY_EXTRA_URLS', 'nazwa koliduje z serwerem ProxyMesh');
  let base: URL | undefined;
  if (c.PROXY_URL) base = proxyUrl(c.PROXY_URL, 'PROXY_URL');
  else if (c.PROXY_SERVER && c.PROXY_USERNAME && c.PROXY_PASSWORD) {
    base = new URL(c.PROXY_SERVER);
    base.username = encodeURIComponent(c.PROXY_USERNAME);
    base.password = encodeURIComponent(c.PROXY_PASSWORD);
  }
  const mesh: InternalProxy[] = base
    ? hosts.map((label) => {
        const u = new URL(base!.toString());
        u.host = label;
        return { label, url: u.toString(), provider: 'proxymesh' };
      })
    : [];
  return [
    ...mesh,
    ...extras.map((e) => ({
      ...e,
      provider: (new URL(e.url.replaceAll(SESSION_TOKEN, 'x')).hostname.endsWith('.evomi.com')
        ? 'evomi'
        : 'other') as 'evomi' | 'other',
    })),
  ];
}
export function proxyChoices(c: Config, demo = false) {
  const catalog = proxyCatalog(c);
  return catalog.length
    ? catalog.map(({ label, provider }) => ({ label, provider }))
    : demo
      ? meshHosts(c).map((label) => ({ label, provider: 'proxymesh' as const }))
      : [];
}
export function materializeProxy(proxy: InternalProxy, session = randomBytes(4).toString('hex')) {
  const u = new URL(proxy.url.replaceAll(SESSION_TOKEN, session));
  let username = decodeURIComponent(u.username),
    password = decodeURIComponent(u.password);
  if (proxy.provider === 'proxymesh') username = `${username}:${session}`;
  return { server: `${u.protocol}//${u.host}`, username, password };
}
// Central redaction also covers URL-encoded, Basic-auth and parameterised forms.
export function redactProxySecrets(text: string, c: Config): string {
  const secrets: string[] = [];
  for (const p of proxyCatalog(c)) {
    const u = new URL(p.url.replaceAll(SESSION_TOKEN, 'sessiontoken'));
    const user = decodeURIComponent(u.username),
      pass = decodeURIComponent(u.password);
    const base = pass.split(
      /_(?=(?:country|region|city|state|zip|session|hardsession|lockedsession|lifetime|isp|asn|fraudscore|device|latency|pool|response|connection|udp|quic)-)/i,
    )[0];
    secrets.push(
      p.url,
      u.username,
      u.password,
      user,
      pass,
      base,
      encodeURIComponent(base),
      Buffer.from(`${user}:${pass}`).toString('base64'),
    );
  }
  let safe = text;
  for (const s of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.split(s).join('[ukryto]');
  return safe
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [ukryto]')
    .replace(/https?:\/\/[^\s]+/g, '[adres URL]');
}
