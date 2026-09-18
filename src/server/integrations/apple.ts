import { chromium, type Browser, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { integrationsConfigured } from '../config.js';
import { AppError } from '../errors.js';
import type { CoverageResult, Stage } from '../../shared/types.js';
import { CaptchaClient } from './captcha.js';
import { appleError, parseCoverage } from './parser.js';

export interface CoverageProvider {
  check(
    serial: string,
    signal: AbortSignal,
    stage: (value: Stage) => Promise<void>,
  ): Promise<CoverageResult>;
}

export class AppleProvider implements CoverageProvider {
  constructor(
    private config: Config,
    private reserveCaptcha: () => Promise<void>,
  ) {}

  async check(
    serial: string,
    signal: AbortSignal,
    stage: (value: Stage) => Promise<void>,
  ): Promise<CoverageResult> {
    const c = this.config;
    if (!integrationsConfigured(c)) throw new AppError('NOT_CONFIGURED');
    let browser: Browser | undefined;
    const close = () => {
      void browser?.close().catch(() => {});
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      browser = await chromium.launch({
        headless: true,
        // ProxyMesh's username:ip_hash:password form keeps HTTPS CONNECTs on the same exit IP.
        // No direct-connect fallback: a proxy failure must fail the check.
        proxy: {
          server: c.PROXY_SERVER!,
          username: `${c.PROXY_USERNAME}:${randomUUID().replaceAll('-', '')}`,
          password: c.PROXY_PASSWORD!,
        },
        args: [
          '--disable-dev-shm-usage',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
        timeout: 30000,
      });
      signal.throwIfAborted();
      const context = await browser.newContext({
        locale: 'en-US',
        timezoneId: 'America/New_York',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const response = await page.goto('https://checkcoverage.apple.com/?locale=en_US', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      if ([403, 429].includes(response?.status() ?? 0)) throw new AppError('APPLE_BLOCKED');
      if (!response?.ok()) throw new AppError('APPLE_UNAVAILABLE');
      const input = page.locator('#serial-number-input');
      try {
        await input.waitFor({ state: 'visible' });
      } catch {
        throw new AppError(
          appleError(await page.locator('body').innerText()) === 'APPLE_BLOCKED'
            ? 'APPLE_BLOCKED'
            : 'PAGE_CHANGED',
        );
      }
      await input.fill(serial);
      const solver = new CaptchaClient(c.TWOCAPTCHA_API_KEY!, c.CAPTCHA_TIMEOUT_MS);
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        await stage('solving');
        const captcha = page.getByRole('img', { name: 'captcha', exact: true });
        await captcha.waitFor({ state: 'visible' });
        const image = await captcha.getAttribute('src');
        if (!image?.startsWith('data:image/')) throw new AppError('PAGE_CHANGED');
        await this.reserveCaptcha();
        const solution = await solver.solve(image, signal);
        signal.throwIfAborted();
        await page.locator('#captcha-input').fill(solution.text);
        await stage('reading');
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
        const result = await this.awaitResult(page, serial, signal);
        if (result !== 'CAPTCHA_REJECTED') return result;
        await solver.reportIncorrect(solution.taskId);
        if (attempt === 1) throw new AppError('CAPTCHA_FAILED');
        await page.locator('#captcha-refresh-btn').click();
        await page.waitForFunction(
          (oldImage) => {
            const img = document.querySelector<HTMLImageElement>('img[alt="captcha"]');
            return img?.src.startsWith('data:image/') && img.src !== oldImage;
          },
          image,
          { timeout: 15000 },
        );
        await page.locator('#captcha-input').fill('');
      }
      throw new AppError('CAPTCHA_FAILED');
    } catch (e) {
      if (signal.aborted) throw new AppError('CHECK_TIMEOUT');
      if (e instanceof AppError) throw e;
      const message = e instanceof Error ? e.message : '';
      if (/PROXY|TUNNEL|407|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(message))
        throw new AppError('PROXY_ERROR');
      if (/Timeout/i.test(message)) throw new AppError('CHECK_TIMEOUT');
      throw new AppError('PAGE_CHANGED');
    } finally {
      signal.removeEventListener('abort', close);
      await browser?.close().catch(() => {});
    }
  }

  private async awaitResult(
    page: Page,
    serial: string,
    signal: AbortSignal,
  ): Promise<CoverageResult | 'CAPTCHA_REJECTED'> {
    const deadline = Date.now() + 45000;
    // Give React time to replace validation messages from the preceding submit.
    await delay(1200, undefined, { signal });
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (new URL(page.url()).hostname !== 'checkcoverage.apple.com')
        throw new AppError('PAGE_CHANGED');
      const text = await page.locator('body').innerText();
      const error = appleError(text);
      if (error === 'CAPTCHA_REJECTED') return error;
      if (error) throw new AppError(error);
      if (!(await page.locator('#serial-number-input').isVisible())) {
        const headings = await page.locator('h1,h2,h3').allInnerTexts();
        try {
          return parseCoverage(text, headings, serial);
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== 'PAGE_CHANGED') throw e;
        }
      }
      await delay(750, undefined, { signal });
    }
    throw new AppError('PAGE_CHANGED');
  }
}
