import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../errors.js';

export class CaptchaAiClient {
  constructor(
    private apiKey: string,
    private timeoutMs: number,
    private fetcher: typeof fetch = fetch,
    private pollMs = 5000,
    private log?: (step: string, message: string) => Promise<void>,
  ) {}
  private async call(
    endpoint: 'in.php' | 'res.php',
    body: FormData,
    signal: AbortSignal,
  ): Promise<{ status: unknown; request: unknown }> {
    body.set('key', this.apiKey);
    body.set('json', '1');
    try {
      const response = await this.fetcher(`https://ocr.captchaai.com/${endpoint}`, {
        method: 'POST',
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (!response.ok) throw new AppError('CAPTCHA_SERVICE');
      const data = (await response.json()) as { status: unknown; request: unknown };
      if (data.status !== 1 && data.request !== 'CAPCHA_NOT_READY') {
        const code =
          typeof data.request === 'string' &&
          /^(?:ERROR_[A-Z_]{1,60}|IP_BANNED)$/.test(data.request)
            ? data.request
            : 'UNKNOWN';
        await this.log?.('captcha_service_error', `CaptchaAI / ${endpoint}: ${code}.`);
        throw new AppError('CAPTCHA_SERVICE');
      }
      return data;
    } catch (e) {
      if (signal.aborted) throw new AppError('CAPTCHA_TIMEOUT');
      if (e instanceof AppError) throw e;
      throw new AppError('CAPTCHA_SERVICE');
    }
  }
  async solve(image: string, parent: AbortSignal): Promise<{ taskId: string; text: string }> {
    const match = /^data:image\/(jpeg|jpg|png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) throw new AppError('PAGE_CHANGED');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 100 || bytes.length > 100000) throw new AppError('PAGE_CHANGED');
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.timeoutMs)]);
    const form = new FormData();
    form.set('method', 'post');
    form.set('regsense', '1');
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: `image/${match[1]}` }),
      `captcha.${match[1]}`,
    );
    const task = await this.call('in.php', form, signal);
    if (
      task.status !== 1 ||
      typeof task.request !== 'string' ||
      !/^[0-9]{1,40}$/.test(task.request)
    )
      throw new AppError('CAPTCHA_SERVICE');
    try {
      while (!signal.aborted) {
        await delay(this.pollMs, undefined, { signal });
        const poll = new FormData();
        poll.set('action', 'get');
        poll.set('id', task.request);
        const result = await this.call('res.php', poll, signal);
        if (result.status === 0 && result.request === 'CAPCHA_NOT_READY') continue;
        if (
          result.status !== 1 ||
          typeof result.request !== 'string' ||
          !result.request.trim() ||
          result.request.length > 64
        )
          throw new AppError('CAPTCHA_SERVICE');
        return { taskId: task.request, text: result.request.trim() };
      }
    } catch (e) {
      if (signal.aborted) throw new AppError('CAPTCHA_TIMEOUT');
      throw e;
    }
    throw new AppError('CAPTCHA_TIMEOUT');
  }
  async reportIncorrect(taskId: string | number) {
    try {
      const form = new FormData();
      form.set('action', 'reportbad');
      form.set('id', String(taskId));
      await this.call('res.php', form, AbortSignal.timeout(5000));
    } catch {
      /* Reporting never triggers another solve. */
    }
  }
}
