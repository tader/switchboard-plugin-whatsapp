# WhatsApp plugin for Switchboard

WhatsApp direct and group chats for [Switchboard](https://github.com/tader/switchboard): read synced messages, send text, quote a message, add/remove a reaction, and vote in an existing poll. Uses a pinned [whatsmeow](https://github.com/tulir/whatsmeow) linked-device client. No browser automation, WhatsApp Business account, or separate GOWA server is required.

## Install and link

Install `tader/switchboard-plugin-whatsapp`, folder `plugins/whatsapp`. Stable installation requires a published release; before the first release, build the helper locally and configure its absolute path in **Plugins → WhatsApp → Settings → WhatsApp helper executable**.

Add a **WhatsApp** connection, enter your own phone number in international format and choose read-only or read/write access. Switchboard displays a pairing code. On your phone, open **WhatsApp → Linked devices → Link a device → Link with phone number instead** and enter that code. The short-lived code must be used promptly. Subsequent starts reuse the saved linked-device session without another pairing.

The plugin manages its own helper process. Releases provide checksum-verified binaries for macOS and Linux on ARM64 and AMD64. Node 24 or newer is required; there are no runtime npm dependencies. See the [setup and recovery guide](plugins/whatsapp/docs/setup.md).

## Operations

| Operation                 | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `getWhatsAppStatus`       | Connection state and partial history-sync coverage              |
| `getWhatsAppCapabilities` | Supported features and selected access level                    |
| `listWhatsAppChats`       | Paginated synced direct/group chats                             |
| `listWhatsAppMessages`    | Paginated cached messages without marking read                  |
| `getWhatsAppMessage`      | Message details, quote context and poll options                 |
| `sendWhatsAppMessage`     | Send text, optionally quoting a cached message                  |
| `reactWhatsAppMessage`    | Add/change a reaction; empty emoji removes it                   |
| `voteWhatsAppPoll`        | Replace selected poll options; an empty list withdraws the vote |
| `requestWhatsAppHistory`  | Explicit asynchronous backfill request to the phone             |
| `getWhatsAppWriteStatus`  | Inspect durable write receipts without resending                |

Phone history sync and incoming events populate a local cache. It is **not a complete server-side archive**; all history pages report `coverage=synced_cache_only`. The linked phone controls which older messages it supplies. Quotes, reactions and votes use exact message IDs and original sender metadata from that cache. Voting additionally needs the original poll encryption key; missing keys fail explicitly. Poll totals, media download/upload, edits, deleting messages, calls, status broadcasts and newsletters are outside this version. Media messages expose type/caption only. Disappearing and view-once content is represented as restricted metadata and its body is not archived by this plugin.

Writes require an idempotency key. Accepted writes replay their receipt; conflicting content and uncertain outcomes do not resend. Reading, replying, reacting and voting never automatically send read receipts. [API examples and recovery](plugins/whatsapp/docs/operations.md).

## Local and remote use

Run on your laptop or pair directly on a remote Switchboard. To access a laptop-owned connection remotely, use Switchboard's normal **Peers → Share connection** flow. Operations run on the owner; WhatsApp session keys and message cache stay there. This plugin deliberately does not export a linked-device session as an authentication source. A session must not be opened concurrently by two Switchboard instances.

This is an unofficial linked-device integration, subject to WhatsApp protocol changes and account policies. Disconnect it from the phone's Linked devices screen when you want to revoke the linked device.

## Development

```sh
npm ci
npm run check
npm test
npm run test:bridge
npm run build:bridge
SWITCHBOARD_ROOT=/path/to/switchboard npm run integration
```

Go 1.27.2 builds the helper with pure-Go SQLite. `npm run build:bridge` writes `.local/whatsapp-bridge`; set the plugin's helper path to that absolute file when developing. Native tests use a temporary local device store and real poll encryption without connecting to WhatsApp. The integration suite exercises the actual Switchboard installer, plugin manager, pairing flow, proxy, discovery, persistence and restart with a fixture account, plus offline startup of the real helper. Live pairing and message delivery have not been validated.

The release workflow tests reviewed `main` changes, cross-builds four helper binaries and publishes them with `sha256sums.txt` in the matching `v1.0.0` release. Bump package/lockfile/plugin versions and the helper's default version together in later PRs. The default executable download is pinned to the installed plugin version; it never executes an unverified latest release. Plugin folders remain self-contained. Third-party components and licensing are recorded in [NOTICE.md](NOTICE.md).
