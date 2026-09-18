import { embeddedDatabase } from '../scripts/embedded-db.js';
import { connectDatabase, migrate } from '../src/server/database.js';
import { readConfig } from '../src/server/config.js';
import { hashPassword } from '../src/server/security.js';
export async function setup() {
  const db = process.env.TEST_DATABASE_URL
    ? connectDatabase(process.env.TEST_DATABASE_URL)
    : await embeddedDatabase();
  await migrate(db);
  await db.query(
    'TRUNCATE checks,sessions,rate_limits,captcha_usage,worker_heartbeats; UPDATE queue_state SET last_started=NULL',
  );
  const config = readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'test',
    APP_ORIGIN: 'http://localhost:3000',
    ADMIN_PASSWORD_HASH: await hashPassword('correct-test-password'),
    SESSION_SECRET: 'test-secret-long-enough-for-validation',
    TWOCAPTCHA_API_KEY: 'test',
    PROXY_SERVER: 'http://us.proxymesh.com:31280',
    PROXY_USERNAME: 'test',
    PROXY_PASSWORD: 'test',
  });
  return { db, config };
}
