import type { SolverId } from '../../shared/system.js';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { integrationsConfigured } from '../config.js';
import { AppError, browserErrorCode } from '../errors.js';
import type { CoverageResult, Stage } from '../../shared/types.js';
import { createSolver } from './solvers.js';
import { solverLabels } from '../../shared/system.js';
import { appleError, parseCoverage } from './parser.js';
import { materializeProxy, proxyCatalog, type InternalProxy } from '../proxies.js';
import type { SessionMeasurement, ProxyStage } from '../../shared/system.js';

export interface Execution {
  priorRateLimits?: number;
  beginSession: () => Promise<string>;
  endSession: (id: string, m: SessionMeasurement) => Promise<void>;
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
    private launch: typeof chromium.launch = (options) => chromium.launch(options),
    private makeSolver: (
      ...args: Parameters<typeof createSolver>
    ) => Pick<ReturnType<typeof createSolver>, 'solve' | 'reportIncorrect'> = createSolver,
  ) {}

  async check(
    serial: string,
    signal: AbortSignal,
    stage: (value: Stage) => Promise<void>,
    execution: Execution,
  ): Promise<CoverageResult> {
    const proxy = proxyCatalog(this.config).find((p) => p.label === execution.proxy);
    if (!proxy) throw new AppError('PROXY_REMOVED');
    const priorLimits = execution.priorRateLimits ?? 0;
    if (priorLimits > this.config.RATE_LIMIT_RETRIES) throw new AppError('APPLE_RATE_LIMITED');
    for (let retry = priorLimits; ; retry++) {
      signal.throwIfAborted();
      try {
        return await this.checkSession(serial, signal, stage, execution, proxy);
      } catch (e) {
        if (
          !(e instanceof AppError) ||
          e.code !== 'APPLE_RATE_LIMITED' ||
          retry >= this.config.RATE_LIMIT_RETRIES
        )
          throw e;
        await execution.log(
          'rate_limit_retry',
          `Limit Apple: nowa sesja u tego samego proxy (${retry + 1}/${this.config.RATE_LIMIT_RETRIES}).`,
        );
      }
    }
  }
  private async checkSession(
    serial: string,
    signal: AbortSignal,
    stage: (value: Stage) => Promise<void>,
    execution: Execution,
    proxy: InternalProxy,
  ): Promise<CoverageResult> {
    const c = this.config;
    if (!integrationsConfigured(c)) throw new AppError('NOT_CONFIGURED');
    let browser: Browser | undefined;
    let page: Page | undefined;
    let step = 'browser_launch';
    let phase: ProxyStage = 'opening',
      outcome = 'failed',
      appleStarted: number | undefined,
      solverTime = 0,
      limited = false;
    const visited = new Set<ProxyStage>(['opening']);
    const session = await execution.beginSession();
    const log = async (name: string, message: string) => {
      step = name;
      if (name === 'captcha_image') phase = 'captcha';
      if (name === 'apple_submit') phase = 'submit';
      if (name === 'apple_result') phase = 'result';
      visited.add(phase);
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
      browser = await this.launch({
        headless: true,
        // ProxyMesh's username:ip_hash:password form keeps HTTPS CONNECTs on the same exit IP.
        // No direct-connect fallback: a proxy failure must fail the check.
        proxy: materializeProxy(proxy),
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
      appleStarted = performance.now();
      const response = await page.goto('https://checkcoverage.apple.com/?locale=en_US', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await log(
        'apple_http',
        `Odpowiedź strony Apple: HTTP ${response?.status() ?? 'brak odpowiedzi'}.`,
      );
      await this.checkLimit(page);
      if (response?.status() === 429) throw new AppError('APPLE_RATE_LIMITED');
      if ([403, 429].includes(response?.status() ?? 0)) throw new AppError('APPLE_BLOCKED');
      if (!response?.ok()) throw new AppError('APPLE_UNAVAILABLE');
      const input = page.locator('#serial-number-input');
      await log('serial_form', 'Oczekiwanie na pole numeru seryjnego #serial-number-input.');
      try {
        await this.waitElement(page, input, signal);
      } catch {
        await this.checkLimit(page);
        throw new AppError(
          appleError(await page.locator('body').innerText()) === 'APPLE_BLOCKED'
            ? 'APPLE_BLOCKED'
            : 'PAGE_CHANGED',
        );
      }
      const solver = this.makeSolver(execution.solver, c, execution.log);
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        await stage('solving');
        await log('captcha_image', `Odczyt obrazu CAPTCHA, próba ${attempt + 1}/2.`);
        const captcha = page.getByRole('img', { name: 'captcha', exact: true });
        await this.waitElement(page, captcha, signal);
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
        } finally {
          solverTime += performance.now() - started;
        }
        const solverMs = performance.now() - started;
        await execution.endCaptcha(measurement, solverMs, 'completed');
        await log(
          'captcha_solved',
          `${solverLabels[execution.solver]} zwróciło rozwiązanie po ${(solverMs / 1000).toFixed(1)} s.`,
        );
        signal.throwIfAborted();
        await this.checkLimit(page);
        const captchaInput = page.locator('#captcha-input');
        await captchaInput.fill('');
        await captchaInput.pressSequentially(solution.text, { delay: 40 });
        await captchaInput.press('Tab');
        const captchaMatches = (await captchaInput.inputValue()) === solution.text;
        await log(
          'captcha_filled',
          `Wpisano rozwiązanie CAPTCHA; pole zgodne: ${captchaMatches ? 'tak' : 'nie'}; liczba znaków rozwiązania: ${solution.text.length}.`,
        );
        if (!captchaMatches) throw new AppError('PAGE_CHANGED');
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
        phase = 'submit';
        visited.add(phase);
        const submit = page.getByRole('button', { name: 'Submit', exact: true });
        try {
          await page.waitForFunction(
            () => {
              const button = Array.from(document.querySelectorAll('button')).find(
                (element) => element.textContent?.trim() === 'Submit',
              );
              return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
            },
            undefined,
            { timeout: 5000 },
          );
        } catch {
          await this.checkLimit(page);
          await log(
            'apple_submit_disabled',
            'Przycisk Submit pozostał nieaktywny po wpisaniu obu pól. Formularz Apple nie zaakceptował danych wejściowych.',
          );
          const error = appleError(await page.locator('body').innerText());
          throw new AppError(error && error !== 'CAPTCHA_REJECTED' ? error : 'PAGE_CHANGED');
        }
        await log('apple_submit', 'Wysyłanie formularza Apple.');
        await submit.click();
        await log('apple_result', 'Oczekiwanie na dane gwarancji lub komunikat Apple.');
        const result = await this.awaitResult(page, serial, signal);
        if (result !== 'CAPTCHA_REJECTED') {
          await log('result_parsed', 'Odczytano wynik gwarancji.');
          outcome = 'completed';
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
      if (page && !page.isClosed() && !signal.aborted) {
        try {
          await this.checkLimit(page);
        } catch (limit) {
          if (limit instanceof AppError && limit.code === 'APPLE_RATE_LIMITED') e = limit;
        }
      }
      limited = e instanceof AppError && e.code === 'APPLE_RATE_LIMITED';
      outcome = limited ? 'rate_limited' : browserErrorCode(e, signal.aborted);
      if (limited)
        await execution.log(
          'apple_rate_limit',
          `Limit Apple; proxy: ${execution.proxy}; etap: ${phase}; IP wyjściowe: nieznane.`,
        );
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
      const appleMs =
        appleStarted === undefined ? 0 : Math.max(0, performance.now() - appleStarted - solverTime);
      signal.removeEventListener('abort', close);
      await browser?.close().catch(() => {});
      await execution.endSession(session, {
        appleMs,
        limited,
        stage: phase,
        stages: [...visited],
        outcome,
      });
    }
  }
  private async checkLimit(page: Page) {
    if (
      appleError(await page.locator('body').innerText({ timeout: 2000 })) === 'APPLE_RATE_LIMITED'
    )
      throw new AppError('APPLE_RATE_LIMITED');
  }
  private async waitElement(page: Page, locator: Locator, signal: AbortSignal) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      await this.checkLimit(page);
      if (await locator.isVisible()) return;
      await delay(300, undefined, { signal });
    }
    throw new AppError('PAGE_CHANGED');
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
