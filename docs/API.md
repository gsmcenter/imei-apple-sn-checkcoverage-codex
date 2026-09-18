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
