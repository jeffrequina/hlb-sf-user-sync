import { ZodError } from "zod";
import { AxiosError } from "axios";

export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, details);
    this.name = "ValidationError";
  }
}

export class AuthError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
    this.name = "AuthError";
  }
}

export class HivebriteError extends AppError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(message, statusCode, details);
    this.name = "HivebriteError";
  }
}

/**
 * Normalise any thrown value into a structured error object for HTTP responses.
 */
export function normaliseError(err: unknown): {
  statusCode: number;
  message: string;
  details?: unknown;
} {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, message: err.message, details: err.details };
  }

  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      message: "Validation failed",
      details: err.flatten().fieldErrors,
    };
  }

  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 502;
    return {
      statusCode: status >= 500 ? 502 : status,
      message: `Upstream API error: ${err.message}`,
      details: err.response?.data,
    };
  }

  if (err instanceof Error) {
    return { statusCode: 500, message: err.message };
  }

  return { statusCode: 500, message: "An unexpected error occurred" };
}
