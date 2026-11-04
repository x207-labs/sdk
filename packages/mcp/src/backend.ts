// A GET against the x207 read API. Only GET exists here: the read tools cannot change anything at the backend.
export type BackendGet = (path: string, query?: Record<string, string | number | boolean | undefined>) => Promise<unknown>;

export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BackendError";
  }
}

/** `path` is relative to `/x207/circles/{circle}` and made of fixed words and `seg(...)` parts. */
export function createBackendGet(options: { baseUrl: string; circleId: string; timeoutMs: number; fetch?: typeof fetch }): BackendGet {
  const fetchFn = options.fetch ?? fetch;
  return async (path, query = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${options.baseUrl}/x207/circles/${encodeURIComponent(options.circleId)}${path}${qs.size > 0 ? `?${qs}` : ""}`;
    let response: Response;
    try {
      response = await fetchFn(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      throw new BackendError(0, `read API unreachable (${path.split("?")[0]}): ${(error as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.replace(/\s+/g, " ").slice(0, 200);
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } | string; message?: string };
        const e = typeof body.error === "object" ? body.error : undefined;
        detail = [e?.code ?? (typeof body.error === "string" ? body.error : undefined), e?.message ?? body.message].filter(Boolean).join(": ") || detail;
      } catch {
        // not JSON: the cut text stays
      }
      throw new BackendError(response.status, `read API ${path.split("?")[0]} answered ${response.status}: ${detail}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BackendError(response.status, `read API ${path.split("?")[0]} did not answer JSON`);
    }
  };
}

/** One path segment, encoded. */
export const seg = (value: string | number): string => encodeURIComponent(String(value));

/** A POST with a JSON body against the read API / marketplace book. Used only by the write tools (SD-082), which sign the body first. */
export type BackendPost = (path: string, body: unknown) => Promise<unknown>;

export function createBackendPost(options: { baseUrl: string; circleId: string; timeoutMs: number; fetch?: typeof fetch }): BackendPost {
  const fetchFn = options.fetch ?? fetch;
  return async (path, body) => {
    const url = `${options.baseUrl}/x207/circles/${encodeURIComponent(options.circleId)}${path}`;
    let response: Response;
    try {
      response = await fetchFn(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      throw new BackendError(0, `read API unreachable (POST ${path}): ${(error as Error).message}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (!response.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new BackendError(response.status, `POST ${path} answered ${response.status}: ${[e?.code, e?.message].filter(Boolean).join(": ") || text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    return parsed;
  };
}
