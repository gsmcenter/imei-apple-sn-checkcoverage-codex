# Wdrożenie z GitHuba na Railway

Repozytorium: `gsmcenter/imei-apple-sn-checkcoverage-codex`, gałąź `main`.

## 1. Utwórz projekt i bazę

W Railway wybierz **New Project → Empty Project** i nazwij projekt `imei-apple-sn-checkcoverage`. Dodaj bazę PostgreSQL z trwałym wolumenem. Włącz backupy bazy. Nazwa `Postgres` poniżej musi odpowiadać faktycznej nazwie usługi.

## 2. Dodaj usługi z repozytorium

Dodaj usługę `web` przez **GitHub Repo**, wybierając repozytorium powyżej. Dodaj drugą usługę z tego samego repozytorium i nazwij ją `worker`. W obu pozostaw katalog główny `/` i plik konfiguracji `railway.json`; Dockerfile zostanie wykryty automatycznie. Ustaw wdrażanie z `main`. Wyłącz usypianie (Serverless) dla workera. Zacznij od jednej repliki każdej usługi.

Dla `web` wygeneruj domenę w **Settings → Networking → Generate Domain**. Dla `worker` nie generuj publicznej domeny. Baza jest osiągalna po prywatnej sieci Railway. Healthcheck obu usług to `/healthz`.

## 3. Ustaw zmienne

Uruchom lokalnie `npm run password` i przygotuj hash hasła oraz sekret sesji. Wprowadź je w **Variables** na Railway. Nie umieszczaj sekretów w GitHubie, Dockerfile, kodzie frontendu ani zgłoszeniach.

W obu usługach:

| Zmienna                 | Wartość                                            |
| ----------------------- | -------------------------------------------------- |
| `NODE_ENV`              | `production`                                       |
| `DATABASE_URL`          | `${{Postgres.DATABASE_URL}}`                       |
| `APP_ORIGIN`            | Dokładny adres HTTPS usługi web, bez końcowego `/` |
| `ADMIN_PASSWORD_HASH`   | Wygenerowane `scrypt:...`                          |
| `SESSION_SECRET`        | Wygenerowany losowy sekret, minimum 32 znaki       |
| `TWOCAPTCHA_API_KEY`    | Klucz z konta 2Captcha                             |
| `PROXY_SERVER`          | `http://AKTYWNY_HOST.proxymesh.com:31280`          |
| `PROXY_USERNAME`        | Login konta ProxyMesh                              |
| `PROXY_PASSWORD`        | Hasło konta ProxyMesh                              |
| `WORKER_CONCURRENCY`    | `2`                                                |
| `MAX_CHECKS_PER_DAY`    | `1500`, dostosuj do budżetu                        |
| `MAX_CAPTCHAS_PER_DAY`  | `3000`, dostosuj do budżetu                        |
| `MAX_PENDING_CHECKS`    | `200`                                              |
| `MIN_CHECK_INTERVAL_MS` | `3000`                                             |
| `CHECK_TIMEOUT_MS`      | `240000`                                           |
| `CAPTCHA_TIMEOUT_MS`    | `90000`                                            |

Dodatkowo `APP_ROLE=web` w web i `APP_ROLE=worker` w worker. `PORT` dostarcza Railway — aplikacja go odczytuje. Pozostaw `TRUST_PROXY=false`, chyba że świadomie konfigurujesz zaufanie do nagłówków reverse proxy. Przy pojedynczym administratorze wspólny limit IP nie przeszkadza.

Web potrzebuje obecnie flag konfiguracyjnych dostawców z tych samych zmiennych; nie wykonuje płatnych zadań. Usługa worker używa sekretów do połączeń. Przy dalszej rozbudowie można rozdzielić konfigurację gotowości web od sekretów workera.

## 4. Zasoby i pierwszy test

Na start orientacyjnie zarezerwuj web 512 MB RAM i worker 2 GB RAM przy dwóch przeglądarkach; sprawdź rzeczywiste użycie i czasy. Są to ustawienia początkowe, nie gwarancja wydajności. Zasoby i opłaty wybierz w ramach swojego planu Railway.

Wdróż obie usługi. Migracja tworzy tabele automatycznie; blokada w PostgreSQL zapobiega równoczesnemu wykonywaniu migracji. Po restarcie worker odtworzy niedokończone zadania z ograniczoną liczbą prób.

1. Zaloguj się do panelu. Sprawdź, że nie widać banera demo.
2. Sprawdź obecność konfiguracji 2Captcha i ProxyMesh oraz heartbeat workera. „Ustawiono” nie potwierdza poprawności klucza ani salda.
3. Wprowadź SN własnego urządzenia. Jedno wykonanie może zużyć do dwóch zadań CAPTCHA.
4. Porównaj wynik ze stroną Apple: model, numer, stan ochrony, pokazane daty i pełny tekst odpowiedzi.
5. Odśwież panel i zaloguj się ponownie — wynik powinien pozostać w historii.
6. Jeśli pojawi się `PAGE_CHANGED`, zapisz widoczny komunikat i dostosuj adapter/fixtures do rzeczywistego wyniku. Nie traktuj odpowiedzi o błędzie jako braku gwarancji.

## Rozwiązywanie problemów

- **Worker nie startuje:** brak danych 2Captcha lub ProxyMesh, niepoprawny hash hasła, błędna baza lub niepoprawny `APP_ORIGIN`.
- **403 przy logowaniu:** adres w przeglądarce różni się od `APP_ORIGIN`; sprawdź HTTPS i domenę.
- **PROXY_ERROR:** serwer nie jest aktywny w koncie, błędne poświadczenia lub proxy nie działa. Nie ma fallbacku do bezpośredniego połączenia.
- **CAPTCHA_SERVICE:** sprawdź saldo, klucz oraz ewentualną listę dozwolonych IP w koncie 2Captcha.
- **APPLE_BLOCKED / APPLE_UNAVAILABLE:** sprawdź bieżącą dostępność Apple i proxy; nie zwiększaj automatycznie równoległości.
- **CAPTCHA_LIMIT / DAILY_LIMIT:** zwiększ limit świadomie albo poczekaj na nowe okno UTC.
- **PAGE_CHANGED:** wynik lub formularz Apple odbiega od rozpoznawanej struktury. Potrzebna aktualizacja `src/server/integrations/`.

## Aktualizacje i odzyskiwanie

Przed produkcyjnymi zmianami bazy wykonuj backup. GitHub Actions weryfikuje kod i buduje obraz; można włączyć na Railway oczekiwanie na CI przed wdrożeniem. Wycofanie wdrożenia aplikacji nie jest cofnięciem zmian w danych. Nie usuwaj usługi PostgreSQL ani jej wolumenu podczas aktualizacji.

Dokumentacja: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles), [PostgreSQL](https://docs.railway.com/databases/postgresql), [Config as Code](https://docs.railway.com/config-as-code/reference).
