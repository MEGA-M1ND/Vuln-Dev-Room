import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * Consistent API error envelope, per the Stage 1 contract:
 *
 *   { "error": { "code", "message", "details" } }
 *
 * Never leak raw DB errors or secrets to the client — unexpected errors are
 * logged server-side and returned as a generic 500.
 */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TICKET_VERSION_CONFLICT"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TICKET_VERSION_CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    { error: { code, message, details } },
    { status: STATUS_BY_CODE[code] },
  );
}

/**
 * Convert any thrown value into a safe NextResponse. Known ApiErrors and Zod
 * errors are surfaced with useful detail; everything else becomes a generic
 * 500 with the real error logged for operators only.
 */
export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return errorResponse(error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    return errorResponse("VALIDATION_ERROR", "Invalid request.", {
      issues: error.flatten(),
    });
  }
  // Unexpected — log full detail server-side, return opaque message.
  console.error("[api] Unhandled error:", error);
  return errorResponse("INTERNAL_ERROR", "An unexpected error occurred.");
}
