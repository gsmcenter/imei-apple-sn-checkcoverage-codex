import { setTimeout as delay } from 'node:timers/promises';
import { AppError, type ErrorCode } from '../errors.js';

const busyCodes = new Set(['ERROR_ZERO_BALANCE', 'ERROR_NO_SLOT_AVAILABLE']);
type ResponseData = {
  status?: unknown;
  request?: unknown;
  threads?: unknown;
  working_threads?: unknown;
};
export class CaptchaAiClient {
  constructor(
    private apiKey: string,
    private timeoutMs: number,
    private fetcher: typeof fetch = fetch,
    private pollMs = 5000,
    private log?: (step: string, message: string) => Promise<void>,
    private busyPollMs = 1500,
    private busyTimeoutMs = 60000,
  ) {}
  private async call(
    endpoint: 'in.php' | 'res.php',
    body: FormData | URLSearchParams,
    signal: AbortSignal,
    method: 'POST' | 'GET' = 'POST',
  ): Promise<ResponseData> {
    body.set('key', this.apiKey);
    body.set('json', '1');
    try {
      signal.throwIfAborted();
      const url = `https://ocr.captchaai.com/${endpoint}`;
      const response = await this.fetcher(method === 'GET' ? `${url}?${body.toString()}` : url, {
        method,
        ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (!response.ok) {
        await this.log?.(
          'captcha_service_error',
          `CaptchaAI / ${endpoint}: HTTP ${response.status}.`,
        );
        throw new AppError('CAPTCHAAI_NETWORK');
      }
      const text = (await response.text()).trim();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text.startsWith('OK|')
          ? { status: 1, request: text.slice(3) }
          : { status: 0, request: text };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new AppError('CAPTCHAAI_RESPONSE');
      return data as ResponseData;
    } catch (e) {
      if (signal.aborted) throw new AppError('CAPTCHA_TIMEOUT');
      if (e instanceof AppError) throw e;
      // Never include fetch errors: GET URLs contain the API key.
      await this.log?.(
        'captcha_service_error',
        `CaptchaAI / ${endpoint}: błąd transportu (sieć, TLS lub limit czasu połączenia).`,
      );
      throw new AppError('CAPTCHAAI_NETWORK');
    }
  }
  private async fail(value: unknown): Promise<never> {
    const code =
      typeof value === 'string' && /^(?:ERROR_[A-Z_]{1,60}|IP_BANNED)$/.test(value)
        ? value
        : 'UNKNOWN';
    await this.log?.('captcha_service_error', `CaptchaAI: ${code}.`);
    const mapped: ErrorCode = busyCodes.has(code)
      ? 'CAPTCHAAI_BUSY'
      : ['ERROR_WRONG_USER_KEY', 'ERROR_KEY_DOES_NOT_EXIST'].includes(code)
        ? 'CAPTCHAAI_KEY'
        : ['ERROR_IP_NOT_ALLOWED', 'IP_BANNED'].includes(code)
          ? 'CAPTCHAAI_IP'
          : code === 'ERROR_CAPTCHA_UNSOLVABLE'
            ? 'CAPTCHA_FAILED'
            : 'CAPTCHAAI_RESPONSE';
    throw new AppError(mapped);
  }
  async getAccount(): Promise<{ total: number; busy: number }> {
    const info = await this.call(
      'res.php',
      new URLSearchParams({ action: 'threadsinfo' }),
      AbortSignal.timeout(15000),
    );
    // Successful threadsinfo has counters, but no status field.
    const counter = (v: unknown) =>
      (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) &&
      Number.isSafeInteger(Number(v)) &&
      Number(v) >= 0;
    if (!counter(info.threads) || !counter(info.working_threads)) return this.fail(info.request);
    if (info.status === 0 || info.status === '0') return this.fail(info.request);
    return { total: Number(info.threads), busy: Number(info.working_threads) };
  }
  async solve(image: string, parent: AbortSignal): Promise<{ taskId: string; text: string }> {
    const match = /^data:image\/(jpeg|jpg|png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) throw new AppError('PAGE_CHANGED');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 100 || bytes.length > 100000) throw new AppError('PAGE_CHANGED');
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.timeoutMs)]);
    const busyDeadline = Date.now() + this.busyTimeoutMs;
    let waitingForSlot = false;
    try {
      let taskId: string | undefined;
      for (let attempt = 1; !taskId; attempt++) {
        const form = new FormData();
        form.set('method', 'post');
        form.set('regsense', '1');
        form.set(
          'file',
          new Blob([new Uint8Array(bytes)], { type: `image/${match[1]}` }),
          `captcha.${match[1]}`,
        );
        const task = await this.call('in.php', form, signal);
        if (task.status === 1 || task.status === '1') {
          // Real CaptchaAI returns a JSON number. Keep string IDs intact (including leading zeros).
          if (
            typeof task.request === 'number' &&
            (!Number.isSafeInteger(task.request) || task.request <= 0)
          )
            throw new AppError('CAPTCHAAI_RESPONSE');
          if (
            !['string', 'number'].includes(typeof task.request) ||
            !/^[0-9]{1,40}$/.test(String(task.request))
          )
            throw new AppError('CAPTCHAAI_RESPONSE');
          taskId = String(task.request);
          waitingForSlot = false;
        } else if (
          (task.status === 0 || task.status === '0') &&
          typeof task.request === 'string' &&
          busyCodes.has(task.request)
        ) {
          // Retry only an explicit rejection, never an ambiguous network/submission failure.
          waitingForSlot = true;
          if (Date.now() >= busyDeadline) return this.fail(task.request);
          await this.log?.(
            'captcha_waiting_slot',
            `CaptchaAI: ${task.request}. Oczekiwanie na wątek abonamentu; to nie jest saldo USD.`,
          );
          await delay(
            Math.min(this.busyPollMs * attempt, 8000, Math.max(1, busyDeadline - Date.now())),
            undefined,
            { signal },
          );
          if (Date.now() >= busyDeadline) return this.fail(task.request);
        } else return this.fail(task.request);
      }
      while (!signal.aborted) {
        await delay(this.pollMs, undefined, { signal });
        const result = await this.call(
          'res.php',
          new URLSearchParams({ action: 'get', id: taskId }),
          signal,
          'GET',
        );
        if ((result.status === 0 || result.status === '0') && result.request === 'CAPCHA_NOT_READY')
          continue;
        if (result.status !== 1 && result.status !== '1') return this.fail(result.request);
        if (
          typeof result.request !== 'string' ||
          !result.request.trim() ||
          result.request.length > 64
        )
          throw new AppError('CAPTCHAAI_RESPONSE');
        return { taskId, text: result.request.trim() };
      }
    } catch (e) {
      if (signal.aborted)
        throw new AppError(
          waitingForSlot && !parent.aborted ? 'CAPTCHAAI_BUSY' : 'CAPTCHA_TIMEOUT',
        );
      throw e;
    }
    throw new AppError('CAPTCHA_TIMEOUT');
  }
  async reportIncorrect(taskId: string | number) {
    try {
      await this.call(
        'res.php',
        new URLSearchParams({ action: 'reportbad', id: String(taskId) }),
        AbortSignal.timeout(5000),
        'GET',
      );
    } catch {
      /* Reporting never triggers another solve. */
    }
  }
}
