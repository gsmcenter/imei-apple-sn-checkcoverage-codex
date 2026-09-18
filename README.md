# Coverage Desk

Prywatny panel do sprawdzania gwarancji urządzeń Apple po **numerze seryjnym**, z historią bez automatycznego usuwania. Repozytorium: [gsmcenter/imei-apple-sn-checkcoverage-codex](https://github.com/gsmcenter/imei-apple-sn-checkcoverage-codex).

## Co zawiera

- React + TypeScript: logowanie hasłem, formularz SN, aktualizowany status, historia z wyszukiwaniem, filtrowaniem i paginacją oraz szczegóły odpowiedzi.
- Fastify: prywatne endpointy `/api/v1`, sesje HttpOnly, sprawdzanie Origin, limity logowania zapisane w bazie.
- PostgreSQL: trwała historia i kolejka, atomowe pobieranie zadań, globalna kontrola równoległości, dzienne limity i ochrona przed duplikatami.
- Playwright/Chromium: obsługa strony Apple w osobnej sesji przez ProxyMesh. Brak automatycznego przełączenia na połączenie bez proxy.
- 2Captcha API v2: `ImageToTextTask`, odpytywanie wyniku co 5 sekund, maksymalnie dwie próby CAPTCHA w jednym wykonaniu, zgłaszanie błędnych odpowiedzi.
- Docker, konfiguracja Railway i GitHub Actions z PostgreSQL oraz budową obrazu Docker.

**Stan integracji:** selektory formularza i format obrazka CAPTCHA zweryfikowano na aktualnej stronie Apple. Parser i obsługa 2Captcha są objęte testami z kontrolowanymi odpowiedziami. Pełny test Apple → ProxyMesh → 2Captcha wymaga prawdziwych poświadczeń i numeru seryjnego właściciela. Do czasu tego testu integrację traktuj jako nieweryfikowaną end-to-end. Zmiana strony Apple może wymagać aktualizacji adaptera. Aplikacja nie zakłada, że każde urządzenie ujawni datę zakupu lub końca ochrony.

## Szybki podgląd bez kont zewnętrznych

Wymagany Node.js 22.14+ (na Railway używany Node 24).

```bash
npm ci
npm run build
npm run preview:demo
```

Otwórz `http://localhost:3000`. Hasło demonstracyjne: `demo-coverage-2026`.

**Demo jest wyraźnie oznaczone, korzysta z przykładowych danych w pamięci i nie kontaktuje się z Apple ani płatnymi usługami.** Dane demo znikają przy restarcie. Skrypt demo nie trafia do obrazu produkcyjnego.

## Uruchomienie rzeczywistej integracji lokalnie

1. Skopiuj `.env.example` do `.env`.
2. Uruchom `npm run password`; wpisz własne hasło minimum 12 znaków. Wklej wygenerowane `ADMIN_PASSWORD_HASH` i `SESSION_SECRET` do `.env`.
3. Wpisz `TWOCAPTCHA_API_KEY`, `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD`. Endpoint musi być aktywny na Twoim koncie ProxyMesh. Nie wpisuj kluczy do plików śledzonych przez Git.
4. Uruchom `docker compose up --build` i otwórz `http://localhost:3000`.

Alternatywnie: `docker compose up -d postgres`, następnie `npm run build` i `npm run dev`. Do edycji interfejsu uruchom osobno `npm run dev:ui`, ustaw `APP_ORIGIN=http://localhost:5173` i korzystaj wyłącznie z tego adresu.

Na Windows, jeśli systemowy `npm.ps1` jest uszkodzony, użyj `& 'C:\Program Files\nodejs\npm.cmd' run build` (analogicznie dla pozostałych poleceń).

## Railway

Instrukcja: [docs/RAILWAY.md](docs/RAILWAY.md). Docelowo jeden projekt z usługami `web`, `worker` i `Postgres`. `web` oraz `worker` budują ten sam obraz z GitHuba; `APP_ROLE` wybiera rolę. Domena publiczna jest potrzebna tylko usłudze `web`.

## Kolejka i kontrola kosztów

Domyślnie: 2 równoległe sprawdzenia globalnie, co najmniej 3 sekundy pomiędzy startami, 1500 nowych sprawdzeń dziennie, 3000 wysyłek CAPTCHA dziennie i 200 zadań oczekujących/trwających. Wszystkie wartości są konfigurowalne. Dobierz je do swojego konta i realnych czasów odpowiedzi; nie są gwarancją przepustowości strony Apple. Dzienne okna resetują się o 00:00 UTC.

Ponowione żądanie z tym samym `Idempotency-Key` nie tworzy nowego zadania. Równoczesne żądania dla tego samego SN zwracają już aktywne sprawdzenie. Ponowne sprawdzenie zakończonego SN tworzy nowy wpis i wykonuje świeży odczyt.

Worker przedłuża dzierżawę zadania co 15 sekund. Po 60 sekundach bez przedłużenia zadanie może zostać wznowione. Token dzierżawy nie pozwala staremu workerowi nadpisać wyniku nowego. Maksymalnie dwa wykonania po awarii procesu; błędy Apple/proxy/2Captcha nie są automatycznie ponawiane. Jedno wykonanie może wysłać do dwóch CAPTCHA, więc awaria w trakcie zadania może spowodować łącznie do czterech płatnych zgłoszeń. Limit CAPTCHA liczy także niepewne lub odrzucone wysyłki, aby konserwatywnie ograniczać koszty. Nie gwarantuje rozliczenia dokładnie raz w zewnętrznym serwisie.

## Bezpieczeństwo i dane

Hasło jest przechowywane jako scrypt; tokeny sesji jako HMAC z sekretem serwera. Sesja wygasa po 12 godzinach. W produkcji cookie ma `Secure`, `HttpOnly` i `SameSite=Strict`. Zmiana `SESSION_SECRET` unieważnia wszystkie sesje. Po zmianie hasła zmień też sekret sesji. `APP_ORIGIN` musi odpowiadać dokładnej domenie panelu i używać HTTPS w produkcji.

Historia SN oraz odpowiedzi Apple pozostaje w PostgreSQL. Nie zawiera kluczy API, hasła proxy ani obrazków CAPTCHA. Do 2Captcha trafia obrazek kodu; numer seryjny jest wpisywany wyłącznie na stronie Apple. Logi aplikacji zawierają ID zadania i kod błędu, bez SN, body żądań ani poświadczeń. Dostęp do bazy i backupów zapewnia konto Railway; ustaw backupy przed produkcyjnym użyciem. Aplikacja nie zastępuje kopii zapasowej. Proxy ukrywa źródłowe IP w połączeniu z Apple, lecz nie zapewnia pełnej anonimowości wobec operatorów usług.

## Rozbudowa o API i IMEI

Obecne `/api/v1/checks` i `/api/v1/checks/:id` obsługują panel, wymagają sesji i ochrony Origin. Nie są jeszcze publicznym API z kluczem dostępu. Warstwa zadań i adapter Apple są odseparowane od HTTP, więc kolejny etap może dodać tokeny API, uprawnienia i osobne limity bez przepisywania integracji. [docs/API.md](docs/API.md) opisuje obecny kontrakt.

IMEI jest celowo odrzucane — pierwsza wersja obsługuje SN zgodnie z ustaleniami. Nie wykonuje nieudokumentowanej konwersji IMEI → SN.

## Weryfikacja

```bash
npm run typecheck
npm test
npm run build
```

Bez `TEST_DATABASE_URL` testy używają PGlite. Test rzeczywistej współbieżności jest wtedy pomijany. GitHub Actions uruchamia wszystkie testy na PostgreSQL 17. `TEST_DATABASE_URL` musi wskazywać **oddzielną, pustą bazę testową**, bo testy czyszczą jej tabele. Testy nie używają płatnych serwisów. Lokalny podgląd nie potwierdza działania Docker/Railway ani dostawców.

## Źródła integracji

- [Apple Check Coverage](https://checkcoverage.apple.com/?locale=en_US)
- [2Captcha — ImageToTextTask](https://2captcha.com/api-docs/normal-captcha)
- [2Captcha — SDK JavaScript](https://github.com/2captcha/2captcha-javascript) (implementacja używa bezpośrednio API v2)
- [ProxyMesh — HTTPS i sticky IP](https://docs.proxymesh.com/article/145-proxy-server-requests-over-https)
- [Playwright — konfiguracja proxy](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-proxy)
- [Railway — Dockerfile](https://docs.railway.com/builds/dockerfiles)
