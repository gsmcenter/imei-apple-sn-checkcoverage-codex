import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { integrationsConfigured, solverConfigured } from './config.js';
import { Repository } from './repository.js';
import { AppError, normalizeSerial } from './errors.js';
import { newToken, privateKey, verifyPassword } from './security.js';
import { proxyModes, solverIds } from '../shared/system.js';
import { CaptchaClient } from './integrations/captcha.js';
import { cachedBalance } from './balance.js';
import { BatchRepository, batchCsv } from './batches.js';
import { MAX_IMPORT_BYTES } from '../shared/batches.js';

const idSchema = z.string().uuid();
export async function createApp(
  config: Config,
  repo: Repository,
  options: {
    demo?: boolean;
    logger?: boolean;
    workerHealthy?: () => boolean;
    readBalance?: () => Promise<number>;
  } = {},
) {
  const app = Fastify({
    bodyLimit: 4096,
    trustProxy: config.TRUST_PROXY === 'true',
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  const cookieName =
    config.NODE_ENV === 'production' ? '__Host-coverage_session' : 'coverage_session';
  const cookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 43200,
  };
  async function authenticated(token?: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    return (
      (
        await repo.db.query(
          'SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>now()',
          [privateKey(token, config.SESSION_SECRET)],
        )
      ).rows.length === 1
    );
  }
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin !== config.APP_ORIGIN)
        return reply.code(403).send({ error: 'Żądanie pochodzi z niedozwolonej strony.' });
      if (req.headers['sec-fetch-site'] === 'cross-site')
        return reply.code(403).send({ error: 'Niedozwolone żądanie.' });
    }
    const publicRoute =
      (req.method === 'GET' && req.url === '/api/session') ||
      (req.method === 'POST' && req.url === '/api/login');
    if (!publicRoute && !(await authenticated(req.cookies[cookieName])))
      return reply.code(401).send({ error: 'Zaloguj się, aby kontynuować.' });
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError)
      return reply.code(error.status).send({ error: error.message, code: error.code });
    if (error instanceof ZodError)
      return reply.code(400).send({ error: 'Niepoprawne dane żądania.' });
    if (error instanceof Error && 'publicMessage' in error && 'statusCode' in error)
      return reply.code(Number(error.statusCode)).send({ error: error.publicMessage });
    const candidate =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : 500;
    const status =
      typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    if (status === 500)
      app.log.error({ event: 'request_failed', requestId: req.id }, 'Request failed');
    return reply.code(status).send({
      error:
        status === 409
          ? 'Konflikt klucza żądania. Odśwież stronę.'
          : status === 500
            ? 'Wystąpił błąd serwera.'
            : 'Niepoprawne żądanie.',
    });
  });
  app.get('/healthz', async (_, reply) => {
    try {
      await repo.db.query('SELECT 1');
      if (options.workerHealthy && !options.workerHealthy())
        return reply.code(503).send({ status: 'unavailable' });
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/api/session', async (req) => ({
    authenticated: await authenticated(req.cookies[cookieName]),
    demo: !!options.demo,
  }));
  app.post('/api/login', async (req, reply) => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    const ipKey = privateKey(req.ip, config.SESSION_SECRET);
    // Database counters apply across replicas and restarts, and never store raw IP addresses.
    const globalAllowed = await repo.rateLimit('login:global', 60, 900);
    const ipAllowed = await repo.rateLimit(`login:${ipKey}`, 10, 900);
    if (!globalAllowed || !ipAllowed)
      return reply
        .header('Retry-After', '900')
        .code(429)
        .send({ error: 'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.' });
    if (!(await verifyPassword(password, config.ADMIN_PASSWORD_HASH)))
      return reply.code(401).send({ error: 'Nieprawidłowe hasło.' });
    const token = newToken();
    await repo.db.query(
      "INSERT INTO sessions(token_hash,expires_at) VALUES($1,now()+interval '12 hours')",
      [privateKey(token, config.SESSION_SECRET)],
    );
    reply.setCookie(cookieName, token, cookieOptions);
    return { authenticated: true };
  });
  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies[cookieName];
    if (token)
      await repo.db.query('DELETE FROM sessions WHERE token_hash=$1', [
        privateKey(token, config.SESSION_SECRET),
      ]);
    reply.clearCookie(cookieName, cookieOptions);
    return { authenticated: false };
  });
  app.get('/api/v1/overview', async () => repo.overview(!!options.demo));
  const balance = cachedBalance(
    options.readBalance ??
      (config.TWOCAPTCHA_API_KEY
        ? () =>
            new CaptchaClient(config.TWOCAPTCHA_API_KEY!, config.CAPTCHA_TIMEOUT_MS).getBalance()
        : undefined),
    !!options.demo,
  );
  app.get('/api/v1/system', async () => repo.system(!!options.demo));
  app.get('/api/v1/system/balance', async () => balance());
  app.post('/api/v1/system/settings', async (req) => {
    const settings = z
      .object({
        proxyMode: z.enum(proxyModes),
        solverId: z.enum(solverIds),
      })
      .strict()
      .parse(req.body);
    if (!options.demo && !solverConfigured(config, settings.solverId))
      throw new AppError('NOT_CONFIGURED', 503);
    return repo.saveSettings(settings);
  });
  app.get('/api/v1/checks', async (req) => {
    const q = z
      .object({
        search: z
          .string()
          .regex(/^[A-Za-z0-9]*$/)
          .max(12)
          .default(''),
        status: z.enum(['', 'queued', 'running', 'completed', 'failed']).default(''),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .parse(req.query);
    return repo.list(q.search.toUpperCase(), q.status, q.page);
  });
  const batches = new BatchRepository(repo);
  const batchInput = z
    .object({
      name: z.string().trim().min(1).max(120),
      notes: z.string().trim().max(2000).default(''),
      text: z.string().max(MAX_IMPORT_BYTES).default(''),
      ignoreInvalid: z.boolean().default(false),
      paused: z.boolean().default(false),
    })
    .strict();
  const batchQuery = z.object({
    search: z
      .string()
      .regex(/^[A-Za-z0-9]*$/)
      .max(12)
      .default(''),
    status: z
      .enum(['', 'waiting', 'queued', 'running', 'completed', 'failed', 'cancelled'])
      .default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  });
  app.get('/api/v1/batches', async (req) => {
    const q = z
      .object({
        search: z.string().max(120).default(''),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .parse(req.query);
    return batches.list(q.search, q.page);
  });
  app.post('/api/v1/batches', { bodyLimit: MAX_IMPORT_BYTES * 2 }, async (req, reply) => {
    const input = batchInput.parse(req.body),
      key = idSchema.parse(req.headers['idempotency-key']);
    if (!(await repo.rateLimit('batches:submit', 10, 60)))
      return reply.code(429).send({ error: 'Poczekaj minutę przed dodaniem kolejnej paczki.' });
    const result = await batches.create(input, key);
    return reply.code(result.reused ? 200 : 202).send(result);
  });
  app.get('/api/v1/batches/:id', async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params),
      q = batchQuery.parse(req.query);
    return batches.detail(id, q.search.toUpperCase(), q.status, q.page);
  });
  app.get('/api/v1/batches/:id/export.csv', async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params),
      q = batchQuery.parse(req.query);
    const detail = await batches.detail(id, q.search.toUpperCase(), q.status, 1, true);
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="batch-${id}.csv"`)
      .send(batchCsv(detail));
  });
  app.post('/api/v1/batches/:id', async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const patch = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        notes: z.string().trim().max(2000).optional(),
        state: z.enum(['active', 'paused', 'cancelled']).optional(),
      })
      .strict()
      .parse(req.body);
    return batches.update(id, patch);
  });
  app.post('/api/v1/batches/:id/retry', async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const input = batchInput.omit({ text: true, ignoreInvalid: true }).parse(req.body),
      key = idSchema.parse(req.headers['idempotency-key']);
    if (!(await repo.rateLimit('batches:submit', 10, 60)))
      return reply.code(429).send({ error: 'Poczekaj minutę przed dodaniem kolejnej paczki.' });
    const result = await batches.create({ ...input, text: '', ignoreInvalid: false }, key, id);
    return reply.code(result.reused ? 200 : 202).send(result);
  });
  app.get('/api/v1/checks/:id', async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const check = await repo.get(id);
    return check ?? reply.code(404).send({ error: 'Nie znaleziono sprawdzenia.' });
  });
  app.post('/api/v1/checks', async (req, reply) => {
    const serial = normalizeSerial(z.object({ serial: z.string() }).parse(req.body).serial);
    const key = idSchema.parse(req.headers['idempotency-key']);
    if (
      !options.demo &&
      (!integrationsConfigured(config) ||
        !solverConfigured(config, (await repo.settings()).solverId))
    )
      throw new AppError('NOT_CONFIGURED', 503);
    if (!(await repo.workerOnline())) throw new AppError('WORKER_OFFLINE', 503);
    if (!(await repo.rateLimit('checks:submit', 60, 60)))
      return reply
        .header('Retry-After', '60')
        .code(429)
        .send({ error: 'Zbyt wiele nowych sprawdzeń. Poczekaj minutę.' });
    const result = await repo.enqueue(serial, key);
    return reply.code(result.reused ? 200 : 202).send(result);
  });
  const root = path.resolve('dist/public');
  if (existsSync(root)) {
    await app.register(staticFiles, { root, index: 'index.html', maxAge: 0 });
  } else {
    app.get('/', async (_, reply) =>
      reply.type('text/plain').send('Uruchom npm run build lub interfejs przez npm run dev:ui.'),
    );
  }
  return app;
}
