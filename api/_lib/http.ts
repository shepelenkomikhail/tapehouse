import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SessionUser } from "../../shared/types.js";
import { AuthError, authenticate } from "../../server/lib/telegram-auth.js";

/** `code` lets the client show a translated message; `message` is the English fallback. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function queryParam(request: VercelRequest, key: string) {
  const value = request.query[key];
  return Array.isArray(value) ? value[0] : value;
}

export function requireUser(request: VercelRequest): SessionUser {
  try {
    return authenticate(request.headers.authorization);
  } catch (error) {
    const expired = error instanceof AuthError && /expired/i.test(error.message);
    throw new HttpError(
      401,
      error instanceof AuthError ? error.message : "Unauthorized.",
      expired ? "expired" : "unauthorized",
    );
  }
}

/** Wraps a handler with method checks and uniform JSON errors. */
export function route(
  methods: string[],
  handler: (request: VercelRequest, response: VercelResponse) => Promise<unknown>,
) {
  return async (request: VercelRequest, response: VercelResponse) => {
    if (!methods.includes(request.method ?? "")) {
      response.setHeader("Allow", methods.join(", "));
      return response.status(405).json({ error: "Method not allowed." });
    }

    try {
      const result = await handler(request, response);
      if (!response.headersSent && result !== undefined) {
        response.setHeader("Cache-Control", "private, no-store");
        response.status(200).json(result);
      }
    } catch (error) {
      if (response.headersSent) {
        console.error(error);
        response.end();
        return;
      }
      if (error instanceof HttpError) {
        return response.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error(error);
      return response.status(500).json({ error: "Something went wrong. Try again.", code: "generic" });
    }
  };
}
