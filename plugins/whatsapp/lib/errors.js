export class WhatsAppError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(
      {
        invalid_auth:
          "WhatsApp rejected the credentials; reconnect this connection.",
        token_revoked:
          "WhatsApp access was revoked; reconnect this connection.",
        token_expired:
          "WhatsApp credentials expired; reconnect this connection.",
        missing_scope:
          "The WhatsApp app lacks a required user scope; update the app and reconnect.",
        ratelimited:
          "WhatsApp rate limit reached; retry after the indicated delay.",
        reconnect_required: "Reconnect WhatsApp to obtain a new authorization.",
        permission_denied:
          "This operation exceeds the connection access level.",
        uncertain:
          "The previous write outcome is unknown. Check WhatsApp before making another attempt.",
        idempotency_conflict:
          "This idempotency key was used for different content.",
      }[code] ?? `WhatsApp operation failed (${code}).`,
    );
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
export const fail = (code, status = 400, extra) =>
  new WhatsAppError(code, status, extra);
export function publicError(error) {
  return error instanceof WhatsAppError
    ? {
        code: error.code,
        message: error.message,
        ...(error.retryAfter !== undefined
          ? { retryAfter: error.retryAfter }
          : {}),
      }
    : {
        code: "internal_error",
        message: "The WhatsApp adapter could not finish this operation.",
      };
}
