import type { SolverBalance } from '../shared/system.js';

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
