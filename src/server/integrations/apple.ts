import type { SolverId } from '../../shared/system.js';
import { chromium, type Browser, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { integrationsConfigured } from '../config.js';
import { AppError, browserErrorCode } from '../errors.js';
import type { CoverageResult, Stage } from '../../shared/types.js';
import { createSolver } from './solvers.js';
import { solverLabels } from '../../shared/system.js';
import { appleError, parseCoverage } from './parser.js';

export interface Execution {
  proxy: string;
  solver: SolverId;
  log: (step: string, message: string) => Promise<void>;
  beginCaptcha: () => Promise<string>;
  endCaptcha: (
    id: string,
    ms: number,
    outcome: 'completed' | 'failed' | 'rejected',
  ) => Promise<void>;
}
export interface CoverageProvider {
  check(
    serial: string,
    signal: AbortSignal,
    stage: (value: Stage) => Promise<void>,
    execution: Execution,
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
    execution: Execution,
  ): Promise<CoverageResult> {
    const c = this.config;
    if (!integrationsConfigured(c)) throw new AppError('NOT_CONFIGURED');
    let browser: Browser | undefined;
    let page: Page | undefined;
    let step = 'browser_launch';
    const log = async (name: string, message: string) => {
      step = name;
      await execution.log(name, message);
    };
    const close = () => {
      void browser?.close().catch(() => {});
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      await log(
        'browser_launch',
        `Uruchamianie Chromium; proxy: ${execution.proxy}; solver: ${execution.solver}.`,
      );
      browser = await chromium.launch({
        headless: true,
        // ProxyMesh's username:ip_hash:password form keeps HTTPS CONNECTs on the same exit IP.
        // No direct-connect fallback: a proxy failure must fail the check.
        proxy: {
          server: `http://${execution.proxy}`,
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
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      await log('apple_navigation', 'Otwieranie formularza Apple.');
      const response = await page.goto('https://checkcoverage.apple.com/?locale=en_US', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await log(
        'apple_http',
        `Odpowiedź strony Apple: HTTP ${response?.status() ?? 'brak odpowiedzi'}.`,
      );
      if ([403, 429].includes(response?.status() ?? 0)) throw new AppError('APPLE_BLOCKED');
      if (!response?.ok()) throw new AppError('APPLE_UNAVAILABLE');
      const input = page.locator('#serial-number-input');
      await log('serial_form', 'Oczekiwanie na pole numeru seryjnego #serial-number-input.');
      try {
        await input.waitFor({ state: 'visible' });
      } catch {
        throw new AppError(
          appleError(await page.locator('body').innerText()) === 'APPLE_BLOCKED'
            ? 'APPLE_BLOCKED'
            : 'PAGE_CHANGED',
        );
      }
      const solver = createSolver(execution.solver, c, execution.log);
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        await stage('solving');
        await log('captcha_image', `Odczyt obrazu CAPTCHA, próba ${attempt + 1}/2.`);
        const captcha = page.getByRole('img', { name: 'captcha', exact: true });
        await captcha.waitFor({ state: 'visible' });
        const image = await captcha.getAttribute('src');
        if (!image?.startsWith('data:image/')) {
          await log(
            'captcha_image_invalid',
            `Obraz CAPTCHA nie jest osadzony jako data:image. Typ źródła: ${image ? 'zewnętrzny adres lub inny format' : 'brak src'}.`,
          );
          throw new AppError('PAGE_CHANGED');
        }
        // Apple finishes initializing the form while the CAPTCHA is loading.
        // Fill only once the complete form exists and dispatch the keyboard events used by validation.
        await input.fill('');
        await input.pressSequentially(serial, { delay: 40 });
        await input.press('Tab');
        await log(
          'serial_filled',
          `Wpisano numer seryjny po załadowaniu CAPTCHA; pole zgodne: ${(await input.inputValue()) === serial ? 'tak' : 'nie'}.`,
        );
        const formError = appleError(await page.locator('body').innerText());
        if (formError && formError !== 'CAPTCHA_REJECTED') throw new AppError(formError);
        await this.reserveCaptcha();
        const measurement = await execution.beginCaptcha();
        let solution;
        await log(
          'captcha_solver',
          `Wysłanie zadania do ${solverLabels[execution.solver]} i oczekiwanie na rozwiązanie.`,
        );
        const started = performance.now();
        try {
          solution = await solver.solve(image, signal);
        } catch (e) {
          await execution.endCaptcha(measurement, performance.now() - started, 'failed');
          throw e;
        }
        const solverMs = performance.now() - started;
        await execution.endCaptcha(measurement, solverMs, 'completed');
        await log(
          'captcha_solved',
          `${solverLabels[execution.solver]} zwróciło rozwiązanie po ${(solverMs / 1000).toFixed(1)} s.`,
        );
        signal.throwIfAborted();
        await page.locator('#captcha-input').fill(solution.text);
        if ((await input.inputValue()) !== serial) {
          await log(
            'serial_changed',
            'Strona zmieniła wartość pola SN przed wysłaniem formularza.',
          );
          throw new AppError('PAGE_CHANGED');
        }
        const validationError = appleError(await page.locator('body').innerText());
        if (validationError && validationError !== 'CAPTCHA_REJECTED')
          throw new AppError(validationError);
        await stage('reading');
        await log('apple_submit', 'Wysyłanie formularza Apple.');
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
        await log('apple_result', 'Oczekiwanie na dane gwarancji lub komunikat Apple.');
        const result = await this.awaitResult(page, serial, signal);
        if (result !== 'CAPTCHA_REJECTED') {
          await log('result_parsed', 'Odczytano wynik gwarancji.');
          return result;
        }
        await execution.endCaptcha(measurement, solverMs, 'rejected');
        await log('captcha_rejected', 'Apple odrzuciło kod CAPTCHA.');
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
      const networkCode = (e instanceof Error ? e.message : '').match(/(?:net::)?ERR_[A-Z_]+/)?.[0];
      await execution.log(
        'failure',
        `Błąd na etapie: ${step}. ${e instanceof AppError ? `${e.code}: ${e.message}` : (networkCode ?? (e instanceof Error && e.name === 'TimeoutError' ? 'Przekroczono czas oczekiwania na element lub stronę.' : 'Nieoczekiwana odpowiedź strony lub przeglądarki.'))}`,
      );
      if (page && !page.isClosed() && !signal.aborted) {
        try {
          // Visible page text only. Never record input values, cookies, headers or CAPTCHA images.
          const snapshot = await page.locator('body').innerText({ timeout: 2000 });
          await execution.log(
            'apple_page',
            `Tekst strony w chwili błędu: ${snapshot.slice(0, 1600)}`,
          );
        } catch {
          /* Browser may have closed following a timeout. */
        }
      }
      throw new AppError(browserErrorCode(e, signal.aborted));
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
