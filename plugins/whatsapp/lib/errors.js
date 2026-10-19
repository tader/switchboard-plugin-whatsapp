export class WhatsAppError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(
      {
        signin_required:
          "Reconnect WhatsApp to restore the linked-device session.",
        session_revoked:
          "This WhatsApp device was revoked. Reconnect using your phone number.",
        international_phone_number_required:
          "Enter your phone number including its country code, without a leading zero.",
        pairing_expired:
          "The phone-pairing code expired. Start the connection again.",
        pairing_failed:
          "WhatsApp could not start phone pairing. Retry and confirm this number is signed in on your phone.",
        account_mismatch:
          "Use the WhatsApp account originally linked to this connection.",
        poll_key_unavailable:
          "This session does not have the original poll key. Vote using WhatsApp on your phone.",
        helper_download_failed:
          "The matching WhatsApp helper could not be downloaded. Retry or configure a local helper executable.",
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
