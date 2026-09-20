import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check as CheckIcon,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Clock3,
  ExternalLink,
  History,
  Folders,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  X,
  XCircle,
} from 'lucide-react';
import type { Check, Overview } from '../shared/types';
import { stageLabels } from '../shared/types';
import './styles.css';
import { api, post, HttpError } from './api';
import { SystemPanel } from './system-panel';
import { BatchPanel } from './batch-panel';
import { duration } from '../shared/system';

const date = (value: string) =>
  new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
const number = (value: number) => new Intl.NumberFormat('pl-PL').format(value);

function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <ShieldCheck size={24} />
      </span>
      <span>
        coverage<span className="brand-light">desk</span>
      </span>
    </div>
  );
}

function Login({ onLogin, demo }: { onLogin: () => void; demo: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/api/login', { password });
      setPassword('');
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-intro">
        <Brand />
        <div>
          <span className="eyebrow">TWOJE URZĄDZENIA. TWOJE DANE.</span>
          <h1>
            Wszystkie sprawdzenia.
            <br />
            Jedno miejsce.
          </h1>
          <p>Status gwarancji Apple i pełna historia wyników w Twoim prywatnym panelu.</p>
          <div className="login-features">
            <span>
              <ShieldCheck />
              Informacje ze strony Apple
            </span>
            <span>
              <History />
              Historia bez limitu czasu
            </span>
          </div>
        </div>
        <span className="login-foot">
          Coverage Desk <span>01 / DOSTĘP PRYWATNY</span>
        </span>
      </div>
      <section className="login-form-wrap">
        <form onSubmit={submit} className="login-form">
          <div className="lock-tile">
            <LockKeyhole size={26} />
          </div>
          <h2>Witaj ponownie</h2>
          <p>Podaj hasło, aby otworzyć swój panel.</p>
          {demo && (
            <div className="notice">
              Podgląd demonstracyjny. Hasło: <strong>demo-coverage-2026</strong>. Wyniki są
              przykładowe.
            </div>
          )}
          <label htmlFor="password">Hasło dostępu</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            placeholder="Wprowadź hasło"
            maxLength={256}
          />
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <>
                Otwórz panel <ArrowRight size={18} />
              </>
            )}
          </button>
          <p className="privacy-note">
            <LockKeyhole size={14} />
            Dostęp wyłącznie dla administratora
          </p>
        </form>
      </section>
    </main>
  );
}

function Status({ check }: { check: Check }) {
  if (check.status === 'queued')
    return (
      <span className="badge pending">
        <Clock3 size={13} />W kolejce
      </span>
    );
  if (check.status === 'running')
    return (
      <span className="badge processing">
        <LoaderCircle size={13} className="spin" />W trakcie
      </span>
    );
  if (check.status === 'failed')
    return (
      <span className="badge failure">
        <XCircle size={13} />
        Błąd sprawdzenia
      </span>
    );
  if (check.result?.coverageStatus === 'active')
    return (
      <span className="badge active">
        <CircleCheck size={13} />
        Aktywna ochrona
      </span>
    );
  if (check.result?.coverageStatus === 'expired')
    return (
      <span className="badge expired">
        <Clock3 size={13} />
        Ochrona wygasła
      </span>
    );
  return (
    <span className="badge unknown">
      <CircleHelp size={13} />
      Status nieustalony
    </span>
  );
}

function Detail({
  check,
  close,
  repeat,
}: {
  check: Check;
  close: () => void;
  repeat: (serial: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const result = check.result;
  const pending = check.status === 'queued' || check.status === 'running';
  return (
    <dialog ref={ref} onCancel={close} className="detail-dialog" aria-labelledby="detail-title">
      <div className="detail-top">
        <span className="eyebrow">SZCZEGÓŁY SPRAWDZENIA</span>
        <button onClick={close} className="icon-button" aria-label="Zamknij szczegóły">
          <X size={21} />
        </button>
      </div>
      <div className="device-heading">
        <span className="device-icon large">
          <Smartphone size={30} />
        </span>
        <div>
          <h2 id="detail-title">{result?.model ?? 'Urządzenie Apple'}</h2>
          <code>{check.serial}</code>
        </div>
      </div>
      <Status check={check} />
      {result?.source === 'demo' && (
        <div className="notice">Przykładowy wynik demonstracyjny — nie pochodzi z Apple.</div>
      )}
      {pending && (
        <div className="progress-info">
          <LoaderCircle className="spin" size={22} />
          <div>
            <strong>{stageLabels[check.stage]}</strong>
            <p>Możesz zamknąć ten widok. Wynik pojawi się w historii.</p>
          </div>
        </div>
      )}
      {check.errorMessage && (
        <div className="error" role="alert">
          {check.errorMessage}
        </div>
      )}
      <dl className="result-fields">
        <div>
          <dt>Zlecono</dt>
          <dd>{date(check.createdAt)}</dd>
        </div>
        {check.finishedAt && (
          <div>
            <dt>Zakończono</dt>
            <dd>{date(check.finishedAt)}</dd>
          </div>
        )}
        {result && (
          <>
            <div>
              <dt>Rodzaj ochrony</dt>
              <dd>{result.coverageLabel ?? 'Brak jednoznacznej informacji'}</dd>
            </div>
            <div>
              <dt>Data końca ochrony</dt>
              <dd>{result.expirationDate ?? 'Nie podano'}</dd>
            </div>
            {result.renewalDate && (
              <div>
                <dt>Data odnowienia planu</dt>
                <dd>{result.renewalDate}</dd>
              </div>
            )}
            <div>
              <dt>Data zakupu</dt>
              <dd>{result.purchaseDate ?? 'Nie podano'}</dd>
            </div>
          </>
        )}
      </dl>
      {result && (
        <details className="raw-result">
          <summary>Pełna treść odpowiedzi Apple</summary>
          <pre>{result.rawText}</pre>
        </details>
      )}
      <section className="run-details" aria-label="Czasy i integracje">
        <h3>Czasy i integracje</h3>
        {check.finishedAt && (
          <p>
            Łącznie od zlecenia:{' '}
            <strong>{duration(Date.parse(check.finishedAt) - Date.parse(check.createdAt))}</strong>
          </p>
        )}
        {!check.runs?.length && <p>Brak zapisanych pomiarów dla tego sprawdzenia.</p>}
        {check.runs?.map((run) => (
          <div className="run-card" key={run.token}>
            <strong>
              Próba {run.attempt} ·{' '}
              {
                {
                  running: 'W toku',
                  completed: 'Ukończona',
                  failed: 'Błąd',
                  interrupted: 'Przerwana',
                }[run.status]
              }
            </strong>
            <dl className="result-fields">
              <div>
                <dt>Proxy</dt>
                <dd>{run.proxy}</dd>
              </div>
              <div>
                <dt>Solver przypisany</dt>
                <dd>{run.solver}</dd>
              </div>
              <div>
                <dt>Czas próby (bez kolejki)</dt>
                <dd>{duration(run.durationMs)}</dd>
              </div>
              <div>
                <dt>Od zlecenia do startu próby</dt>
                <dd>{duration(run.queueMs)}</dd>
              </div>
              <div>
                <dt>CAPTCHA · wywołania</dt>
                <dd>
                  {duration(run.captchaMs)} · {run.captchaCalls}
                </dd>
              </div>
              {run.sessions != null && (
                <>
                  <div>
                    <dt>Sesje / trafienia limitu</dt>
                    <dd>
                      {run.sessions} / {run.rateLimits ?? 0}
                    </dd>
                  </div>
                  <div>
                    <dt>Czas obsługi Apple (bez solvera)</dt>
                    <dd>{duration(run.appleMs)}</dd>
                  </div>
                </>
              )}
            </dl>
          </div>
        ))}
      </section>
      {!!check.proxySessions?.length && (
        <details className="raw-result">
          <summary>Sesje proxy i limity ({check.proxySessions.length})</summary>
          {check.proxySessions.map((s) => (
            <div className="run-card" key={s.id}>
              <strong>
                {s.proxy} · {date(s.startedAt)}
              </strong>
              <p>
                {s.limited ? `Limit na etapie: ${s.stage}` : s.outcome} · Apple:{' '}
                {duration(s.appleMs)}
              </p>
              <p>
                Równoległe sprawdzenia: {s.concurrency} · Kolejka: {s.queued} · IP:{' '}
                {s.exitIp ?? 'nieznane'}
              </p>
            </div>
          ))}
        </details>
      )}
      <details className="raw-result diagnostic-log" open={check.status === 'failed'}>
        <summary>Dziennik diagnostyczny {check.errorCode ? `· ${check.errorCode}` : ''}</summary>
        {!check.diagnostics?.length ? (
          <p>Brak logów. Diagnostyka jest zapisywana dla nowych prób od tej aktualizacji.</p>
        ) : (
          <ol>
            {check.diagnostics.map((entry, index) => (
              <li key={index}>
                <span>
                  {new Date(entry.at).toLocaleTimeString('pl-PL')} · próba {entry.attempt} ·{' '}
                  {entry.step}
                </span>
                <p>{entry.message}</p>
              </li>
            ))}
          </ol>
        )}
      </details>
      <div className="detail-actions">
        <a
          className="secondary"
          href="https://checkcoverage.apple.com/?locale=en_US"
          target="_blank"
          rel="noreferrer"
        >
          Strona Apple <ExternalLink size={15} />
        </a>
        {!pending && (
          <button className="primary" onClick={() => repeat(check.serial)}>
            Sprawdź ponownie <ArrowRight size={16} />
          </button>
        )}
      </div>
      <p className="detail-note">
        Wynik przedstawia stan w momencie sprawdzenia. Brak podanej daty nie oznacza wygaśnięcia
        ochrony.
      </p>
    </dialog>
  );
}

function Dashboard({ logout, demo }: { logout: () => void; demo: boolean }) {
  const [view, setView] = useState<'overview' | 'history' | 'system' | 'batches'>(() =>
    location.hash.startsWith('#batches') ? 'batches' : 'overview',
  );
  useEffect(() => {
    if (view !== 'batches' && location.hash.startsWith('#batches'))
      history.replaceState(null, '', location.pathname);
  }, [view]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [items, setItems] = useState<Check[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [serial, setSerial] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<Check | null>(null);
  const [loaded, setLoaded] = useState(false);
  const submission = useRef<{ serial: string; key: string } | null>(null);
  const serialInput = useRef<HTMLInputElement>(null);
  const selectedId = selected?.id;
  const refreshNumber = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const refresh = useCallback(async () => {
    const generation = ++refreshNumber.current;
    try {
      const q = new URLSearchParams({
        search: debouncedSearch,
        status: filter,
        page: String(page),
      });
      const [stats, history, detail] = await Promise.all([
        api<Overview>('/api/v1/overview'),
        api<{ items: Check[]; total: number }>(`/api/v1/checks?${q}`),
        selectedId ? api<Check>(`/api/v1/checks/${selectedId}`) : Promise.resolve(null),
      ]);
      if (generation !== refreshNumber.current) return;
      setOverview(stats);
      setItems(history.items);
      setTotal(history.total);
      setConnectionError('');
      setLoaded(true);
      if (detail) setSelected((previous) => (previous?.id === detail.id ? detail : previous));
    } catch (e) {
      if (generation === refreshNumber.current) setConnectionError((e as Error).message);
    }
  }, [debouncedSearch, filter, page, selectedId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => {
      clearInterval(timer);
      refreshNumber.current++;
    };
  }, [refresh]);

  async function submit(value: string) {
    const clean = value.trim().toUpperCase();
    if (!/^[A-Z0-9]{8,12}$/.test(clean) || /^\d+$/.test(clean)) {
      setError('Podaj SN: 8–12 liter lub cyfr. Numery IMEI nie są jeszcze obsługiwane.');
      serialInput.current?.focus();
      return;
    }
    setSubmitting(true);
    setError('');
    setMessage('');
    if (submission.current?.serial !== clean)
      submission.current = { serial: clean, key: crypto.randomUUID() };
    try {
      const result = await post<{ check: Check; reused: boolean }>(
        '/api/v1/checks',
        { serial: clean },
        { 'Idempotency-Key': submission.current.key },
      );
      submission.current = null;
      setSerial('');
      setPage(1);
      setSearch('');
      setFilter('');
      setMessage(
        result.reused
          ? 'To sprawdzenie jest już zapisane. Otwieram jego status.'
          : 'Dodano do kolejki. Wynik zostanie zapisany automatycznie.',
      );
      setSelected(result.check);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  async function signout() {
    try {
      await post('/api/logout', {});
      logout();
    } catch (e) {
      setConnectionError((e as Error).message);
    }
  }
  const configured = demo || !!(overview?.integrations.captcha && overview.integrations.proxy);
  const canSubmit = configured && !!overview?.integrations.worker;
  const pages = Math.max(1, Math.ceil(total / 25));
  const percent = overview ? Math.min(100, (overview.today / overview.dailyLimit) * 100) : 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">PRZESTRZEŃ ROBOCZA</div>
        <nav aria-label="Menu główne">
          <button
            className={view === 'overview' ? 'nav-item selected' : 'nav-item'}
            onClick={() => {
              setView('overview');
              setPage(1);
              setSearch('');
              setFilter('');
            }}
          >
            <LayoutDashboard size={19} />
            Przegląd
          </button>
          <button
            className={view === 'history' ? 'nav-item selected' : 'nav-item'}
            onClick={() => setView('history')}
          >
            <History size={19} />
            Historia sprawdzeń
            <span className="nav-count">{overview ? number(overview.total) : '—'}</span>
          </button>
          <button
            className={view === 'batches' ? 'nav-item selected' : 'nav-item'}
            onClick={() => setView('batches')}
          >
            <Folders size={19} />
            Paczki SN
          </button>
          <button
            className={view === 'system' ? 'nav-item selected' : 'nav-item'}
            onClick={() => setView('system')}
          >
            <Activity size={19} />
            Stan systemu
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note-icon">
            <ShieldCheck size={22} />
          </span>
          <strong>Twoja historia zostaje.</strong>
          <p>Wyniki są zapisywane bez automatycznego usuwania.</p>
        </div>
        <div className="sidebar-bottom">
          <div className="admin-avatar">A</div>
          <div>
            <strong>Administrator</strong>
            <span>
              <LockKeyhole size={11} />
              Dostęp prywatny
            </span>
          </div>
          <button className="icon-button" onClick={() => void signout()} aria-label="Wyloguj się">
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <span>
            Panel urządzeń<span className="breadcrumb-slash">/</span>
            <strong>
              {view === 'batches'
                ? 'Paczki SN'
                : view === 'system'
                  ? 'Stan systemu'
                  : view === 'overview'
                    ? 'Przegląd'
                    : 'Historia'}
            </strong>
          </span>
          <span className="topbar-private">
            <LockKeyhole size={13} />
            Prywatna przestrzeń
          </span>
          <button
            className="icon-button mobile-logout"
            onClick={() => void signout()}
            aria-label="Wyloguj się"
          >
            <LogOut size={18} />
          </button>
        </header>
        <main className="dashboard">
          <div className="page-heading">
            <div>
              <span className="eyebrow">APPLE COVERAGE</span>
              <h1>
                {view === 'batches'
                  ? 'Sprawdzenia hurtowe.'
                  : view === 'system'
                    ? 'Stan systemu.'
                    : view === 'overview'
                      ? 'Sprawdź gwarancję.'
                      : 'Historia sprawdzeń.'}
              </h1>
              <p>
                {view === 'batches'
                  ? 'Importuj numery, śledź postęp i pobieraj wyniki całych paczek.'
                  : view === 'system'
                    ? 'Integracje, wydajność i diagnostyka Twoich sprawdzeń.'
                    : view === 'overview'
                      ? 'Aktualny status ochrony Twoich urządzeń, w jednym miejscu.'
                      : 'Wszystkie numery seryjne i zapisane odpowiedzi Apple.'}
              </p>
            </div>
            <div className="source-label">
              <ShieldCheck size={17} />
              <span>
                Źródło danych
                <strong>{demo ? 'Dane demonstracyjne' : 'Apple Check Coverage'}</strong>
              </span>
            </div>
          </div>
          {demo && (
            <div className="notice demo-notice">
              <CircleHelp size={18} />
              <span>
                <strong>Tryb demonstracyjny.</strong> Przykładowe wyniki. Zapytania nie trafiają do
                Apple, solverów CAPTCHA ani ProxyMesh.
              </span>
            </div>
          )}
          {connectionError && (
            <div className="error" role="alert">
              {connectionError}{' '}
              <button className="text-button" onClick={() => void refresh()}>
                Odśwież
              </button>
            </div>
          )}
          {view === 'overview' && (
            <>
              <section className="stats-grid" aria-label="Statystyki">
                <article className="stat-card stat-primary">
                  <div className="stat-title">
                    Sprawdzenia dzisiaj <Activity size={18} />
                  </div>
                  <div className="stat-value">
                    {overview ? number(overview.today) : '—'}
                    <span>/ {overview ? number(overview.dailyLimit) : '—'}</span>
                  </div>
                  <div className="usage-track">
                    <div style={{ width: `${percent}%` }} />
                  </div>
                  <small>Dzienny limit • rozliczany według UTC</small>
                </article>
                <article className="stat-card">
                  <div className="stat-title">
                    Zapisane wyniki <History size={18} />
                  </div>
                  <div className="stat-value">{overview ? number(overview.completed) : '—'}</div>
                  <small>
                    <span className="mini-check">
                      <CheckIcon size={12} />
                    </span>
                    Pełna historia bez limitu czasu
                  </small>
                </article>
                <article className="stat-card">
                  <div className="stat-title">
                    W kolejce i w trakcie <Clock3 size={18} />
                  </div>
                  <div className="stat-value">
                    {overview ? number(overview.pending) : '—'}
                    <span>sprawdzeń</span>
                  </div>
                  <small>
                    {overview?.pending
                      ? 'Wyniki pojawią się automatycznie'
                      : 'Gotowe na kolejne urządzenie'}
                  </small>
                </article>
              </section>
              <div className="check-grid">
                <section className="new-check-card">
                  <div className="card-heading">
                    <span className="icon-tile">
                      <Search size={22} />
                    </span>
                    <div>
                      <h2>Nowe sprawdzenie</h2>
                      <p>Wprowadź numer seryjny urządzenia Apple.</p>
                    </div>
                    <span className="sn-pill">SN</span>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit(serial);
                    }}
                  >
                    <label htmlFor="serial">Numer seryjny</label>
                    <div className="serial-control">
                      <input
                        ref={serialInput}
                        id="serial"
                        value={serial}
                        onChange={(e) => setSerial(e.target.value.toUpperCase())}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={20}
                        placeholder="np. C39XXXXXXXXX"
                        aria-describedby="serial-help"
                        required
                      />
                      <button className="primary" disabled={submitting || !canSubmit}>
                        {submitting ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <>
                            Sprawdź gwarancję <ArrowRight size={17} />
                          </>
                        )}
                      </button>
                    </div>
                    <p id="serial-help" className="field-help">
                      <CircleHelp size={14} />
                      SN znajdziesz w Ustawieniach → Ogólne → To urządzenie.
                    </p>
                    {error && (
                      <div className="error" role="alert">
                        {error}
                      </div>
                    )}
                    {message && (
                      <div className="success-message" role="status">
                        <CircleCheck size={16} />
                        {message}
                      </div>
                    )}
                    {overview && !canSubmit && (
                      <div className="notice">
                        {!configured
                          ? 'Uzupełnij dane wybranego solvera CAPTCHA i ProxyMesh w zmiennych serwera.'
                          : 'Proces sprawdzający jest niedostępny. Uruchom usługę worker na Railway.'}
                      </div>
                    )}
                  </form>
                  <div className="form-footer">
                    <span>
                      <LockKeyhole size={13} />
                      Dostęp prywatny
                    </span>
                    <span>Obsługa numerów seryjnych Apple</span>
                  </div>
                </section>
                <aside className="connections-card">
                  <div className="connections-heading">
                    <h2>Połączenia</h2>
                    <SlidersHorizontal size={17} />
                  </div>
                  <div className="connection-row">
                    <span>
                      Solver CAPTCHA<small>Rozwiązywanie kodów</small>
                    </span>
                    <span
                      className={
                        overview?.integrations.captcha || demo
                          ? 'connection-state'
                          : 'connection-state missing'
                      }
                    >
                      {demo ? 'Demo' : overview?.integrations.captcha ? 'Ustawiono' : 'Brak danych'}
                    </span>
                  </div>
                  <div className="connection-row">
                    <span>
                      Proxy<small>Połączenie ze stroną Apple</small>
                    </span>
                    <span
                      className={
                        overview?.integrations.proxy || demo
                          ? 'connection-state'
                          : 'connection-state missing'
                      }
                    >
                      {demo ? 'Demo' : overview?.integrations.proxy ? 'Ustawiono' : 'Brak danych'}
                    </span>
                  </div>
                  <div className="connection-row">
                    <span>Proces sprawdzający</span>
                    <span
                      className={
                        overview?.integrations.worker
                          ? 'connection-state'
                          : 'connection-state missing'
                      }
                    >
                      {overview?.integrations.worker ? 'Dostępny' : 'Niedostępny'}
                    </span>
                  </div>
                  <div className="captcha-usage">
                    Zadania CAPTCHA dzisiaj{' '}
                    <strong>
                      {overview
                        ? `${number(overview.captchaToday)} / ${number(overview.captchaDailyLimit)}`
                        : '—'}
                    </strong>
                  </div>
                  <p className="connection-note">
                    „Ustawiono” oznacza obecność danych dostępowych. Połączenie jest sprawdzane
                    podczas realizacji zadania.
                  </p>
                </aside>
              </div>
            </>
          )}
          {view === 'system' && <SystemPanel />}
          {view === 'batches' && <BatchPanel onCheck={setSelected} overview={overview} />}
          {(view === 'overview' || view === 'history') && (
            <section className="history-card">
              <div className="history-heading">
                <div>
                  <h2>
                    {view === 'overview' ? 'Ostatnie sprawdzenia' : 'Wszystkie sprawdzenia'}
                    <span className="count-pill">{number(total)}</span>
                  </h2>
                  <p>Wyniki zapisują się tutaj automatycznie.</p>
                </div>
                {view === 'history' && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setView('overview');
                      serialInput.current?.focus();
                    }}
                  >
                    <ArrowLeft size={15} />
                    Nowe sprawdzenie
                  </button>
                )}
              </div>
              <div className="table-toolbar">
                <div className="search-wrap">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(e) =>
                      setSearch(e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 12))
                    }
                    placeholder="Szukaj numeru seryjnego…"
                    aria-label="Szukaj w historii"
                  />
                </div>
                <label className="filter-wrap">
                  <SlidersHorizontal size={15} />
                  <select
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Filtruj według statusu"
                  >
                    <option value="">Wszystkie statusy</option>
                    <option value="completed">Zakończone</option>
                    <option value="running">W trakcie</option>
                    <option value="queued">W kolejce</option>
                    <option value="failed">Błędy</option>
                  </select>
                </label>
              </div>
              <div className="table-scroll">
                <table className="record-table" role="table" aria-label="Historia sprawdzeń">
                  <thead>
                    <tr>
                      <th>URZĄDZENIE / NUMER SERYJNY</th>
                      <th>STATUS OCHRONY</th>
                      <th>DATA / CZAS / PROXY</th>
                      <th>
                        <span className="sr-only">Szczegóły</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((check) => (
                      <tr key={check.id}>
                        <td>
                          <div className="table-device">
                            <span className="device-icon">
                              <Smartphone size={20} />
                            </span>
                            <div>
                              <strong>
                                {check.result?.model ??
                                  (check.status === 'failed'
                                    ? 'Nie odczytano urządzenia'
                                    : 'Urządzenie Apple')}
                              </strong>
                              <code>{check.serial}</code>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Status check={check} />
                          {check.status === 'running' && (
                            <span className="stage-caption">{stageLabels[check.stage]}</span>
                          )}
                        </td>
                        <td className="date-cell" data-label="Data / czas / proxy">
                          {date(check.createdAt)}
                          <span className="stage-caption">
                            {duration(check.runs?.at(-1)?.durationMs)} ·{' '}
                            {check.runs?.at(-1)?.proxy ?? 'Brak pomiaru'}
                          </span>
                        </td>
                        <td className="record-action">
                          <button
                            className="row-action"
                            onClick={() => setSelected(check)}
                            aria-label={`Szczegóły ${check.serial}`}
                          >
                            <span>Szczegóły</span>
                            <ChevronRight size={17} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!items.length && (
                <div className="empty-state">
                  {!loaded ? <LoaderCircle size={28} className="spin" /> : <History size={30} />}
                  <strong>
                    {!loaded
                      ? 'Wczytywanie historii…'
                      : search || filter
                        ? 'Brak pasujących sprawdzeń'
                        : 'Tutaj zacznie się Twoja historia'}
                  </strong>
                  <p>
                    {search || filter
                      ? 'Zmień numer seryjny lub wybrany status.'
                      : 'Wprowadź pierwszy numer seryjny powyżej. Zachowamy wynik i datę sprawdzenia.'}
                  </p>
                </div>
              )}
              <div className="table-footer">
                <span>
                  {total
                    ? `${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} z ${number(total)} sprawdzeń`
                    : '0 sprawdzeń'}
                  <span className="retention-note">Historia bez automatycznego usuwania</span>
                </span>
                <div className="pagination">
                  <button
                    className="icon-button"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                    aria-label="Poprzednia strona"
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <span>
                    {page} / {pages}
                  </span>
                  <button
                    className="icon-button"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                    aria-label="Następna strona"
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
              </div>
            </section>
          )}
          <footer className="page-footer">
            <span>
              Coverage Desk <span>•</span> Niezależne narzędzie, niepowiązane z Apple Inc.
            </span>
            <a
              href="https://checkcoverage.apple.com/?locale=en_US"
              target="_blank"
              rel="noreferrer"
            >
              Apple Check Coverage <ExternalLink size={12} />
            </a>
          </footer>
        </main>
      </div>
      {selected && (
        <Detail
          key={selected.id}
          check={selected}
          close={() => setSelected(null)}
          repeat={(value) => {
            setSelected(null);
            setView('overview');
            void submit(value);
          }}
        />
      )}
    </div>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    void api<{ authenticated: boolean; demo: boolean }>('/api/session')
      .then((r) => {
        setAuthenticated(r.authenticated);
        setDemo(r.demo);
      })
      .catch(() => setError('Nie można połączyć się z aplikacją. Sprawdź, czy serwer działa.'));
  };
  useEffect(() => {
    load();
    const expired = () => setAuthenticated(false);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  if (error)
    return (
      <main className="loading-screen">
        <XCircle />
        <p>{error}</p>
        <button className="primary" onClick={load}>
          Spróbuj ponownie
        </button>
      </main>
    );
  if (authenticated === null)
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" />
        <p>Otwieranie panelu…</p>
      </main>
    );
  return authenticated ? (
    <Dashboard demo={demo} logout={() => setAuthenticated(false)} />
  ) : (
    <Login demo={demo} onLogin={() => setAuthenticated(true)} />
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
