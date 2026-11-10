---
title: Shared Messaging contract and native changes
services: [whatsapp]
order: 3
---

# Messaging v1 (staged)

This optional generic interface sits beside the existing WhatsApp operations. It
requires the staged [Switchboard core](https://github.com/tader/switchboard/pull/40)
and `SWITCHBOARD_SHARED_CONTRACTS=1`. Development installations must select a helper
built from this revision. Released plugin/helper versions remain synchronized by
Release Please. This change does not enable or deploy the core feature.

Common operations are conversation list/get, message list/get, message send with
optional quoted reply, and reaction update/removal. A read-only binding advertises
only the four reads; invocation also enforces that boundary. Unsupported common
thread filters/targets, creation, edits/deletes, thread enumeration, read-state,
poll mutations and attachments are not advertised. The existing provider-specific
operations remain available separately. No read sends a read receipt or asks the
phone for older history automatically.

All resources belong to the selected connection/account. Ids are opaque; clients
must retain the connection alongside each id. Signed page cursors additionally bind
the connection, account, profile, query and page limit. Binding digests do not serialize private profile/account credential references into
the cursor. Their private signing key
survives restart. Cached chat/message pages always report partial coverage, including
the final page. A cache miss is not a global deletion. Phone-number and LID aliases
are not merged. Hidden/restricted/deleted and truncated bodies are not represented
as complete text. Unknown unread/author/ownership/time metadata remains null. Poll
names and media captions are text fallbacks; this API does not transfer media files
or expand poll totals. Reactions are reconstructed from synced reaction events; counts and an unobserved own reaction remain unknown because the cache is partial.

Sends accept up to 4000 UTF-16 code units. Core intent keys are namespaced into the
existing durable profile/account ledger. Accepted writes replay the same receipt;
a different payload conflicts; an ambiguous dispatch never resends automatically.
Quotes retain the exact selected target and reject unsupported context without
silently sending an unquoted message. Common reactions accept a selected cached
message and at most 16 Unicode code points; removal is explicit. Ledger receipts
contain metadata, not outgoing message bodies or device keys. The separately owned
synced-message cache continues to contain the messages it is intended to serve.

## Durable native feed

SQL triggers append metadata in the same transaction as message/chat cache changes.
Message ingestion now commits the message, chat and feed together. Ordinary duplicate
cache deliveries do not append changes. History-sync name changes and locally sent
messages use the same cache/feed path. The feed contains only chat/message ids,
change kinds and sequence/time metadata, never text, captions, poll names, quote
payloads, keys or provider error strings.

The helper keeps at most seven days and 100,000 feed rows. Identifiers have bounded
sizes, keeping retained metadata payload below 128 MiB. Eviction advances a durable
watermark; deleting the entire retained history does not reset sequence identity.
Checkpoints bind the profile database's random incarnation and sequence. A missing,
foreign, expired or future cursor yields a scope resync marker and a fresh checkpoint.
Malformed stored cursors also recover through resync. Page reads use a consistent
SQLite transaction. The feed is the history of this owned synced cache, not a promise
of complete or exactly-once delivery from WhatsApp.

The additive `changes.v1` helper feature retains RPC protocol 1. Coalesced wake hints
share stdout with normal responses through one serialized encoder. Hints contain no
payload/cursor and are not acknowledgements. The bridge registers a cancellable
listener before querying the durable log, publishes each page through core, and
advances its checkpoint only after publication succeeds. There is no timer-based
provider polling in this watch hook. Reconnect replays durable pages; a gap emits
`resync.required`, requiring a new snapshot.

Core shares the native hook between authorized active consumers of a connection.
It checks live authority/activity before publication. Idle/revoked/shutdown hooks
detach their listeners and cancel pending IPC reads; a shared helper installation is
not cancelled by one consumer. The existing owner-local linked-device helper may
remain connected for its other consumers and cached-session lifecycle. Native hook
cleanup does not forcibly log out the account or delete the cache. Native-only
reconciliation is explicitly unsupported rather than simulated by repeated polling.

Revoked/mismatched sessions cause the core's persistent terminal authentication
pause. A verified explicit reconnection writes an opaque `sessionRevision` alongside
the encrypted profile/account credentials, so recovery is observable even when those
two ids stay unchanged. Ordinary reads, activity, restarts and status checks do not
rotate it or clear the pause. This revision is bookkeeping, not exported device keys,
pairing codes or QR material. Existing durable write identities remain unchanged.

A helper without the feed feature fails native watching explicitly; normal legacy
calls remain available. A cache failure is reported instead of acknowledging a lost
publication. Tests exercise rollback, duplicate suppression, restart, retention,
page boundaries, hint serialization/coalescing, cancellation, strict schema/targets,
write replay/uncertainty, restricted content and auth recovery. They use temporary
local device stores and offline helper fixtures. No live message or new pairing is
created by these tests.
