export const errors = {
  APPLE_RATE_LIMITED:
    'Apple wyświetliło planszę ograniczenia dostępu. Wyczerpano ponowienia z nowymi sesjami proxy.',
  PROXY_REMOVED:
    'Proxy przypisane do tego sprawdzenia nie jest już skonfigurowane. Przywróć konfigurację lub utwórz nowe sprawdzenie.',
  PROXY_AUTH:
    'Proxy odrzuciło uwierzytelnienie (407). Testuj proxy w Stanie systemu: możliwa literówka, reset klucza, nieaktywny plan, brak transferu lub niedozwolone IP.',
  INVALID_SERIAL:
    'Podaj prawidłowy numer seryjny: 8–12 liter lub cyfr. IMEI nie jest obsługiwany w tej wersji.',
  SERIAL_NOT_FOUND: 'Apple nie rozpoznało numeru seryjnego. Sprawdź numer i spróbuj ponownie.',
  NOT_ACTIVATED:
    'Według Apple urządzenie nie zostało aktywowane. Informacje o gwarancji nie są jeszcze dostępne.',
  PURCHASE_DATE:
    'Apple wymaga potwierdzenia daty zakupu. Szczegóły sprawdź bezpośrednio na stronie Apple.',
  APPLE_UNAVAILABLE: 'Apple nie udostępnia teraz informacji. Spróbuj ponownie później.',
  APPLE_BLOCKED: 'Apple odrzuciło połączenie. Sprawdź dostępność proxy przed kolejną próbą.',
  PAGE_CHANGED:
    'Nie udało się rozpoznać formularza lub wyniku Apple. Integracja wymaga sprawdzenia.',
  CAPTCHA_FAILED: 'Nie udało się rozwiązać CAPTCHA w dozwolonej liczbie prób.',
  CAPTCHA_SERVICE:
    'Solver CAPTCHA odrzucił zadanie lub jest niedostępny. Sprawdź dziennik, klucz API i stan konta.',
  CAPTCHA_TIMEOUT: 'Upłynął czas oczekiwania na rozwiązanie CAPTCHA.',
  PROXY_ERROR: 'Nie udało się połączyć przez ProxyMesh. Sprawdź serwer i dane dostępowe.',
  CHECK_TIMEOUT: 'Sprawdzenie przekroczyło limit czasu. Możesz uruchomić nowe sprawdzenie.',
  DAILY_LIMIT:
    'Osiągnięto dzienny limit sprawdzeń (UTC). Zwiększ limit w konfiguracji lub wróć jutro.',
  CAPTCHA_LIMIT: 'Osiągnięto dzienny limit zadań CAPTCHA (UTC).',
  QUEUE_FULL: 'Kolejka jest pełna. Poczekaj, aż zakończą się bieżące sprawdzenia.',
  NOT_CONFIGURED: 'Uzupełnij konfigurację 2Captcha i ProxyMesh na serwerze.',
  WORKER_OFFLINE: 'Proces sprawdzający jest niedostępny. Sprawdź usługę worker na Railway.',
  WORKER_INTERRUPTED:
    'Sprawdzenie zostało przerwane przez restart serwera. Wyczerpano próby wznowienia.',
  INTERNAL_ERROR: 'Wystąpił błąd serwera. Spróbuj ponownie później.',
} as const;
export type ErrorCode = keyof typeof errors;
export function browserErrorCode(error: unknown, aborted = false): ErrorCode {
  if (aborted) return 'CHECK_TIMEOUT';
  if (error instanceof AppError) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (/407|ERR_INVALID_AUTH_CREDENTIALS|ERR_PROXY_AUTH/i.test(message)) return 'PROXY_AUTH';
  if (/PROXY|TUNNEL|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(message)) return 'PROXY_ERROR';
  if (/Timeout|TIMED_OUT/i.test(message)) return 'CHECK_TIMEOUT';
  return 'PAGE_CHANGED';
}
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status = 502,
  ) {
    super(errors[code]);
  }
}
export function normalizeSerial(input: unknown): string {
  if (typeof input !== 'string') throw new AppError('INVALID_SERIAL', 400);
  const serial = input.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(serial) || /^\d+$/.test(serial))
    throw new AppError('INVALID_SERIAL', 400);
  return serial;
}
