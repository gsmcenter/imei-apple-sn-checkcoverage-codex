export const proxyHosts = [
  'fr.proxymesh.com:31280',
  'de.proxymesh.com:31280',
  'open.proxymesh.com:31280',
] as const;
export const proxyModes = [...proxyHosts, 'random'] as const;
export type ProxyMode = string;
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
  appleMs?: number;
  sessions?: number;
  rateLimits?: number;
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
  proxyOptions: { label: string; provider: string }[];
  proxyPerformance: ProxyPerformance[];
  limits: LimitMetric[];
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
export interface ProxyPerformance {
  name: string;
  total: number;
  completed: number;
  failed: number;
  averageMs: number | null;
  medianMs: number | null;
  sessions: number;
  limits: number;
  proxyErrors: number;
}
export interface LimitMetric {
  dimension: 'proxy' | 'concurrency' | 'stage' | 'hour';
  name: string;
  sessions: number;
  limited: number;
}
export interface ProxyProbeResult {
  ok: boolean;
  status?: number;
  ms: number;
  exitIp?: string;
  reason?: string;
}
export interface ProxyTest {
  label: string;
  configured: ProxyProbeResult;
  bare: ProxyProbeResult;
  diagnosis: string;
  info: {
    username: string;
    passwordLength: number;
    basePasswordLength: number;
    params: string[];
    warnings: string[];
  };
}
export type ProxyStage = 'opening' | 'captcha' | 'submit' | 'result';
export interface SessionMeasurement {
  appleMs: number;
  limited: boolean;
  stage: ProxyStage;
  stages: ProxyStage[];
  outcome: string;
}
export interface SolverBalance {
  balance: number | null;
  currency: 'USD';
  status: 'ok' | 'unavailable' | 'not_configured' | 'demo';
  checkedAt: string;
}
export const duration = (ms: number | null | undefined) =>
  ms == null ? '—' : `${(ms / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} s`;
