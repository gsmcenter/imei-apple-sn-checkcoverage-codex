import { CaptchaClient } from './captcha.js';
import { CaptchaAiClient } from './captchaai.js';
import { solverConfigured, type Config } from '../config.js';
import type { SolverId } from '../../shared/system.js';
import { AppError } from '../errors.js';
export interface Solver {
  solve(image: string, signal: AbortSignal): Promise<{ taskId: string | number; text: string }>;
  reportIncorrect(taskId: string | number): Promise<void>;
}
export function createSolver(
  id: SolverId,
  config: Config,
  log?: (step: string, message: string) => Promise<void>,
): Solver {
  if (!solverConfigured(config, id)) throw new AppError('NOT_CONFIGURED');
  switch (id) {
    case 'captchaai':
      return new CaptchaAiClient(
        config.CAPTCHAAI_API_KEY!,
        config.CAPTCHA_TIMEOUT_MS,
        fetch,
        5000,
        log,
      );
    case '2captcha':
      return new CaptchaClient(
        config.TWOCAPTCHA_API_KEY!,
        config.CAPTCHA_TIMEOUT_MS,
        fetch,
        5000,
        log,
      );
  }
}
