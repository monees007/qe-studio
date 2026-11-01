// Thin, typed HTTP client for the QE Studio backend.

function readToken(): string {
  const meta = document.querySelector('meta[name="qes-token"]') as HTMLMetaElement | null;
  const t = meta?.content ?? '';
  return t && t !== '__QES_TOKEN__' ? t : ((import.meta.env.VITE_QES_TOKEN as string | undefined) ?? '');
}

export const TOKEN = readToken();

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set('X-QES-Token', TOKEN);
  return h;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let detail: unknown;
    try {
      const j = await res.json();
      detail = j;
      if (typeof j?.detail === 'string') msg = j.detail;
      else if (j?.detail) msg = JSON.stringify(j.detail);
    } catch {
      /* not json */
    }
    if (res.status === 401)
      msg = 'API token rejected — reload the page (the backend may have been restarted with a new data directory).';
    throw new ApiError(res.status, msg, detail);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return handle<T>(await fetch(path, { headers: headers(), signal }));
}

export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    signal,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handle<T>(await fetch(path, init));
}

export const apiPost = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  apiSend<T>('POST', path, body ?? {}, signal);
export const apiPut = <T>(path: string, body?: unknown) => apiSend<T>('PUT', path, body ?? {});
export const apiDelete = <T>(path: string) => apiSend<T>('DELETE', path);

export async function apiUpload<T>(path: string, form: FormData, onProgress?: (f: number) => void): Promise<T> {
  // XHR for upload progress
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('X-QES-Token', TOKEN);
    xhr.responseType = 'text';
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = xhr.responseText;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* text */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else
        reject(
          new ApiError(
            xhr.status,
            typeof body?.detail === 'string' ? body.detail : `${xhr.status} upload failed`,
            body,
          ),
        );
    };
    xhr.onerror = () => reject(new ApiError(0, 'network error during upload'));
    xhr.send(form);
  });
}

export async function apiDownload(path: string, body?: unknown, fallbackName = 'download'): Promise<void> {
  const res = await fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await handle(res);
  const blob = await res.blob();
  let name = res.headers.get('X-Filename') ?? fallbackName;
  const cd = res.headers.get('Content-Disposition');
  const m = cd?.match(/filename="?([^"]+)"?/);
  if (m) name = m[1];
  saveBlob(blob, name);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function saveText(text: string, name: string): void {
  saveBlob(new Blob([text], { type: 'text/plain' }), name);
}

/**
 * Open a WebSocket to the backend. The API token is sent as a WebSocket subprotocol
 * ("token.<value>") rather than in the URL, so it never appears in access logs.
 */
export function openSocket(path: string): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${location.host}${path}`, ['qes', `token.${TOKEN}`]);
}

/** POST returning a Server-Sent-Events stream; calls onEvent for each JSON event. */
export async function apiStream(
  path: string,
  body: unknown,
  onEvent: (ev: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await handle(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
