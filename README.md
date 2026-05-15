# cortex1-tbird-sync

> Source-available under [PolyForm Noncommercial 1.0.0](LICENSE). [Commercial licensing](COMMERCIAL-LICENSE.md) available.

Thunderbird extension that keeps your email state (read, flagged, archived) in sync with [cortex_server](https://github.com/Free-Radical/cortex1-core) in real time.

## Requirements

- Thunderbird 115+ (or Betterbird)
- cortex_server running on `localhost:5001`
- Node.js 18+ and npm (to build from source)

## Installation

1. Run `./build.sh` (Linux/macOS) or `build.bat` (Windows) to create `cortex1-tbird-sync.xpi`
2. In Thunderbird: **Tools > Add-ons and Themes > gear icon > Install Add-on From File**
3. Select `cortex1-tbird-sync.xpi`

The extension connects to cortex_server automatically on startup. The "Cortex1 Sync" toolbar button confirms the connection status.

## How It Works

The extension communicates with cortex_server using **WebSocket** (real-time, sole transport for commands).

**Supported operations:** mark read/unread, flag, junk, archive, move, delete, open message, create/send reply drafts, and generic RPC calls into Thunderbird's WebExtension APIs.

**Property audit:** `cortex.messages.getStateAuditByHeaderId` reports the canonical `tb_state`, raw JSON-safe Thunderbird API snapshots, missing live API fields, and the explicit list of attributes that are exposed but not synced bidirectionally. See [TBIRD_SYNC_PROPERTY_MATRIX.md](TBIRD_SYNC_PROPERTY_MATRIX.md).

**Real-time ingest:** New mail is detected via `messages.onNewMailReceived` (with inbox polling as bounded-delay fallback).

## Configuration

Optional overrides stored in `messenger.storage.local`:

| Key | Default | Description |
|-----|---------|-------------|
| `cortex_server_url` | `http://localhost:5001` | Server base URL |
| `cortex_event_push_enabled` | `true` | Enable/disable event push to server |

## Troubleshooting

Export a diagnostics bundle (debug logs + recent failures) directly from the extension:

- Right-click the "Cortex1 Sync" toolbar button > **Export Diagnostics**
- Or bind the `export-diagnostics` command to a keyboard shortcut

The export saves as JSON/JSONL via the downloads API (works even when cortex_server is offline).

## Development

```bash
npm install          # Install dev dependencies
npm test             # Run all tests with coverage
npm run test:stress  # Run stress tests
```

See [TESTING.md](TESTING.md) for test tiers, coverage thresholds, and pre-commit requirements.

## API Reference

For the full WebSocket protocol, supported actions, RPC contracts, and server endpoint specifications, see [DEVELOPER.md](DEVELOPER.md). For Thunderbird property exposure and sync-direction details, see [TBIRD_SYNC_PROPERTY_MATRIX.md](TBIRD_SYNC_PROPERTY_MATRIX.md).

## License

PolyForm Noncommercial License 1.0.0. Personal, hobby, educational, research, and evaluation use allowed. Commercial use requires a [separate license](COMMERCIAL-LICENSE.md). Contact: Saqib.Khan@Me.com
