---
title: WhatsApp chats, replies, reactions and polls
services: [whatsapp]
order: 2
---

# Read and write WhatsApp messages

The service base URL is `http://whatsapp.localhost`. Use these routes through Switchboard, not by trying to reach that hostname externally. Every response is scoped to the connection's linked account. Direct chat IDs use `@s.whatsapp.net` or `@lid`; group IDs use `@g.us`. Use exact chat IDs returned by discovery. Phone-number and LID aliases may both appear when WhatsApp supplies them; this version does not merge their message histories.

## Discovery and history

- `GET /chats?type=all&limit=50`: `type` can be `all`, `direct` or `group`.
- `GET /messages?chat=123456789@s.whatsapp.net&limit=50`.
- `GET /messages/info?chat=123456789@s.whatsapp.net&messageId=EXACT_ID`.

Pages contain `items`, `nextCursor`, `hasMore`, and `coverage=synced_cache_only`. Pass `nextCursor` as `cursor` while retaining the same chat/type. Limits range from 1–100. Message timestamps are Unix milliseconds, not Slack timestamp strings. Cached pagination is ordered by timestamp and ID, avoiding duplicate rows for equal timestamps. New live traffic can change chat ordering between requests.

Reads do not fetch an unbounded phone archive or mark anything read. To request an older batch explicitly, call `POST /history` with `chat`, `beforeMessageId` from an existing cached message and optional `count` (1–50, default 50). It returns `requested=true`; a later phone history-sync event may extend the cache. This is not a guarantee of additional history. A missing cached message returns `message_not_in_synced_cache`, not a fabricated empty message.

## Send and quote

`POST /messages` takes:

```json
{
  "chat": "123456789@s.whatsapp.net",
  "text": "Hello",
  "idempotencyKey": "send-unique-key"
}
```

Add `replyTo` with an exact cached message ID to quote it. The original sender and message content are taken from that chat's cache, rather than supplied by the caller. This version can quote untruncated text messages and polls; missing/restricted/media context fails explicitly before sending. An empty `replyTo` is treated as omitted before idempotency checks, so empty and omitted forms of the same request share one receipt. Other invalid values, including whitespace and `null`, are rejected. Unsupported quoted replies never automatically fall back to an unquoted send: to send without the quote, omit `replyTo` and use a new idempotency key because the message has changed.

## Reactions and poll voting

`POST /reactions` takes `chat`, `messageId`, `emoji`, and `idempotencyKey`. Use an empty `emoji` to remove your reaction. Targets must exist in that chat's cache.

For voting, first get the poll through `/messages/info`. Its `poll` object supplies the exact `options` strings and `selectableCount`. Call `POST /polls/vote` with `chat`, the poll's `messageId`, selected `options`, and `idempotencyKey`. Options replace your previous selection; `[]` withdraws it. A new selection needs a new key. Duplicate/unknown options and selections above the poll's maximum are rejected. A poll's stored message is insufficient without its native encryption key; `poll_key_unavailable` means voting is unavailable for this session. The plugin does not reconstruct vote totals or fabricate results from partial history.

## Write recovery

All sends, replies, reactions and votes require read/write access. The plugin durably records the attempt before invoking the native client. Accepted receipts include the native `messageId` and chat; replaying the same key and payload returns that receipt with `replayed=true`. Changing any content with the same key returns `idempotency_conflict`.

A timeout/crash can leave state `attempted`, which means **uncertain**, not failed. Repeating that key does not resend. Inspect `GET /writes?idempotencyKey=...` and check the native `messageId` in history or WhatsApp before deciding what to do. The journal survives helper/plugin restarts. Native validation failures before a send are marked rejected and may be retried with the same key. After 10,000 distinct write keys per account/profile, the journal rejects new keys rather than silently discarding deduplication history.

View-once and disappearing-message bodies are not archived. This version does not apply all incoming edit updates or provide attachment downloads; use the official WhatsApp client when exact rich-message state is needed. Status reports cache errors separately from connection readiness.
