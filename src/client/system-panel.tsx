import { useEffect, useState } from 'react';
import { Activity, Clock3, Wallet, RefreshCw } from 'lucide-react';
import { api, post } from './api';
import {
  duration,
  proxyModes,
  solverIds,
  solverLabels,
  proxyHosts,
  type SystemStatus,
  type SystemSettings,
  type SolverBalance,
  type Metric,
} from '../shared/system';

export function SystemPanel() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [balance, setBalance] = useState<SolverBalance | null>(null);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const value = await api<SystemStatus>('/api/v1/system');
        if (alive) {
          setData(value);
          setSettings((s) => s ?? value.settings);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void refresh();
    void api<SolverBalance>('/api/v1/system/balance')
      .then((value) => {
        if (alive) setBalance(value);
      })
      .catch(() => {
        if (alive)
          setBalance({
            balance: null,
            status: 'unavailable',
            currency: 'USD',
            checkedAt: new Date().toISOString(),
          });
      });
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [revision]);
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await post('/api/v1/system/settings', settings);
      setMessage('Zapisano. Kolejne uruchamiane próby użyją tych ustawień.');
      setRevision((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="system-panel">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="system-toolbar">
        <span>Statystyki od włączenia pomiarów · odświeżanie co 10 s</span>
        <button className="secondary" onClick={() => setRevision((r) => r + 1)}>
          <RefreshCw size={16} />
          Odśwież
        </button>
      </div>
      <div className="stats-grid">
        <article className="stat-card">
          <div className="stat-title">
            <Wallet size={18} />
            Saldo 2Captcha
          </div>
          <div className="stat-value">
            {balance?.balance != null
              ? `${balance.balance.toLocaleString('pl-PL', { maximumFractionDigits: 4 })} USD`
              : '—'}
          </div>
          <p>
            {!balance
              ? 'Pobieranie salda…'
              : balance.status === 'ok'
                ? `Odczyt: ${new Date(balance.checkedAt).toLocaleTimeString('pl-PL')}`
                : balance.status === 'demo'
                  ? 'Tryb demo'
                  : balance.status === 'not_configured'
                    ? 'Brak klucza API'
                    : 'Nie udało się pobrać salda'}
          </p>
          <small>Saldo odświeżane najwyżej raz na minutę.</small>
        </article>
        <article className="stat-card">
          <div className="stat-title">
            <Clock3 size={18} />
            Średni czas sprawdzenia
          </div>
          <div className="stat-value">{duration(data?.averageMs)}</div>
          <p>{data?.samples ?? 0} udanych prób · bez kolejki</p>
          <small>Średnio od zlecenia do startu: {duration(data?.averageQueueMs)}</small>
        </article>
        <article className="stat-card">
          <div className="stat-title">
            <Activity size={18} />
            Procesy sprawdzające
          </div>
          <div className="stat-value">{data?.activeWorkers ?? '—'}</div>
          <p>
            W toku: {data?.running ?? '—'} · kolejka: {data?.queued ?? '—'}
          </p>
          <small>
            {data?.activeWorkers
              ? 'Workery wysyłają sygnał dostępności.'
              : 'Brak aktywnego workera.'}
          </small>
        </article>
      </div>
      <section className="system-card">
        <h2>Integracje</h2>
        <p>
          Ustawienia wspólne dla wszystkich workerów. Zmiana nie wpływa na już rozpoczęte próby.
        </p>
        {settings && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="system-settings">
              <label>
                Proxy
                <select
                  value={settings.proxyMode}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      proxyMode: e.target.value as SystemSettings['proxyMode'],
                    });
                    setMessage('');
                  }}
                >
                  {proxyModes.map((p) => (
                    <option key={p} value={p}>
                      {p === 'random' ? 'Random — losowo z 3 serwerów' : p}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Solver CAPTCHA
                <select
                  value={settings.solverId}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      solverId: e.target.value as SystemSettings['solverId'],
                    });
                    setMessage('');
                  }}
                >
                  {solverIds.map((id) => (
                    <option key={id} value={id} disabled={!data?.solverConfigured[id]}>
                      {solverLabels[id]}
                      {data?.solverConfigured[id] ? '' : ' — brak klucza API'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              Random losuje serwer osobno dla każdej próby. Proxy i solver są zapisywane wraz z
              czasami. Aby włączyć CaptchaAI, ustaw CAPTCHAAI_API_KEY w Railway.
            </p>
            <p>
              Aktywne ustawienie:{' '}
              <strong>
                {data?.settings.proxyMode === 'random' ? 'Random' : data?.settings.proxyMode}
              </strong>{' '}
              · {data?.settings.solverId}
            </p>
            <button className="primary" disabled={saving}>
              {saving ? 'Zapisywanie…' : 'Zapisz ustawienia'}
            </button>
            {message && (
              <p role="status" className="system-saved">
                {message}
              </p>
            )}
          </form>
        )}
      </section>
      <section className="system-card">
        <h2>Porównanie proxy</h2>
        <p>
          Średnie dotyczą udanych prób i obejmują oczekiwanie na solver. Błędy oraz przerwane próby
          liczymy osobno. To czas całego sprawdzenia, a nie sam ping proxy.
        </p>
        <Metrics
          rows={proxyHosts.map(
            (name) => data?.proxies.find((p) => p.name === name) ?? emptyMetric(name),
          )}
          proxy
        />
      </section>
      <section className="system-card">
        <h2>Porównanie solverów CAPTCHA</h2>
        <p>
          Pomiar od wysłania zadania do otrzymania odpowiedzi. Liczba dotyczy wywołań solvera, nie
          sprawdzeń. Odrzucone przez Apple kody są liczone jako błędy.
        </p>
        <Metrics rows={data?.solvers.length ? data.solvers : solverIds.map(emptyMetric)} />
        <p>
          „Całe sprawdzenie” to średni czas udanych prób z danym solverem, bez kolejki. Liczba
          udanych sprawdzeń jest podana w nawiasie. Oba solvery odpytywane są co 5 sekund; pomiar
          uwzględnia ten odstęp.
        </p>
      </section>
      {data && (
        <section className="system-card">
          <h2>Parametry systemu</h2>
          <dl className="system-facts">
            <div>
              <dt>Równoległe sprawdzenia (limit)</dt>
              <dd>{data.concurrency}</dd>
            </div>
            <div>
              <dt>Minimalny odstęp startów</dt>
              <dd>{duration(data.intervalMs)}</dd>
            </div>
            <div>
              <dt>Limit czasu sprawdzenia</dt>
              <dd>{duration(data.timeoutMs)}</dd>
            </div>
            <div>
              <dt>Czas pracy procesu WWW</dt>
              <dd>{duration(data.uptimeSeconds * 1000)}</dd>
            </div>
            <div>
              <dt>Pamięć procesu WWW (RSS)</dt>
              <dd>{data.memoryMb} MB</dd>
            </div>
            <div>
              <dt>Node.js / rola</dt>
              <dd>
                {data.nodeVersion} / {data.role}
              </dd>
            </div>
          </dl>
          <p>
            Starsze wpisy bez pomiarów nie wpływają na średnie. Historia pomiarów jest zachowywana w
            bazie.
          </p>
        </section>
      )}
    </div>
  );
}
const emptyMetric = (name: string): Metric => ({
  name,
  total: 0,
  completed: 0,
  failed: 0,
  interrupted: 0,
  averageMs: null,
  averageCaptchaMs: null,
});
function Metrics({ rows, proxy = false }: { rows: Metric[]; proxy?: boolean }) {
  return (
    <div className="system-table-wrap">
      <table className="system-table">
        <thead>
          <tr>
            <th>{proxy ? 'Proxy' : 'Solver'}</th>
            <th>Próby</th>
            <th>Udane</th>
            <th>Błędy</th>
            <th>Przerwane</th>
            <th>{proxy ? 'Średni czas' : 'Rozwiązanie CAPTCHA'}</th>
            <th>{proxy ? 'W tym CAPTCHA' : 'Całe sprawdzenie (n)'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>
                <strong>{r.name}</strong>
              </td>
              <td>{r.total}</td>
              <td>{r.completed}</td>
              <td>{r.failed}</td>
              <td>{r.interrupted}</td>
              <td>{duration(r.averageMs)}</td>
              <td>
                {proxy
                  ? duration(r.averageCaptchaMs)
                  : `${duration(r.averageCheckMs)} (${r.checkSamples ?? 0})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
