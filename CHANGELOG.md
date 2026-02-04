# Changelog

## Unreleased
- **WebSocket IPC**: Primary communication via `ws://localhost:5001/tbird-sync/ws` for real-time bidirectional sync
- **HTTP fallback**: Automatic fallback to HTTP polling when WebSocket is unavailable
- **Auto-reconnect**: Exponential backoff reconnection (1s → 30s max) when WebSocket disconnects
- Add diagnostics export (JSON/JSONL) via toolbar menu/command, including recent failure tracking.
- License: Business Source License 1.1 (BSL 1.1) with Additional Use Grant (non-production only).
- Change Date: 2030-01-01
- Change License: Apache 2.0
