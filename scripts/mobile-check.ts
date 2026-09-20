// Isolated headless regression test. Uses only in-memory demo data and localhost.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { embeddedDatabase } from './embedded-db.js';
import { migrate } from '../src/server/database.js';
import { readConfig } from '../src/server/config.js';
import { hashPassword } from '../src/server/security.js';
import { Repository } from '../src/server/repository.js';
import { BatchRepository } from '../src/server/batches.js';
import { createApp } from '../src/server/app.js';

const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'demo-only',
  SESSION_SECRET: randomUUID(),
  ADMIN_PASSWORD_HASH: await hashPassword('mobile-demo-password'),
});
config.MIN_CHECK_INTERVAL_MS = 0;
const db = await embeddedDatabase();
await migrate(db);
const repo = new Repository(db, config);
const batches = new BatchRepository(repo);
const app = await createApp(config, repo, { demo: true, logger: false });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
config.APP_ORIGIN = base;
await mkdir('.local/mobile-check', { recursive: true });
try {
  const batch = await batches.create(
    {
      name: 'Test mobilny — dostawa urządzeń Apple',
      notes: 'Długa notatka do sprawdzenia zawijania tekstu. '.repeat(12),
      text: 'DEMO000001\nDEMO000002',
      ignoreInvalid: false,
      paused: false,
    },
    randomUUID(),
  );
  await batches.dispatch();
  for (let i = 0; i < 2; i++) {
    const job = (await repo.claim())!;
    await repo.finish(
      job.id,
      job.token,
      i === 0
        ? {
            serial: job.serial,
            model: 'iPhone 17 Pro Max',
            coverageStatus: 'active',
            coverageLabel: 'Limited Warranty',
            expirationDate: null,
            purchaseDate: null,
            renewalDate: null,
            details: [],
            rawText: 'Wyłącznie dane demonstracyjne.',
            checkedAt: new Date().toISOString(),
            source: 'demo',
            sourceUrl: 'https://checkcoverage.apple.com/',
          }
        : null,
      i === 0 ? null : 'PROXY_ERROR',
    );
  }
  // Windows WebKit inherits OS DPI scaling and reports inconsistent viewport
  // dimensions. CI runs both engines on Linux; local Windows runs Chromium.
  const engines =
    process.platform === 'win32' || process.env.MOBILE_ENGINE === 'chromium'
      ? [chromium]
      : [chromium, webkit];
  for (const engine of engines) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [320, 393, 430, 768, 1440]) {
        const context = await browser.newContext({
          viewport: { width, height: 852 },
          isMobile: width < 800,
          hasTouch: width < 800,
        });
        // Refuse accidental traffic to Apple, CAPTCHA providers or any other external service.
        await context.route('**/*', (route) =>
          route.request().url().startsWith(base) ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(base);
        await page.getByLabel('Hasło dostępu').fill('mobile-demo-password');
        await page.getByRole('button', { name: 'Otwórz panel' }).click();
        async function check(view: string) {
          await page.evaluate(() => document.fonts.ready);
          const size = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            doc: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            main: document.querySelector('.main-wrap')!.getBoundingClientRect().width,
            overflow: [...document.querySelectorAll<HTMLElement>('body *')]
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  r.right > document.documentElement.clientWidth + 1 &&
                  !el.closest('.table-scroll,.system-table-wrap')
                );
              })
              .slice(0, 8)
              .map((el) => ({
                tag: el.tagName,
                cls: el.className,
                width: el.getBoundingClientRect().width,
              })),
          }));
          assert.ok(
            size.doc <= size.width + 1,
            `${engine.name()} ${width} ${view}: ${JSON.stringify(size)}`,
          );
          assert.ok(size.body <= size.width + 1, `${view}: body wider than viewport`);
          if (width < 800) assert.ok(Math.abs(size.main - width) < 2, `${view}: narrow main area`);
          if (width === 393)
            await page.screenshot({
              path: `.local/mobile-check/${engine.name()}-${view}.png`,
              fullPage: true,
            });
          console.log(
            `${engine.name()} ${width}px ${view}: viewport=${size.width}, document=${size.doc}`,
          );
        }
        await page.getByRole('button', { name: 'Szczegóły DEMO000001', exact: true }).waitFor();
        await check('overview');
        await page
          .getByRole('navigation')
          .getByRole('button', { name: /Historia sprawdzeń/ })
          .click();
        await page.getByRole('heading', { name: 'Historia sprawdzeń.' }).waitFor();
        await check('history');
        if (width <= 700) {
          const cellLayout = await page
            .locator('.record-table tbody td')
            .evaluateAll((cells) =>
              cells.every((cell) => getComputedStyle(cell).display === 'block'),
            );
          assert.ok(cellLayout, 'Mobile records must stack into cards');
        }
        await page.getByRole('button', { name: 'Szczegóły DEMO000001', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await check('check-detail');
        await page.getByRole('button', { name: 'Zamknij szczegóły', exact: true }).click();
        await page
          .getByRole('navigation')
          .getByRole('button', { name: 'Paczki SN', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: 'Otwórz paczkę Test mobilny — dostawa urządzeń Apple',
            exact: true,
          })
          .waitFor();
        await check('batches');
        await page.getByRole('button', { name: 'Nowa paczka', exact: true }).click();
        await page.getByLabel('Nazwa paczki', { exact: true }).waitFor();
        await check('batch-create');
        await page.getByRole('button', { name: 'Zamknij formularz', exact: true }).click();
        await page
          .getByRole('button', {
            name: 'Otwórz paczkę Test mobilny — dostawa urządzeń Apple',
            exact: true,
          })
          .click();
        await page.getByRole('table', { name: 'Pozycje paczki' }).waitFor();
        await page.getByRole('button', { name: 'Szczegóły DEMO000001', exact: true }).waitFor();
        await check('batch-detail');
        await page
          .getByRole('navigation')
          .getByRole('button', { name: 'Stan systemu', exact: true })
          .click();
        await page.getByRole('button', { name: 'Zapisz limit równoległości' }).waitFor();
        await check('system');
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.close();
  await db.close();
}
