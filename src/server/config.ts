import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ROLE: z.enum(['web', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/),
  SESSION_SECRET: z.string().min(32),
  TWOCAPTCHA_API_KEY: optionalSecret,
  PROXY_SERVER: optionalSecret,
  PROXY_USERNAME: optionalSecret,
  PROXY_PASSWORD: optionalSecret,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MAX_CHECKS_PER_DAY: z.coerce.number().int().min(1).default(1500),
  MAX_CAPTCHAS_PER_DAY: z.coerce.number().int().min(1).default(3000),
  MAX_PENDING_CHECKS: z.coerce.number().int().min(1).default(200),
  MIN_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(3000),
  CHECK_TIMEOUT_MS: z.coerce.number().int().min(60000).max(600000).default(240000),
  CAPTCHA_TIMEOUT_MS: z.coerce.number().int().min(10000).max(180000).default(90000),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Niepoprawna konfiguracja: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const c = result.data;
  const origin = new URL(c.APP_ORIGIN);
  if (origin.origin !== c.APP_ORIGIN)
    throw new Error(
      'APP_ORIGIN musi zawierać wyłącznie protokół i domenę, bez końcowego ukośnika.',
    );
  if (c.NODE_ENV === 'production' && origin.protocol !== 'https:')
    throw new Error('Produkcja wymaga APP_ORIGIN z HTTPS.');
  if (c.PROXY_SERVER) {
    const proxy = new URL(c.PROXY_SERVER);
    if (
      !['http:', 'https:'].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== '/' ||
      proxy.search ||
      proxy.hash
    )
      throw new Error(
        'PROXY_SERVER musi być adresem HTTP(S) host:port; poświadczenia podaj osobno.',
      );
  }
  return c;
}
export function integrationsConfigured(c: Config): boolean {
  return Boolean(c.TWOCAPTCHA_API_KEY && c.PROXY_SERVER && c.PROXY_USERNAME && c.PROXY_PASSWORD);
}
