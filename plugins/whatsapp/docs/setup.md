---
title: Link WhatsApp and keep the session
services: [whatsapp]
order: 1
---

# Link WhatsApp

Install the WhatsApp plugin on the Switchboard instance that will own the linked device. On supported macOS/Linux ARM64/AMD64 hosts, the helper is downloaded from the plugin's matching release and SHA-256 verified on first use. No Go compiler or separate server is needed for published releases. For development or offline installation, configure **WhatsApp helper executable** with an absolute executable path built from this repository at the same version.

1. Add a **WhatsApp** connection. **Link WhatsApp with a QR code** is selected by default. Choose **Read only** or **Read, send, reply, react and vote**.
2. On your phone, open **WhatsApp → Linked devices → Link a device** and scan the displayed QR. It refreshes automatically and expired images are hidden. No phone number is needed.
3. Alternatively, select **Link WhatsApp with a phone code**, enter your own phone number including country code (an initial `+` is accepted), and use **Link with phone number instead** on the phone. The web verification link is informational; enter the code on your phone.
4. Pairing expires after approximately 150 seconds; restart it if needed. Call `getWhatsAppStatus` after connecting. Allow history sync to arrive before discovering chats and messages. `ready=true` means connected, not that every historical message has been received.

If QR linking asks you to upgrade Switchboard, update the core first or choose phone-code linking. Existing phone-code connections keep their sign-in method; either method can reuse the saved session.

Pair separately for a different account. Reconnecting a saved connection checks the original account and reuses its cached session. The phone number is dropped from the saved connection configuration after pairing. An invalid or revoked device requires reconnecting; scan a new QR, or supply the phone number again when using phone-code linking. Keep the plugin enabled so the helper can receive and cache events. Saved sessions resume when the plugin restarts. Temporary network outages retain the cache; writes require a live connection.

## Data and peer sharing

Each session has a private directory and an exclusive native process lock. WhatsApp cryptographic session material and decrypted message history are stored in the owner instance's SQLite database with directory permissions `0700` and database permissions `0600`. They are **not encrypted by Switchboard's connection-secret encryption**: protect the instance data volume and backups accordingly. Switchboard encrypts the connection's account/profile reference; session keys are never returned by API operations, logged, or passed in process arguments. The helper communicates through private stdin/stdout pipes, without a network listener. The adapter's loopback HTTP endpoint requires a single-use, method-and-path-bound invocation token from Switchboard.

For remote access, either pair on that remote Switchboard or share an existing connection through normal Peers sharing. Requests are forwarded to the owning instance. Credential-source sharing is not used, and no device/session database is transferred to a peer. Do not copy an active session to another running instance. The owning Switchboard must be online for a peer to use it.

## Disconnect and recovery

Removing the connection stops its helper and removes that profile's local session/cache. To revoke the device on WhatsApp, remove the linked-device entry created for this plugin from the phone's **Linked devices** screen too (it may appear as Switchboard or Chrome). Local removal does not change other WhatsApp devices. Durable write receipts remain separate to avoid accidental resends during reconnects.

If the helper cannot start, check executable permissions, supported architecture/version, and write access to the plugin data directory. `session_already_open` means another process owns that session; stop the duplicate before retrying. If a published helper cannot be downloaded, use an explicitly configured executable built at the installed plugin version. A checksum mismatch never executes the downloaded file.
