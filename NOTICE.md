# Third-party components

The native helper uses an unmodified, pinned [whatsmeow](https://github.com/tulir/whatsmeow) module, `v0.0.0-20261017175727-b2b1e71d45e2`, under the Mozilla Public License 2.0. Its matching source and notices are available at [commit b2b1e71d45e2](https://github.com/tulir/whatsmeow/tree/b2b1e71d45e2); the license text is included in `licenses/whatsmeow-MPL-2.0.txt`. The helper is built from the source in `bridge/`; the module graph and checksums are recorded in `bridge/go.mod` and `bridge/go.sum`.

The pure-Go SQLite driver is [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite), with its own transitive dependencies and license notices. Release archives include the module license files collected by `scripts/licenses.js`. The plugin's TypeScript/JavaScript runtime uses Node built-ins only.

GOWA and whatsapp-rust were evaluated as architectural references; their source is not incorporated into this plugin. The loopback transport and validation pattern are adapted from this author's Switchboard Slack plugin.
