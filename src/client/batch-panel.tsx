import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, FolderPlus, Pause, Play, RotateCcw, X } from 'lucide-react';
import { api, post } from './api';
import {
  MAX_BATCH_SIZE,
  MAX_IMPORT_BYTES,
  parseSerials,
  batchStatus,
  itemStatus,
  type Batch,
  type BatchDetail,
} from '../shared/batches';
import type { Check, Overview } from '../shared/types';
import { duration } from '../shared/system';

const date = (s: string) => new Date(s).toLocaleString('pl-PL');
function Progress({ batch: b }: { batch: Batch }) {
  const done = b.completed + b.failed + b.cancelled;
  return (
    <div className="batch-progress">
      <div className="batch-progress-label">
        <strong>{Math.round((done / b.total) * 100)}%</strong>
        <span>
          {done} / {b.total} zakończonych
        </span>
      </div>
      <progress value={done} max={b.total} aria-label="Postęp paczki" />
    </div>
  );
}
export function BatchPanel({
  onCheck,
  overview,
}: {
  onCheck: (c: Check) => void;
  overview: Overview | null;
}) {
  const [id, setId] = useState<string | null>(() =>
    /^#batches\/[a-f0-9-]{36}$/.test(location.hash) ? location.hash.slice(9) : null,
  );
  const [list, setList] = useState<{ items: Batch[]; total: number }>({ items: [], total: 0 });
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [notes, setNotes] = useState(''),
    [text, setText] = useState('');
  const [ignoreInvalid, setIgnoreInvalid] = useState(false),
    [paused, setPaused] = useState(false);
  const [error, setError] = useState(''),
    [connectionError, setConnectionError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [editName, setEditName] = useState(''),
    [editNotes, setEditNotes] = useState('');
  const generation = useRef(0),
    locked = useRef(false),
    submission = useRef<{ signature: string; key: string } | null>(null);
  const parsed = useMemo(() => parseSerials(text), [text]);
  const refresh = useCallback(async () => {
    const g = ++generation.current;
    try {
      const q = new URLSearchParams({ search, status: filter, page: String(page) });
      if (id) {
        const d = await api<BatchDetail>(`/api/v1/batches/${id}?${q}`);
        if (g === generation.current) setDetail(d);
      } else {
        const l = await api<{ items: Batch[]; total: number }>(
          `/api/v1/batches?${new URLSearchParams({ search, page: String(page) })}`,
        );
        if (g === generation.current) setList(l);
      }
      if (g === generation.current) {
        setConnectionError('');
        setLoaded(true);
      }
    } catch (e) {
      if (g === generation.current) setConnectionError((e as Error).message);
    }
  }, [id, page, search, filter]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [refresh]);
  function open(next: string | null) {
    generation.current++;
    setId(next);
    setDetail(null);
    setPage(1);
    setSearch('');
    setFilter('');
    setCreating(false);
    setError('');
    setLoaded(false);
    history.replaceState(null, '', next ? `#batches/${next}` : '#batches');
  }
  async function action(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function create(retry = false) {
    const payload = retry
      ? {
          name: `${detail!.batch.name} — ponowienie`.slice(0, 120),
          notes: detail!.batch.notes,
          paused: false,
        }
      : { name, notes, text, ignoreInvalid, paused };
    const path = retry ? `/api/v1/batches/${id}/retry` : '/api/v1/batches';
    const signature = JSON.stringify({ path, payload });
    if (submission.current?.signature !== signature)
      submission.current = { signature, key: crypto.randomUUID() };
    const result = await post<{ id: string }>(path, payload, {
      'Idempotency-Key': submission.current.key,
    });
    submission.current = null;
    setText('');
    setName('');
    setNotes('');
    setIgnoreInvalid(false);
    setPaused(false);
    open(result.id);
  }
  async function update(patch: unknown) {
    await post(`/api/v1/batches/${id}`, patch);
    await refresh();
  }
  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES)
      throw new Error('Plik jest za duży. Maksymalny rozmiar to 250 KB.');
    if (!/\.(txt|csv|tsv)$/i.test(file.name))
      throw new Error('Wybierz plik TXT, CSV lub TSV z jedną kolumną SN.');
    setText(await file.text());
    setIgnoreInvalid(false);
    if (!name) setName(file.name.replace(/\.[^.]+$/, '').slice(0, 120));
  }
  async function download() {
    const response = await fetch(
      `/api/v1/batches/${id}/export.csv?${new URLSearchParams({ search, status: filter })}`,
      { credentials: 'same-origin' },
    );
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
      throw new Error('Nie udało się pobrać eksportu. Odśwież stronę i spróbuj ponownie.');
    }
    const url = URL.createObjectURL(await response.blob()),
      a = document.createElement('a');
    a.href = url;
    a.download = `paczka-${id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const batch = detail?.batch;
  const blocked =
    overview &&
    !overview.demo &&
    (!overview.integrations.worker ||
      !overview.integrations.captcha ||
      !overview.integrations.proxy ||
      overview.today >= overview.dailyLimit ||
      overview.captchaToday >= overview.captchaDailyLimit);
  return (
    <div className="batch-panel">
      <div className="batch-actions">
        {id ? (
          <button className="secondary" onClick={() => open(null)}>
            <ArrowLeft size={16} />
            Wszystkie paczki
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => {
              setCreating(!creating);
              setError('');
            }}
          >
            <FolderPlus size={17} />
            {creating ? 'Zamknij formularz' : 'Nowa paczka'}
          </button>
        )}
        <span className="field-help">Zapis w bazie · praca w tle · odświeżanie co 4 s</span>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {connectionError && (
        <div role="alert" className="error">
          {connectionError}{' '}
          <button className="text-button" onClick={() => void refresh()}>
            Odśwież
          </button>
        </div>
      )}
      {blocked && (
        <div className="notice">
          Osiągnięto limit dzienny lub integracja / worker jest niedostępny. Paczki pozostają
          zapisane; wolne pozycje trafią do kolejki, gdy system będzie gotowy. Limity są odnawiane o
          północy UTC.
        </div>
      )}
      {creating && !id && (
        <form
          className="batch-card batch-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(() => create());
          }}
        >
          <h2>Nowa paczka numerów seryjnych</h2>
          <label>
            Nazwa paczki
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              placeholder="np. Dostawa iPhone — wrzesień"
            />
          </label>
          <label>
            Notatka (opcjonalnie)
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              placeholder="Dostawca, numer dostawy lub uwagi"
            />
          </label>
          <label>
            Import pliku TXT / CSV / TSV
            <input
              type="file"
              accept=".txt,.csv,.tsv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                void action(() => importFile(f));
                e.target.value = '';
              }}
            />
          </label>
          <label>
            Numery seryjne
            <textarea
              rows={8}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setIgnoreInvalid(false);
              }}
              maxLength={MAX_IMPORT_BYTES}
              spellCheck={false}
              placeholder={'Jeden SN w wierszu, np.\nDEMO000001\nDEMO000002'}
              required
            />
          </label>
          <p className="field-help">
            Do {MAX_BATCH_SIZE} unikalnych SN. Separatory: nowa linia, spacja, tabulator, przecinek
            lub średnik. Plik z jedną kolumną SN; opcjonalny nagłówek SN / SERIAL / SERIAL_NUMBER.
            Import zastępuje zawartość pola.
          </p>
          <div className="batch-import-summary" aria-live="polite">
            <strong>{parsed.serials.length} poprawnych SN</strong>
            <span>{parsed.duplicates} duplikatów pominiętych</span>
            <span>{parsed.invalid.length} niepoprawnych wpisów</span>
          </div>
          {parsed.invalid.length > 0 && (
            <>
              <div className="error">
                Niepoprawne wpisy: {parsed.invalid.slice(0, 10).join(', ')}
                {parsed.invalid.length > 10 ? '…' : ''}. Wymagane 8–12 liter lub cyfr; IMEI nie jest
                obsługiwany.
              </div>
              <label className="batch-checkbox">
                <input
                  type="checkbox"
                  checked={ignoreInvalid}
                  onChange={(e) => setIgnoreInvalid(e.target.checked)}
                />
                Pomiń niepoprawne wpisy i dodaj wyłącznie poprawne SN
              </label>
            </>
          )}
          {parsed.serials.length > MAX_BATCH_SIZE && (
            <div className="error">
              Podziel numery na mniejsze paczki — limit to {MAX_BATCH_SIZE} SN.
            </div>
          )}
          <label className="batch-checkbox">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            Utwórz wstrzymaną paczkę — uruchomię ją później
          </label>
          <p className="field-help">
            Aktywne sprawdzenie tego samego SN jest współdzielone. Wcześniej zakończone SN będą
            sprawdzane ponownie. Nowe sprawdzenia mogą zużywać saldo solvera. Proxy wybieramy ze
            Stanu systemu raz na sprawdzenie, a solver przy starcie każdej próby.
          </p>
          <button
            className="primary"
            disabled={
              busy ||
              !parsed.serials.length ||
              parsed.serials.length > MAX_BATCH_SIZE ||
              (!!parsed.invalid.length && !ignoreInvalid)
            }
          >
            {busy
              ? 'Zapisywanie…'
              : paused
                ? 'Zapisz wstrzymaną paczkę'
                : `Utwórz i uruchom (${parsed.serials.length} SN)`}
          </button>
        </form>
      )}
      {!id && (
        <section className="history-card">
          <div className="history-heading">
            <h2>
              Twoje paczki <span className="count-pill">{list.total}</span>
            </h2>
          </div>
          <div className="table-toolbar">
            <input
              aria-label="Szukaj paczki"
              placeholder="Szukaj po nazwie…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value.slice(0, 120));
                setPage(1);
              }}
            />
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nazwa / utworzono</th>
                  <th>Status i postęp</th>
                  <th>Wyniki</th>
                  <th>Otwórz</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <strong>{b.name}</strong>
                      <span className="stage-caption">{date(b.createdAt)}</span>
                    </td>
                    <td>
                      <span>{batchStatus(b)}</span>
                      <Progress batch={b} />
                    </td>
                    <td>
                      {b.completed} udanych · {b.failed} błędów
                      <span className="stage-caption">
                        {b.waiting} oczekujących · {b.queued + b.running} w kolejce / pracy
                      </span>
                    </td>
                    <td>
                      <button
                        className="secondary"
                        onClick={() => open(b.id)}
                        aria-label={`Otwórz paczkę ${b.name}`}
                      >
                        Otwórz
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.items.length && (
            <div className="empty-state">
              <FolderPlus />
              <strong>{loaded ? 'Brak paczek' : 'Wczytywanie…'}</strong>
              <p>Dodaj pierwszą paczkę lub zmień wyszukiwanie.</p>
            </div>
          )}
          <Pager page={page} total={list.total} size={25} change={setPage} />
        </section>
      )}
      {id && !batch && !connectionError && <div className="batch-card">Wczytywanie paczki…</div>}
      {batch && detail && (
        <>
          <section className="batch-card">
            <div className="batch-heading">
              <div>
                <span className="eyebrow">PACZKA · {date(batch.createdAt)}</span>
                <h2>{batch.name}</h2>
                <p>{batch.notes}</p>
              </div>
              <span className="badge processing">{batchStatus(batch)}</span>
            </div>
            <Progress batch={batch} />
            <div className="batch-stats">
              {(
                [
                  ['Udane', batch.completed],
                  ['Błędy', batch.failed],
                  ['Oczekujące', batch.waiting],
                  ['W kolejce', batch.queued],
                  ['W trakcie', batch.running],
                  ['Anulowane', batch.cancelled],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <p className="field-help">
              Średni czas udanego sprawdzenia (ostatnia próba, bez kolejki):{' '}
              {duration(batch.averageMs)}. Przy imporcie pominięto: {batch.duplicates} duplikatów i{' '}
              {batch.invalid} niepoprawnych wpisów.
            </p>
            {batch.sourceId && (
              <button className="text-button" onClick={() => open(batch.sourceId)}>
                Otwórz paczkę źródłową
              </button>
            )}
            <div className="batch-actions">
              {batch.state !== 'cancelled' && batch.waiting > 0 && (
                <>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        update({ state: batch.state === 'paused' ? 'active' : 'paused' }),
                      )
                    }
                  >
                    {batch.state === 'paused' ? <Play size={16} /> : <Pause size={16} />}{' '}
                    {batch.state === 'paused' ? 'Wznów paczkę' : 'Wstrzymaj paczkę'}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Anulować ${batch.waiting} pozycji niewysłanych do kolejki? Dotychczasowe wyniki zostaną zachowane.`,
                        )
                      )
                        void action(() => update({ state: 'cancelled' }));
                    }}
                  >
                    <X size={16} />
                    Anuluj oczekujące
                  </button>
                </>
              )}
              <button
                className="secondary"
                disabled={busy || !batch.failed}
                onClick={() => void action(() => create(true))}
              >
                <RotateCcw size={16} />
                Ponów błędy w nowej paczce ({batch.failed})
              </button>
              <button className="secondary" disabled={busy} onClick={() => void action(download)}>
                <Download size={16} />
                Eksport CSV{filter || search ? ' (filtr)' : ''}
              </button>
            </div>
            <p className="field-help">
              Wstrzymanie i anulowanie dotyczą pozycji oczekujących na dodanie do kolejki. Już
              zakolejkowane i trwające sprawdzenia dokończą pracę. Ponowienie tworzy nową paczkę z
              aktualnie nieudanymi SN.
            </p>
            <details
              onToggle={(e) => {
                if (e.currentTarget.open) {
                  setEditName(batch.name);
                  setEditNotes(batch.notes);
                }
              }}
            >
              <summary>Zmień nazwę lub notatkę</summary>
              <form
                className="batch-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(() => update({ name: editName, notes: editNotes }));
                }}
              >
                <label>
                  Nowa nazwa
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={120}
                    required
                  />
                </label>
                <label>
                  Notatka
                  <input
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    maxLength={2000}
                  />
                </label>
                <button className="secondary" disabled={busy}>
                  Zapisz opis
                </button>
              </form>
            </details>
          </section>
          <section className="history-card">
            <div className="table-toolbar">
              <input
                aria-label="Szukaj SN w paczce"
                placeholder="Szukaj SN…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 12));
                  setPage(1);
                }}
              />
              <select
                aria-label="Status pozycji paczki"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Wszystkie statusy</option>
                {Object.entries(itemStatus).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th># / SN</th>
                    <th>Status / urządzenie</th>
                    <th>Czas / integracje</th>
                    <th>Szczegóły</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((i) => {
                    const r = i.check?.runs?.at(-1);
                    return (
                      <tr key={i.position}>
                        <td>
                          <small>{i.position}.</small> <code>{i.serial}</code>
                        </td>
                        <td>
                          <span
                            className={`badge ${i.status === 'failed' ? 'failure' : i.status === 'completed' ? 'active' : 'pending'}`}
                          >
                            {itemStatus[i.status]}
                          </span>
                          <span className="stage-caption">
                            {i.check?.result?.model}
                            {i.check?.result?.coverageLabel
                              ? ' · ' + i.check.result.coverageLabel
                              : ''}
                          </span>
                          {i.check?.errorMessage && (
                            <span className="batch-error-caption">{i.check.errorMessage}</span>
                          )}
                        </td>
                        <td>
                          {duration(r?.durationMs)}
                          <span className="stage-caption">
                            {r ? `${r.proxy} · ${r.solver}` : '—'}
                          </span>
                          <span className="stage-caption">CAPTCHA: {duration(r?.captchaMs)}</span>
                        </td>
                        <td>
                          {i.check && (
                            <button
                              className="text-button"
                              onClick={() => onCheck(i.check!)}
                              aria-label={`Szczegóły ${i.serial}`}
                            >
                              Szczegóły
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!detail.items.length && (
              <div className="empty-state">Brak pozycji pasujących do filtra.</div>
            )}
            <Pager page={page} total={detail.total} size={50} change={setPage} />
          </section>
        </>
      )}
    </div>
  );
}
function Pager({
  page,
  total,
  size,
  change,
}: {
  page: number;
  total: number;
  size: number;
  change: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="table-footer">
      <span>{total} pozycji</span>
      <div className="pagination">
        <button className="secondary" disabled={page <= 1} onClick={() => change(page - 1)}>
          Poprzednia
        </button>
        <span>
          {page} / {pages}
        </span>
        <button className="secondary" disabled={page >= pages} onClick={() => change(page + 1)}>
          Następna
        </button>
      </div>
    </div>
  );
}
