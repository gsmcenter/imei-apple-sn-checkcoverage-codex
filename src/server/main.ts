import { readConfig, integrationsConfigured } from './config.js';
import { connectDatabase, migrate } from './database.js';
import { Repository } from './repository.js';
import { createApp } from './app.js';
import { AppleProvider } from './integrations/apple.js';
import { startWorker } from './worker.js';
import Fastify, { LogController } from 'fastify';

async function main() {
  const config = readConfig();
  const db = connectDatabase(config.DATABASE_URL);
  await migrate(db);
  const repo = new Repository(db, config);
  if (config.APP_ROLE !== 'web' && !integrationsConfigured(config)) {
    await db.close();
    throw new Error(
      'Worker wymaga klucza solvera oraz skonfigurowanego ProxyMesh lub PROXY_EXTRA_URLS.',
    );
  }
  const worker =
    config.APP_ROLE !== 'web'
      ? startWorker(repo, new AppleProvider(config, () => repo.reserveCaptcha()))
      : undefined;
  const app =
    config.APP_ROLE === 'worker'
      ? Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) })
      : await createApp(config, repo);
  if (config.APP_ROLE === 'worker') {
    for (const path of ['/healthz', '/api/health'])
      app.get(path, async (_, reply) => {
        try {
          await db.query('SELECT 1');
          return worker?.healthy()
            ? { status: 'ok' }
            : reply.code(503).send({ status: 'unavailable' });
        } catch {
          return reply.code(503).send({ status: 'unavailable' });
        }
      });
  }
  await app.listen({ port: config.PORT, host: config.HOST });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 25000).unref();
    await app.close();
    await worker?.close();
    await db.close();
    clearTimeout(timer);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
main().catch((e) => {
  // Never serialize driver/browser errors: they can include credentials or device identifiers.
  const configuration =
    e instanceof Error &&
    /^(Niepoprawna konfiguracja:|Worker wymaga|APP_ORIGIN|Produkcja wymaga|PROXY_SERVER)/.test(
      e.message,
    );
  console.error(
    configuration
      ? e.message
      : 'Nie udało się uruchomić aplikacji. Sprawdź konfigurację, połączenie z bazą i migracje.',
  );
  process.exitCode = 1;
});
