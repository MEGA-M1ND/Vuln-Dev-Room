import type { ApiErrorCode } from "@/lib/api/errors";

/**
 * Client-side fetch wrapper that understands the API error envelope and throws
 * a typed ApiClientError. Keeps components free of response-parsing boilerplate.
 */
export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode | "UNKNOWN",
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code: ApiErrorCode | "UNKNOWN" = "UNKNOWN";
    let message = `Request failed (${res.status})`;
    let details: Record<string, unknown> = {};
    try {
      const data = (await res.json()) as {
        error?: { code?: ApiErrorCode; message?: string; details?: Record<string, unknown> };
      };
      if (data.error) {
        code = data.error.code ?? "UNKNOWN";
        message = data.error.message ?? message;
        details = data.error.details ?? {};
      }
    } catch {
      // non-JSON error body; keep defaults
    }
    throw new ApiClientError(code, message, res.status, details);
  }

  return (await res.json()) as T;
}
