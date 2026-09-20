# ProxyMesh i Evomi

Dotychczasowe `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` pozostają obsługiwane. Opcjonalne `PROXY_URL=http://LOGIN:HASLO@HOST:PORT` zastępuje te trzy zmienne. `PROXY_HOSTS` wskazuje hosty korzystające ze wspólnych danych ProxyMesh; bez tej zmiennej zachowujemy FR/DE/open.

W Railway → Variables usługi WWW i workera (lub jednej usługi `APP_ROLE=all`) dodaj poniższe zmienne, uzupełnij LOGIN/HASLO, a następnie Deploy:

```dotenv
PROXY_HOSTS=fr.proxymesh.com:31280,de.proxymesh.com:31280
PROXY_EXTRA_URLS=evomi-de=http://LOGIN:HASLO_country-DE_session-{session}_lifetime-10@core-residential.evomi.com:1000,evomi-nl=http://LOGIN:HASLO_country-NL_session-{session}_lifetime-10@core-residential.evomi.com:1000,evomi-us=http://LOGIN:HASLO_country-US_session-{session}_lifetime-10@core-residential.evomi.com:1000
RATE_LIMIT_RETRIES=3
```

Sekrety przechowuj wyłącznie w Railway Variables lub ignorowanym `.env`. Znaki specjalne hasła koduj procentowo, np. `@` → `%40`, przecinek → `%2C`. Token `{session}` pozostaw dosłownie. Ciąg generatora `host:port:login:hasło` nie jest adresem URL. Nazwy wpisów muszą być unikalne, do 60 znaków, inne niż `random` i `direct`. Obsługujemy do 30 dodatkowych wpisów HTTP, oddzielanych przecinkiem lub białymi znakami. Bez nazwy etykietą jest host:port.

## Wybór i sesje

Panel pokazuje hosty ProxyMesh i etykiety dodatkowych proxy. „Losowo” losuje ze wszystkich wpisów przy co najmniej dwóch opcjach. Proxy wybieramy raz na całe sprawdzenie, także przy wznowieniu po awarii. Usunięta etykieta w ustawieniach wraca do domyślnej bez resetowania solvera. Zadanie już przypisane do usuniętego proxy kończy się czytelnym błędem, bez przypisania pomiarów innemu dostawcy.

Każda nowa sesja Apple zastępuje `{session}` świeżym identyfikatorem 8 znaków hex. W obrębie sesji dane proxy pozostają stałe. Nie używaj rotating bez sticky session — zmiana IP między żądaniami może przerwać formularz CAPTCHA. Możliwość przydzielenia nowego IP zależy od dostawcy.

## Testuj proxy

Przycisk w Stanie systemu wykonuje sam CONNECT do `checkcoverage.apple.com:443`, bez żądania HTTP do Apple i bez solvera. Testuje parametry z tokenem `diag0001` oraz samo hasło:

- 200: tunel działa; nie oznacza to jeszcze udanego sprawdzenia gwarancji.
- 407 z parametrami, 200 bez: dane poprawne, parametry odrzucone.
- Dwa 407: dostawca odrzuca dane/konto. Możliwe literówki, reset klucza, brak aktywnego planu/transferu albo autoryzacji IP. Treść odpowiedzi nie rozstrzyga przyczyny.
- Brak odpowiedzi: sprawdź host, port i sieć; sam timeout nie dowodzi błędnego hosta.

Panel pokazuje zamaskowany login, długości hasła, bezpieczną listę parametrów i ostrzeżenia. Nie zwraca URL ani hasła. Lokalny test dodatkowych proxy: `node --import tsx scripts/proxy-test.ts`; domyślnie czyta `.env`, opcjonalna ścieżka w `PROXY_TEST_ENV`.

Integracja używa natywnego proxy Chromium, nie konektora undici. Do Evomi nie wysyłamy `X-ProxyMesh-*`. Chromium nie udostępnia odpowiedzi CONNECT, więc IP w historii sesji jest nieznane. Test diagnostyczny potrafi odczytać `X-ProxyMesh-IP` od ProxyMesh. Brak IP od Evomi jest poprawny.

## Limity i statystyki

Sekcja **Równoległe sprawdzenia** pozwala ustawić globalny limit 1–8 zadań. Ustawienie zapisuje się w bazie i działa bez restartu także dla paczek oraz wielu workerów. Po zmniejszeniu limitu trwające zadania dokończą pracę; nowe poczekają na wolne miejsca. Odstęp między startami i limity dzienne nadal obowiązują. `WORKER_CONCURRENCY` wyznacza wartość początkową, dopóki nie zapiszesz limitu w panelu. Reset statystyk i zmiana proxy/solvera nie zmieniają limitu równoległości.

Przycisk **Resetuj statystyki** w Stanie systemu rozpoczyna nowy okres porównań proxy i solverów, średnich czasów oraz limitów Apple. Panel pokazuje datę początku okresu. Uwzględniane są tylko sprawdzenia zlecone po resecie; wcześniejsze zadania oczekujące lub trwające pozostają poza nowymi pomiarami także po zakończeniu. Historia, logi, wyniki, paczki i ich lokalne podsumowania pozostają dostępne. Reset nie odnawia salda ani dziennych limitów. Początek okresu jest zapisany w bazie i zachowuje się po wdrożeniu.

Planszę „We'll be back / We're busy updating our support tools” traktujemy jako sygnał limitu (`APPLE_RATE_LIMITED`). To heurystyka integracji, nie dowód przyczyny komunikatu Apple. Wykrywamy ją przy otwieraniu strony, CAPTCHA, wysyłaniu i wynikach. Domyślnie trzy dodatkowe sesje po limicie (`RATE_LIMIT_RETRIES=3`), niezależnie od ponowień CAPTCHA. Wcześniejsze zapisane limity są uwzględniane po wznowieniu workera. Nadal obowiązuje łączny `CHECK_TIMEOUT_MS`. Nie ma trybu bez proxy. Limit przed wysyłką CAPTCHA nie uruchamia płatnego zadania.

Tabela „Wydajność wg proxy” zawiera liczbę sprawdzeń, skuteczność, średnią i medianę czasu Apple, sesje, limity i błędy proxy. Czas Apple mierzymy od nawigacji do zakończenia sesji, odejmując oczekiwanie na solver. Obejmuje też formularz i oczekiwanie na DOM — nie jest czystym czasem sieciowym. Średnia/mediana dotyczą udanych sprawdzeń i sumują ich zmierzone sesje. Starsze wpisy bez pomiarów są pomijane.

Limity liczymy wg proxy, równoległości, odwiedzonych etapów i godziny UTC (ostatnie 168 godzin z danymi). Szczegóły sprawdzenia pokazują każdą sesję, etap, obciążenie kolejki i wynik. CSV zawiera czas Apple, liczbę sesji i limitów ostatniej próby. Nazwy proxy są jedyną identyfikacją dostawcy w bazie, wynikach i CSV.

Migracja tabeli `apple_sessions` i kolumny `selected_proxy` jest automatyczna, bez usuwania historii. Healthcheck: `/api/health` lub `/healthz`.

Źródła: [Evomi — sesje](https://docs.evomi.com/proxy-instructions/residential-proxies/proxy-sessions/), [Evomi — protokoły](https://docs.evomi.com/proxy-instructions/proxy-protocols/), [ProxyMesh — nagłówki](https://docs.proxymesh.com/article/7-request-response-headers).
