import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { embeddedDatabase } from './embedded-db.js';
import { migrate } from '../src/server/database.js';
import { readConfig } from '../src/server/config.js';
import { hashPassword } from '../src/server/security.js';
import { Repository } from '../src/server/repository.js';
import { createApp } from '../src/server/app.js';
import { startWorker } from '../src/server/worker.js';
import type { CoverageResult } from '../src/shared/types.js';

const port = Number(process.env.DEMO_PORT || 3000);
const config = readConfig({
  DATABASE_URL: 'demo-only',
  ADMIN_PASSWORD_HASH: await hashPassword('demo-coverage-2026'),
  SESSION_SECRET: randomUUID(),
  PORT: String(port),
  HOST: '127.0.0.1',
  APP_ORIGIN: `http://localhost:${port}`,
});
const db = await embeddedDatabase();
await migrate(db);
const repo = new Repository(db, config);
function sample(serial: string, i: number): CoverageResult {
  const model = ['iPhone 16 Pro', 'MacBook Air (M3)', 'Apple Watch Series 10', 'iPad Air (M2)'][
    i % 4
  ];
  const expired = i % 3 === 2;
  return {
    serial,
    model,
    coverageStatus: expired ? 'expired' : 'active',
    coverageLabel: expired ? 'Coverage Expired' : i % 2 ? 'Limited Warranty' : 'AppleCare+',
    expirationDate: expired ? 'May 12, 2026' : 'September 18, 2027',
    purchaseDate: 'September 18, 2025',
    renewalDate: null,
    details: ['Dane demonstracyjne'],
    rawText: `DANE DEMONSTRACYJNE — NIE POCHODZĄ Z APPLE\n${model}\nSerial Number: ${serial}\n${expired ? 'Coverage Expired' : 'Limited Warranty'}`,
    checkedAt: new Date().toISOString(),
    source: 'demo',
    sourceUrl: 'https://checkcoverage.apple.com/?locale=en_US',
  };
}
for (let i = 0; i < 6; i++) {
  const serial = `DEMO00000${i + 1}`;
  await db.query(
    "INSERT INTO checks(id,serial,status,stage,attempts,result,finished_at,created_at) VALUES($1,$2,'completed','done',1,$3::jsonb,now()-($4::int*interval '7 minutes'),now()-($4::int*interval '7 minutes'))",
    [randomUUID(), serial, JSON.stringify(sample(serial, i)), i + 1],
  );
}
const worker = startWorker(repo, {
  async check(serial, signal, stage) {
    await stage('opening');
    await delay(1500, undefined, { signal });
    await stage('solving');
    await delay(2500, undefined, { signal });
    await stage('reading');
    await delay(1000, undefined, { signal });
    return sample(serial, 0);
  },
});
const app = await createApp(config, repo, { demo: true });
await app.listen({ host: '127.0.0.1', port });
console.log(
  `DEMO: http://localhost:${port} — password: demo-coverage-2026. No external calls. Data resets on restart.`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await worker.close();
  await db.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
