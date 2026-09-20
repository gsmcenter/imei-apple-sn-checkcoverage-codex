import type { SolverBalance } from '../shared/system.js';
import type { CaptchaAiAccount } from '../shared/system.js';
import { AppError } from './errors.js';

// One external request per minute per web process, including failures; collapse concurrent reads.
export function cachedBalance(read: (() => Promise<number>) | undefined, demo = false) {
  let cached: SolverBalance | undefined;
  let pending: Promise<SolverBalance> | undefined;
  return async (): Promise<SolverBalance> => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < 60000) return cached;
    if (pending) return pending;
    pending = (async () => {
      let balance: number | null = null;
      let status: SolverBalance['status'] = demo ? 'demo' : read ? 'unavailable' : 'not_configured';
      if (read && !demo) {
        try {
          balance = await read();
          status = 'ok';
        } catch {
          /* No provider secrets or raw errors. */
        }
      }
      cached = { balance, status, currency: 'USD', checkedAt: new Date().toISOString() };
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export function cachedCaptchaAiAccount(
  read: (() => Promise<{ total: number; busy: number }>) | undefined,
  demo = false,
) {
  let cached: CaptchaAiAccount | undefined;
  let pending: Promise<CaptchaAiAccount> | undefined;
  return async (): Promise<CaptchaAiAccount> => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < 60000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const result: CaptchaAiAccount = {
        kind: 'threads',
        total: null,
        busy: null,
        available: null,
        status: demo ? 'demo' : read ? 'unavailable' : 'not_configured',
        message: null,
        checkedAt: new Date().toISOString(),
      };
      if (read && !demo) {
        try {
          const value = await read();
          if (
            !Number.isSafeInteger(value.total) ||
            value.total < 0 ||
            !Number.isSafeInteger(value.busy) ||
            value.busy < 0
          )
            throw new AppError('CAPTCHAAI_RESPONSE');
          Object.assign(
            result,
            { total: value.total, busy: value.busy },
            {
              available: Math.max(0, value.total - value.busy),
              status: 'ok',
            },
          );
        } catch (e) {
          result.message =
            e instanceof AppError
              ? e.message
              : 'Nie udało się odczytać stanu abonamentu CaptchaAI.';
        }
      }
      cached = result;
      return result;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
