export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login')
      window.dispatchEvent(new Event('session-expired'));
    throw new HttpError(body.error || 'Nie udało się wykonać żądania.', response.status);
  }
  return body;
}
export const post = <T>(path: string, body: unknown, headers?: HeadersInit) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
