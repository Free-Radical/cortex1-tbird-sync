# Developer Reference

Technical reference for cortex_server implementors and extension contributors.

## Architecture

### WebSocket Mode (Primary)

```
┌─────────────────┐                    ┌──────────────────┐
│ cortex_server   │ ═══ WebSocket ════ │ TB Extension     │
│ (port 5001)     │ ws://localhost:5001│                  │
│                 │   /tbird-sync/ws   │                  │
└─────────────────┘                    └──────────────────┘
      │                                        │
      │  ─── {type:"command", data:{...}} ───▶ │
      │  ◀── {type:"result", data:{...}} ────  │
      │  ◀── {type:"event", data:{...}} ─────  │
      │  ─── {type:"ping"} ─────────────────▶  │
      │  ◀── {type:"pong"} ─────────────────── │
```

1. Extension connects to WebSocket on startup
2. Server pushes commands in real-time
3. Extension executes commands via `messenger.messages.update()`
4. Extension sends results/events back via WebSocket
5. Auto-reconnect with exponential backoff (1s -> 2s -> 4s -> ... -> 30s max)

## Server Endpoints

The extension expects these endpoints on `localhost:5001`:

### WebSocket Endpoint

**WS /tbird-sync/ws**

Bidirectional WebSocket for real-time communication.

**Server → Extension messages:**
```json
{"type": "command", "data": {"id": "uuid", "action": "mark_read", "messageId": "..."}}
{"type": "ping", "data": {}}
```

**Extension → Server messages:**
```json
{"type": "result", "data": {"id": "uuid", "success": true, "action": "mark_read"}}
{"type": "event", "data": {"event_type": "messages.onNewMailReceived", ...}}
{"type": "pong", "data": {"timestamp": 1234567890}}
```

### Server-Side Endpoints (not called by extension)

**GET /tbird-sync/status** (recommended for health checks, called by cortex_server internally)
```json
{
  "connection": {"connected": true},
  "mail_recency": {
    "last_event_received_ts": "2026-02-16T12:01:00+00:00",
    "last_mail_seen_ts": "2026-02-16T12:00:00+00:00",
    "last_mail_ingested_ts": "2026-02-16T12:00:30+00:00",
    "lag_seconds": 30,
    "max_lag_seconds": 1800,
    "stale": false
  }
}
```

## Supported Actions

### Single Message Actions

| Action | Description |
|--------|-------------|
| `mark_read` | Set message read=true |
| `mark_unread` | Set message read=false |
| `set_flagged` | Set flagged status (requires `flagged: true/false`) |
| `open_message` | Open message in new Thunderbird window |
| `get_status` | Get live read/flagged status from Thunderbird |
| `recover_body` | Read and return the full body by Message-ID; an optional metadata-only `locator` enables the same bounded, ambiguity-rejecting fallback as `cortex.messages.findByLocator` after direct lookup misses |
| `create_draft` | Create reply draft (requires `body`, optional `replyAll`) |
| `send_reply` | Send reply immediately (requires `body`, optional `replyAll`) |

`recover_body` completions include an allowlisted `recovery_status` and
`terminal_source_missing: false`. Misses, ambiguity, incomplete locators,
folder-scope issues, empty bodies, retrieval errors, and temporary delivery
issues keep the record unchanged and return calm C1-owned copy. Failure
completions omit the source Message-ID and raw Thunderbird exception details;
only the trusted `email_body_recovered` event carries the recovered source
identity and body back to Cortex.

### Batch Actions

| Action | Description |
|--------|-------------|
| `archive` | Archive messages (requires `messageIds` array) |
| `delete` | Delete messages to Trash by default (requires `messageIds`; `skipTrash: true` is explicit permanent delete) |
| `move` | Move messages to folder (requires `messageIds`, `folder`) |
| `bulk_mark_read` | Mark multiple messages as read (requires `messageIds`) |
| `bulk_get_status` | Get status of multiple messages (requires `messageIds`) |
| `list_folders` | List all available folders |

### Generic Action

| Action | Description |
|--------|-------------|
| `rpc` | Execute an allowlisted Thunderbird WebExtension method (`method`, `args`) |

### Audit RPCs

| RPC method | Description |
|------------|-------------|
| `cortex.messages.findByLocator` | Resolve by Message-ID candidates first, then bounded sender/subject/date scans of saved and fallback folders. All Mail and Trash/Junk discovery are opt-in, and recipient/CC evidence only breaks ambiguity when it selects one match. |
| `cortex.messages.getFullByHeaderId` | Resolve a message by RFC `Message-ID`, return Thunderbird `messages.getFull()` plus current canonical `tb_state`. |
| `cortex.messages.getRawByHeaderId` | Resolve a message by RFC `Message-ID`, return Thunderbird `messages.getRaw()` source. |
| `cortex.messages.getStateAuditByHeaderId` | Resolve a message by RFC `Message-ID`, return canonical `tb_state`, raw JSON-safe Thunderbird snapshots, missing live API fields, and every known attribute class that is exposed but not synced bidirectionally. |

`cortex.messages.getStateAuditByHeaderId` is the source of truth for current property coverage. The human-readable matrix is maintained in [TBIRD_SYNC_PROPERTY_MATRIX.md](TBIRD_SYNC_PROPERTY_MATRIX.md).

### Status Query Notes

The `get_status` and `bulk_get_status` commands return **live status** from Thunderbird:
- `read`: Whether message is read (accurate)
- `flagged`: Whether message is starred/flagged (accurate)
- `junk`: Spam status (accurate)

**Important:** `forwarded` and `replied` status are **NOT available** via Thunderbird's WebExtension API.
These can only be read from X-Mozilla-Status headers in mbox files, which may be stale until Thunderbird compacts the folder.
