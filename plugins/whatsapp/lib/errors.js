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
        invalid_input:
          "Invalid request input. Check the operation's required fields, types and formats.",
        reply_context_unavailable:
          "This API can quote only complete cached text messages and polls. The requested quote context is unavailable. Nothing was sent. To send without a quote, omit replyTo and use a new idempotencyKey.",
        message_not_in_synced_cache:
          "This message is not in the connection's synced cache. Use an exact message ID from this chat's cached history, or request older history from your phone.",
        send_uncertain:
          "The send outcome is unknown and the message may have been delivered. Inspect GET /writes with the same idempotencyKey and check WhatsApp before any further send. Do not retry with a new key while the outcome is unknown.",
        invalid_write_receipt:
          "The send returned an invalid receipt and delivery is unknown. Inspect GET /writes with the same idempotencyKey and check WhatsApp before any further send.",
        poll_key_unavailable:
          "This session does not have the original poll key. Vote using WhatsApp on your phone.",
        helper_cache_unavailable:
          "Switchboard cannot read or prepare its cached WhatsApp helper. Check that the helper files and plugin data directory are owned by the Switchboard service user.",
        helper_release_unavailable:
          "The matching WhatsApp helper release is not published yet. For a PR/development installation, configure a locally built WhatsApp helper executable in plugin settings.",
        helper_download_failed:
          "The matching WhatsApp helper could not be downloaded. Retry or configure a local helper executable.",
        permission_denied:
          "This operation exceeds the connection access level.",
        uncertain:
          "The previous write outcome is unknown. Inspect GET /writes with the same idempotencyKey and check WhatsApp. Do not retry with a new key while the outcome is unknown.",
        idempotency_conflict:
          "This idempotency key was used for different content. Inspect its status with GET /writes before using a new key for an intentionally changed request.",
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
