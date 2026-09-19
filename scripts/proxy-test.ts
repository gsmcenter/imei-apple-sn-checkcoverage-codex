import dotenv from 'dotenv';
import { parseExtraProxies } from '../src/server/proxies.js';
import { testProxy } from '../src/server/proxy-probe.js';
dotenv.config({ path: process.env.PROXY_TEST_ENV ?? '.env', quiet: true });
try {
  const proxies = parseExtraProxies(process.env.PROXY_EXTRA_URLS);
  if (!proxies.length) throw new Error('Brak PROXY_EXTRA_URLS.');
  const results = await Promise.all(proxies.map((p) => testProxy({ ...p, provider: 'other' })));
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.configured.ok)) process.exitCode = 1;
} catch {
  console.error('Test nie został wykonany. Sprawdź konfigurację PROXY_EXTRA_URLS.');
  process.exitCode = 1;
}
