import { useEffect, useState } from 'react';
import { Activity, Clock3, Wallet, RefreshCw, RotateCcw } from 'lucide-react';
import { api, post } from './api';
import {
  duration,
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
  solverIds,
  solverLabels,
  type SystemStatus,
  type SystemSettings,
  type SolverBalance,
  type Metric,
  type ProxyTest,
} from '../shared/system';

export function SystemPanel() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [balance, setBalance] = useState<SolverBalance | null>(null);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [concurrencyMessage, setConcurrencyMessage] = useState('');
  async function saveConcurrency() {
    if (concurrency === null) return;
    setSavingConcurrency(true);
    setError('');
    setConcurrencyMessage('');
    try {
      const saved = await post<{ concurrency: number }>('/api/v1/system/concurrency', {
        concurrency,
      });
      setData((d) => (d ? { ...d, concurrency: saved.concurrency } : d));
      setConcurrencyMessage(
        `Zapisano limit: ${saved.concurrency}. Trwające sprawdzenia dokończą pracę.`,
      );
      setRevision((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingConcurrency(false);
    }
  }
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  async function resetStatistics() {
    setResetting(true);
    setError('');
    setResetMessage('');
    try {
      await post('/api/v1/system/statistics/reset', {});
      setResetConfirm(false);
      setRevision((r) => r + 1);
      setResetMessage(
        'Rozpoczęto nowy okres pomiarowy. Statystyki obejmują wyłącznie sprawdzenia zlecone od teraz.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResetting(false);
    }
  }
  const [probing, setProbing] = useState(false),
    [probes, setProbes] = useState<ProxyTest[]>([]);
  async function probe() {
    setProbing(true);
    setError('');
    try {
      const r = await post<{ items: ProxyTest[] }>('/api/v1/proxies/test', {});
      setProbes(r.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProbing(false);
    }
  }
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const value = await api<SystemStatus>('/api/v1/system');
        if (alive) {
          setData(value);
          setConcurrency((c) => c ?? value.concurrency);
          setSettings((s) =>
            s
              ? {
                  ...s,
                  proxyMode:
                    value.proxyOptions.some((p) => p.label === s.proxyMode) ||
                    (s.proxyMode === 'random' && value.proxyOptions.length >= 2)
                      ? s.proxyMode
                      : value.settings.proxyMode,
                }
              : value.settings,
          );
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
      setMessage(
        'Zapisano. Nowe sprawdzenia użyją wybranego proxy; rozpoczęte zachowają dotychczasowe.',
      );
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
        <span>
          {data?.statisticsSince
            ? `Statystyki od ${new Date(data.statisticsSince).toLocaleString('pl-PL')}`
            : 'Statystyki od włączenia pomiarów'}{' '}
          · odświeżanie co 10 s
        </span>
        <div className="statistics-actions">
          <button className="secondary" onClick={() => setRevision((r) => r + 1)}>
            <RefreshCw size={16} />
            Odśwież
          </button>
          <button
            className="secondary"
            disabled={!data || resetting}
            onClick={() => {
              setResetConfirm(true);
              setResetMessage('');
            }}
          >
            <RotateCcw size={16} /> Resetuj statystyki
          </button>
        </div>
      </div>
      {resetConfirm && (
        <section className="system-card" aria-label="Reset statystyk">
          <h2>Rozpocząć nowy okres pomiarowy?</h2>
          <p>
            Wyzerujemy porównania proxy i solverów, średnie czasy oraz statystyki limitów Apple.
            Będą liczyć się tylko sprawdzenia zlecone po resecie — także zadania będące teraz w
            kolejce lub w toku nie trafią do nowych pomiarów.
          </p>
          <p>
            Historia sprawdzeń, paczki i logi pozostaną dostępne. Reset nie odnawia salda ani
            dziennych limitów użycia.
          </p>
          <div className="statistics-actions">
            <button
              className="secondary"
              disabled={resetting}
              onClick={() => setResetConfirm(false)}
            >
              Anuluj
            </button>
            <button className="primary" disabled={resetting} onClick={() => void resetStatistics()}>
              {resetting ? 'Resetowanie…' : 'Rozpocznij nowy okres'}
            </button>
          </div>
        </section>
      )}
      {resetMessage && (
        <div className="notice" role="status">
          {resetMessage}
        </div>
      )}
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
                  {data?.proxyOptions.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label} · {p.provider}
                    </option>
                  ))}
                  {(data?.proxyOptions.length ?? 0) >= 2 && (
                    <option value="random">
                      Losowo — wszyscy dostawcy ({data?.proxyOptions.length})
                    </option>
                  )}
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
              Losowanie wybiera proxy raz na sprawdzenie. Ponowienia zachowują dostawcę i otwierają
              nowe sesje IP. Evomi dodaj przez PROXY_EXTRA_URLS. Aby włączyć CaptchaAI, ustaw
              CAPTCHAAI_API_KEY w Railway.
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
        <h2>Równoległe sprawdzenia</h2>
        <p>
          Wspólny limit dla całej aplikacji, pojedynczych SN i paczek. Zmiana działa bez restartu.
          Po zmniejszeniu limitu nowe zadania poczekają na zwolnienie miejsc; trwające sprawdzenia
          dokończą pracę.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveConcurrency();
          }}
        >
          <div className="system-settings">
            <label>
              Liczba równoległych sprawdzeń
              <select
                value={concurrency ?? ''}
                disabled={concurrency === null || savingConcurrency}
                onChange={(e) => {
                  setConcurrency(Number(e.target.value));
                  setConcurrencyMessage('');
                }}
              >
                {concurrency === null && <option value="">Wczytywanie…</option>}
                {Array.from(
                  { length: MAX_CONCURRENCY - MIN_CONCURRENCY + 1 },
                  (_, i) => i + MIN_CONCURRENCY,
                ).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>
            Aktywny limit: <strong>{data?.concurrency ?? '—'}</strong> · W toku:{' '}
            {data?.running ?? '—'} · W kolejce: {data?.queued ?? '—'}. Odstęp między startami i
            limity dzienne nadal obowiązują.
          </p>
          <button className="primary" disabled={savingConcurrency || concurrency === null}>
            {savingConcurrency ? 'Zapisywanie…' : 'Zapisz limit równoległości'}
          </button>
          {concurrencyMessage && (
            <p className="system-saved" role="status">
              {concurrencyMessage}
            </p>
          )}
        </form>
      </section>
      <section className="system-card">
        <h2>Diagnostyka proxy</h2>
        <p>
          Sam tunel CONNECT do Apple, bez wysyłania żądania do serwisu i bez CAPTCHA. Test sprawdza
          konfigurację, a następnie samo hasło bez parametrów. Sukces potwierdza tunel, nie wynik
          gwarancji.
        </p>
        <button className="secondary" disabled={probing || data?.demo} onClick={() => void probe()}>
          {probing ? 'Testowanie tuneli…' : 'Testuj proxy'}
        </button>
        {probes.map((p) => (
          <article className="run-card" key={p.label}>
            <strong>{p.label}</strong>
            <p className={p.configured.ok ? 'system-saved' : 'batch-error-caption'}>
              {p.diagnosis}
            </p>
            <p>
              Z parametrami: {p.configured.status ?? 'brak odpowiedzi'} ·{' '}
              {duration(p.configured.ms)} · {p.configured.reason} | Bez parametrów:{' '}
              {p.bare.status ?? 'brak odpowiedzi'} · {duration(p.bare.ms)} · {p.bare.reason}
            </p>
            <p>
              Login: {p.info.username} · długość hasła: {p.info.passwordLength} (bez parametrów:{' '}
              {p.info.basePasswordLength}) · IP: {p.configured.exitIp ?? 'nieznane — dopuszczalne'}
            </p>
            <p>Parametry: {p.info.params.join(', ') || 'brak'}</p>
            {p.info.warnings.map((w) => (
              <p className="notice" key={w}>
                {w}
              </p>
            ))}
          </article>
        ))}
      </section>
      <section className="system-card">
        <h2>Wydajność wg proxy</h2>
        <p>
          Nowe pomiary od tej aktualizacji. Czas obsługi Apple obejmuje sesje sprawdzenia i czekanie
          na stronę, bez uruchamiania przeglądarki i oczekiwania na solver. To pomiar klienta, nie
          sam czas transmisji. Średnia i mediana dotyczą udanych sprawdzeń.
        </p>
        <div className="system-table-wrap">
          <table className="system-table">
            <thead>
              <tr>
                <th>Proxy</th>
                <th>Sprawdzenia</th>
                <th>Skuteczność</th>
                <th>Średni czas Apple</th>
                <th>Mediana</th>
                <th>Sesje</th>
                <th>Limity</th>
                <th>Błędy proxy</th>
              </tr>
            </thead>
            <tbody>
              {data?.proxyPerformance.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>{p.total}</td>
                  <td>
                    {p.total ? Math.round((p.completed / p.total) * 100) : 0}% ({p.completed})
                  </td>
                  <td>{duration(p.averageMs)}</td>
                  <td>{duration(p.medianMs)}</td>
                  <td>{p.sessions}</td>
                  <td>{p.limits}</td>
                  <td>{p.proxyErrors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data?.proxyPerformance.length && <p>Brak zakończonych pomiarów sesji.</p>}
      </section>
      <section className="system-card">
        <h2>Limity Apple</h2>
        <p>
          Odsetek sesji z rozpoznaną planszą „We'll be back” lub HTTP 429. Etapy liczymy wśród
          sesji, które do nich dotarły. Godzina rozpoczęcia w UTC (ostatnie 168 widocznych godzin);
          równoległość i kolejka są zapisywane przy otwieraniu sesji. Sama plansza nie dowodzi
          przyczyny ograniczenia.
        </p>
        {(['proxy', 'concurrency', 'stage', 'hour'] as const).map((dim) => (
          <details key={dim} open={dim === 'proxy'}>
            <summary>
              {
                {
                  proxy: 'Według proxy',
                  concurrency: 'Według równoległości',
                  stage: 'Według etapu',
                  hour: 'Według godziny UTC',
                }[dim]
              }
            </summary>
            <div className="system-table-wrap">
              <table className="system-table">
                <thead>
                  <tr>
                    <th>Grupa</th>
                    <th>Sesje</th>
                    <th>Z limitem</th>
                    <th>Odsetek</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.limits
                    .filter((x) => x.dimension === dim)
                    .map((x) => (
                      <tr key={x.name}>
                        <td>{x.name}</td>
                        <td>{x.sessions}</td>
                        <td>{x.limited}</td>
                        <td>{x.sessions ? ((x.limited / x.sessions) * 100).toFixed(1) : '0'}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </section>
      <section className="system-card">
        <h2>Porównanie proxy</h2>
        <p>
          Średnie dotyczą udanych prób i obejmują oczekiwanie na solver. Błędy oraz przerwane próby
          liczymy osobno. To czas całego sprawdzenia, a nie sam ping proxy.
        </p>
        <Metrics
          rows={[
            ...new Set([
              ...(data?.proxyOptions.map((p) => p.label) ?? []),
              ...(data?.proxies.map((p) => p.name) ?? []),
            ]),
          ].map((name) => data?.proxies.find((p) => p.name === name) ?? emptyMetric(name))}
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
