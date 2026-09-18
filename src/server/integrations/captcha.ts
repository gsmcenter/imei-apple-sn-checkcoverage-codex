import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../errors.js';

export interface CaptchaSolution {
  taskId: number;
  text: string;
}
export class CaptchaClient {
  constructor(
    private apiKey: string,
    private timeoutMs: number,
    private fetcher: typeof fetch = fetch,
    private pollMs = 5000,
  ) {}

  private async call(method: string, payload: object, signal: AbortSignal) {
    try {
      const r = await this.fetcher(`https://api.2captcha.com/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, ...payload }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!r.ok) throw new AppError('CAPTCHA_SERVICE');
      const data = (await r.json()) as Record<string, unknown>;
      if (data.errorId !== 0) throw new AppError('CAPTCHA_SERVICE');
      return data;
    } catch (e) {
      if (signal.aborted) throw new AppError('CAPTCHA_TIMEOUT');
      if (e instanceof AppError) throw e;
      throw new AppError('CAPTCHA_SERVICE');
    }
  }
  async solve(image: string, parent: AbortSignal): Promise<CaptchaSolution> {
    if (
      !/^data:image\/(jpeg|png|gif);base64,[A-Za-z0-9+/=]+$/.test(image) ||
      Buffer.from(image.split(',')[1], 'base64').length > 100000
    )
      throw new AppError('PAGE_CHANGED');
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.timeoutMs)]);
    const created = await this.call(
      'createTask',
      {
        task: { type: 'ImageToTextTask', body: image, case: true },
        languagePool: 'en',
      },
      signal,
    );
    if (
      typeof created.taskId !== 'number' ||
      !Number.isSafeInteger(created.taskId) ||
      created.taskId <= 0
    )
      throw new AppError('CAPTCHA_SERVICE');
    try {
      while (!signal.aborted) {
        await delay(this.pollMs, undefined, { signal });
        const r = await this.call('getTaskResult', { taskId: created.taskId }, signal);
        if (r.status === 'processing') continue;
        const text = (r.solution as { text?: unknown } | undefined)?.text;
        if (r.status !== 'ready' || typeof text !== 'string' || !text.trim() || text.length > 64)
          throw new AppError('CAPTCHA_SERVICE');
        return { taskId: created.taskId, text: text.trim() };
      }
    } catch (e) {
      if (signal.aborted) throw new AppError('CAPTCHA_TIMEOUT');
      throw e;
    }
    throw new AppError('CAPTCHA_TIMEOUT');
  }
  async reportIncorrect(taskId: number) {
    // Failure to report never starts another paid task or replaces the original result.
    try {
      await this.call('reportIncorrect', { taskId }, AbortSignal.timeout(5000));
    } catch {
      /* best effort */
    }
  }
}
