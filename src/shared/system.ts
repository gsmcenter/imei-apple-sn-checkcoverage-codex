export const proxyHosts = [
  'fr.proxymesh.com:31280',
  'de.proxymesh.com:31280',
  'open.proxymesh.com:31280',
] as const;
export const proxyModes = [...proxyHosts, 'random'] as const;
export type ProxyMode = (typeof proxyModes)[number];
export const solverIds = ['2captcha', 'captchaai'] as const;
export type SolverId = (typeof solverIds)[number];
export const solverLabels: Record<SolverId, string> = {
  '2captcha': '2Captcha',
  captchaai: 'CaptchaAI',
};
export interface SystemSettings {
  proxyMode: ProxyMode;
  solverId: SolverId;
}
export interface Run {
  token: string;
  attempt: number;
  proxy: string;
  solver: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  durationMs: number | null;
  queueMs: number;
  captchaMs: number;
  captchaCalls: number;
}
export interface Diagnostic {
  at: string;
  attempt: number;
  step: string;
  message: string;
}
export interface Metric {
  name: string;
  total: number;
  completed: number;
  failed: number;
  interrupted: number;
  averageMs: number | null;
  averageCaptchaMs: number | null;
  averageCheckMs?: number | null;
  checkSamples?: number;
}
export interface SystemStatus {
  settings: SystemSettings;
  proxies: Metric[];
  solvers: Metric[];
  averageMs: number | null;
  averageQueueMs: number | null;
  samples: number;
  activeWorkers: number;
  queued: number;
  running: number;
  concurrency: number;
  intervalMs: number;
  timeoutMs: number;
  uptimeSeconds: number;
  memoryMb: number;
  nodeVersion: string;
  role: string;
  demo: boolean;
  solverConfigured: Record<SolverId, boolean>;
}
export interface SolverBalance {
  balance: number | null;
  currency: 'USD';
  status: 'ok' | 'unavailable' | 'not_configured' | 'demo';
  checkedAt: string;
}
export const duration = (ms: number | null | undefined) =>
  ms == null ? '—' : `${(ms / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} s`;
