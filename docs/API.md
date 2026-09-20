# Kontrakt panelu, wersja 1

Endpointy są przeznaczone dla zalogowanego panelu. Wymagają cookie sesji; wszystkie metody POST dodatkowo wymagają nagłówka `Origin` zgodnego z `APP_ORIGIN`. Zewnętrzne API z tokenami jest kolejnym etapem. Sekrety usług nigdy nie są zwracane.

| Metoda | Ścieżka              | Zastosowanie                                                  |
| ------ | -------------------- | ------------------------------------------------------------- |
| GET    | `/healthz`           | Stan procesu i połączenia z bazą, bez danych urządzeń         |
| GET    | `/api/session`       | `{ authenticated, demo }`                                     |
| POST   | `/api/login`         | JSON `{ "password": "..." }`, tworzy sesję 12 h               |
| POST   | `/api/logout`        | Unieważnia bieżącą sesję                                      |
| GET    | `/api/v1/overview`   | Statystyki, limity, obecność konfiguracji i heartbeat         |
| POST   | `/api/v1/checks`     | JSON `{ "serial": "..." }`, wymagany `Idempotency-Key` (UUID) |
| GET    | `/api/v1/checks`     | `search`, `status`, `page`; 25 wpisów na stronę               |
| GET    | `/api/v1/checks/:id` | Stan i wynik jednego zadania                                  |

Nowe zlecenie zwraca **202** i `{ check, reused: false }`; deduplikowane **200** i `{ check, reused: true }`. Zapamiętaj UUID przed pierwszą wysyłką i użyj tego samego po utracie odpowiedzi. Ten sam klucz z innym SN daje 409. Nie używaj ponownie klucza do świadomie nowego sprawdzenia zakończonego urządzenia.

Statusy zadań: `queued`, `running`, `completed`, `failed`. Etapy: `queued`, `opening`, `solving`, `reading`, `done`. Pole `result` jest null do zakończenia. `errorCode` i `errorMessage` opisują błędy; błąd sprawdzenia nie jest statusem gwarancji.

```json
{
  "serial": "PRZYKLADOWY1",
  "model": "iPhone 16 Pro",
  "coverageStatus": "active",
  "coverageLabel": "Limited Warranty",
  "expirationDate": "September 18, 2027",
  "renewalDate": null,
  "purchaseDate": null,
  "details": ["..."],
  "rawText": "...",
  "checkedAt": "2026-09-18T12:00:00.000Z",
  "source": "apple",
  "sourceUrl": "https://checkcoverage.apple.com/?locale=en_US"
}
```

To przykład struktury, nie rzeczywisty wynik urządzenia. `coverageStatus` to `active`, `expired` albo `unknown`; rozpoznanie odbywa się po jawnych etykietach ochrony. Daty zachowują format pokazany przez Apple. `null` oznacza brak odczytanej informacji. `source=demo` jednoznacznie oznacza dane przykładowe.

HTTP 400 — błędne dane, 401 — brak sesji, 403 — niewłaściwy Origin, 404 — brak zadania, 409 — konflikt klucza, 429 — limit, 503 — brak konfiguracji/workera. Błędy wykonywania zadań są zapisywane w zadaniu, a endpoint stanu zwraca 200 wraz z `status=failed`.

Późniejsze API może dodać osobne tokeny i webhooki bez zmian w adapterze Apple. Nie należy w tym celu usuwać ochrony sesji ani Origin z endpointów panelu.

## Paczki SN

Wszystkie endpointy wymagają sesji; POST także poprawnego `Origin`. Utworzenie paczki i ponowienie błędów wymagają `Idempotency-Key` (UUID): identyczny request zwraca tę samą paczkę, zmieniony payload z tym kluczem daje 409. Odpowiedź: `{ id, reused }`, status 202 lub 200. Tworzenie / ponawianie: wspólny limit 10 żądań na minutę.

- `POST /api/v1/batches`: `{ name, notes?, text, ignoreInvalid?, paused? }`. Nazwa 1–120 znaków, notatka do 2000, tekst do 250000 znaków; limit body 500000 bajtów. Do 5000 unikalnych poprawnych SN. `ignoreInvalid=false`, `paused=false` domyślnie. Bez flagi pominięcia błędny import jest w całości odrzucany. Paczkę można zapisać również przy niedostępnym workerze.
- `GET /api/v1/batches?search=&page=1`: wyszukiwanie po nazwie, 25 paczek na stronę; `{ items, total, page, pageSize }`.
- `GET /api/v1/batches/:id?search=&status=&page=1`: `{ batch, items, total, page, pageSize }`; 50 pozycji na stronę. Pozycja: `{ position, serial, status, check }`, `check=null` przed zakolejkowaniem. Statusy: `waiting`, `queued`, `running`, `completed`, `failed`, `cancelled`. `search` to fragment SN.
- `POST /api/v1/batches/:id`: dowolne pola `{ name?, notes?, state? }`, stan `active`, `paused` lub `cancelled`. Wstrzymanie / anulowanie dotyczy tylko pozycji bez przypisanego sprawdzenia. Anulowania nie można cofnąć. Odpowiedź: zaktualizowany `Batch`.
- `POST /api/v1/batches/:id/retry`: `{ name, notes?, paused? }`; nowa paczka z nieudanych SN w chwili pierwszego żądania. Ponowienie tego samego klucza nie rozszerza listy o późniejsze błędy. Historia źródłowa pozostaje bez zmian.
- `GET /api/v1/batches/:id/export.csv?search=&status=`: wszystkie pasujące pozycje (do 5000), niezależnie od strony. UTF-8 BOM, średnik, wartości w cudzysłowach, formuły neutralizowane apostrofem.

`Batch` zawiera `id`, `name`, `notes`, `state`, `createdAt`, `sourceId`, `total`, `waiting`, `queued`, `running`, `completed`, `failed`, `cancelled`, `duplicates`, `invalid`, `averageMs`. Ostatnie pole to średni czas ostatniej próby udanych sprawdzeń bez kolejki. Zakończenie paczki wynika z zerowej sumy `waiting + queued + running`. `state` steruje przyjmowaniem do kolejki; nie jest statusem zakończenia. Pola `duplicates` i `invalid` to liczby pominiętych wpisów importu.

## System i diagnostyka

- `POST /api/v1/system/statistics/reset`: puste `{}`, wymaga sesji i Origin. Ustawia początek nowego okresu pomiarowego według zegara bazy; zwraca `{ statisticsSince }` w ISO UTC. Nie usuwa historii, logów, paczek ani limitów użycia. Statystyki obejmują wyłącznie sprawdzenia **zlecone** od tej chwili, zatem starsze zadania zakończone po resecie nie wpływają na nowy okres. `GET /api/v1/system` zwraca `statisticsSince` (`null` przed pierwszym resetem). Okres jest wspólny dla paneli i zachowuje się po restarcie/wdrożeniu.

- `GET /api/v1/system`: ustawienia proxy/solvera, statystyki prób wg proxy i wywołań wg solvera, kolejka, aktywne workery, limity i parametry procesu WWW.
- `GET /api/v1/system/balance`: `{ balance, currency: "USD", status, checkedAt }`. `status` to `ok`, `unavailable`, `not_configured` lub `demo`; brak odczytu daje `balance: null`. Cache do 60 s na proces.
- `POST /api/v1/system/settings`: `{ "proxyMode": "random", "solverId": "2captcha" }`. `proxyMode` dopuszcza etykiety z `proxyOptions` zwracanych przez `/api/v1/system`; `random` wymaga co najmniej dwóch wpisów. `solverId` dopuszcza `2captcha` i `captchaai`; inne wartości zwracają 400. Wybór solvera bez klucza API daje 503. Wymagana sesja i prawidłowy Origin.
- `GET /api/health`: publiczny alias `/healthz`.
- `POST /api/v1/proxies/test`: `{}` testuje wszystkie wpisy; `{ "label": "evomi-de" }` wybrany wpis. Wymaga sesji i Origin; limit 2 żądania/minutę, w demo niedostępne. Nie przyjmuje adresu URL. Wynik `{ testedAt, items }`; element zawiera `{ label, info, configured, bare, diagnosis }`. `info`: zamaskowany login, długości hasła, bezpieczna lista parametrów i ostrzeżenia. `configured`/`bare`: `ok`, `ms`, opcjonalne `status`, `reason`, `exitIp`.

System dodaje `proxyOptions: { label, provider }[]`, `proxyPerformance` (sprawdzenia, sukcesy, błędy, średnia/mediana Apple, sesje, limity, błędy proxy) i `limits: { dimension, name, sessions, limited }[]`. Wymiary: `proxy`, `concurrency`, `stage`, `hour` (UTC). Brak IP nie oznacza błędu.

`runs` dodaje opcjonalne `appleMs`, `sessions`, `rateLimits`. Szczegóły sprawdzenia dodają `proxySessions: { id, proxy, startedAt, finishedAt, appleMs, limited, stage, concurrency, queued, exitIp, outcome }[]`. Pomiar przerwanej sesji może być null. Proxy jest stałe przez całe sprawdzenie.

Każdy `Check` zawiera `runs`: osobne próby z rzeczywistym proxy i identyfikatorem solvera, statusami, czasami (ms) i liczbą wywołań CAPTCHA. `durationMs: null` oznacza próbę w toku, przerwaną albo brak pomiaru, a nie zero. `queueMs` to czas od zlecenia do startu danej próby, więc przy ponowieniu obejmuje też poprzednią próbę. `solver` oznacza przypisany adapter; `captchaCalls` informuje, czy faktycznie rozpoczęto wywołanie.

Szczegóły `GET /api/v1/checks/:id` zawierają dodatkowo `diagnostics`: `{ at, attempt, step, message }[]`. Lista historii nie przesyła logów. Starsze sprawdzenia mają puste tablice. Błąd workera lub zmiana ustawień nie przepisuje historycznego przypisania proxy/solvera.
