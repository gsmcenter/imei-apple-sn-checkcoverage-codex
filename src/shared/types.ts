export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type CoverageStatus = 'active' | 'expired' | 'unknown';
export type Stage = 'queued' | 'opening' | 'solving' | 'reading' | 'done';

export interface CoverageResult {
  serial: string;
  model: string | null;
  coverageStatus: CoverageStatus;
  coverageLabel: string | null;
  expirationDate: string | null;
  renewalDate: string | null;
  purchaseDate: string | null;
  details: string[];
  rawText: string;
  checkedAt: string;
  source: 'apple' | 'demo';
  sourceUrl: string;
}

export interface Check {
  id: string;
  serial: string;
  status: JobStatus;
  stage: Stage;
  attempts: number;
  result: CoverageResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  runs?: import('./system.js').Run[];
  diagnostics?: import('./system.js').Diagnostic[];
}

export interface Overview {
  total: number;
  today: number;
  completed: number;
  failed: number;
  pending: number;
  dailyLimit: number;
  captchaToday: number;
  captchaDailyLimit: number;
  integrations: { captcha: boolean; proxy: boolean; worker: boolean };
  demo: boolean;
}

export const stageLabels: Record<Stage, string> = {
  queued: 'W kolejce',
  opening: 'Otwieranie strony Apple',
  solving: 'Rozwiązywanie CAPTCHA',
  reading: 'Odczytywanie gwarancji',
  done: 'Zakończono',
};
