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
      │  ─── {type:"command",  data:{...}} ──▶ │
      │  ─── {type:"commands", commands:[]} ─▶ │
      │  ◀── {type:"hello",    client_id} ───  │
      │  ◀── {type:"results",  results:[]} ──  │
      │  ◀── {type:"event",    event:{...}} ─  │
      │  ─── {type:"ping"} ─────────────────▶  │
      │  ◀── {type:"pong"} ─────────────────── │
```

1. Extension connects to WebSocket on startup and sends `hello`
2. Server pushes commands in real-time
3. Extension executes commands via `messenger.messages.update()`
4. Extension sends results/events back via WebSocket, **batched**
5. Auto-reconnect with exponential backoff (1s -> 2s -> 4s -> ... -> 30s max)

## Server Endpoints

The extension expects these endpoints on `localhost:5001`:

### WebSocket Endpoint

**WS /tbird-sync/ws**

Bidirectional WebSocket for real-time communication.

**Server → Extension messages:**
```json
{"type": "command",  "data": {"id": "uuid", "action": "mark_read", "messageId": "..."}}
{"type": "commands", "commands": [{"id": "uuid", "action": "mark_read"}, ...]}
{"type": "ping"}
```

Both command forms are accepted. `command` carries a single command; the payload is
read from `data`, falling back to `command`, then to the frame itself. `commands`
carries a batch — this is what cortex_server actually sends.

**Extension → Server messages:**
```json
{"type": "hello",   "client_id": "uuid", "clientId": "uuid", "extension_version": "1.6.7"}
{"type": "results", "client_id": "uuid", "results": [{"id": "uuid", "success": true, "action": "mark_read"}, ...]}
{"type": "event",   "event": {"event_type": "messages.onNewMailReceived", ...}}
{"type": "pong",    "client_id": "uuid", "data": {"timestamp": 1234567890}}
```

**Results are plural and batched.** `flushCompletions()` sends `type: "results"` with a
`results` array of **up to 25** completions per frame — never a singular `result`.
Servers must iterate the array. The same payload is mirrored on `data` for
compatibility; `results` is authoritative.

Frames also carry `client_id` and `clientId` (both casings) at the top level, and
results are stamped with the same pair.

#### Command ID rules

The `id` field is the only correlation handle, and two cases fail **silently**:

| Case | Behaviour |
|---|---|
| `id` missing or empty | Command is dropped. Logged to the debug ring only. |
| `id` already in flight | Command is dropped as a duplicate. No result is ever sent. |

`enqueueCommands()` tracks seen ids in `knownCommandIds` and only clears an id once
its result has been flushed. **Always issue a fresh unique id per command** — reusing
one before its result returns means the caller waits forever. Retries must allocate a
new id.

#### Progress frames

Long-running jobs may emit `{"type": "progress", "data": {...}}`. Servers that do not
consume progress should ignore unknown frame types rather than erroring.

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
| `create_draft` | Create reply draft (requires `body`, optional `replyAll`) |
| `send_reply` | Send reply immediately (requires `body`, optional `replyAll`) |

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

Allowlisted prefixes: `cortex.`, `messages.`, `compose.`, `folders.`, `accounts.`,
`identities.`, `addressBooks.`. Listener methods (`addListener`, `removeListener`,
`hasListener`, and any `on*` segment) are always rejected. Responses are
`{"success": true, "action": "rpc", "method": "...", "result": <JSON-safe value>}`.

#### `messages.query` scoping

`rpc` does not pass `messages.query` straight through — it rewrites the query first:

- **`accountId` alone is not an account-wide filter.** It is converted into a folder
  scope of `{accountId, path: "/INBOX"}`, so the query silently returns inbox results
  only, hiding every other folder in that account. To search a whole account, omit
  `accountId` and filter results by `folder.accountId` on the caller side; to search
  one folder, pass `folder` explicitly.
- `folder` / `folderId` are resolved via `resolveRpcFolder()`. If a scope is requested
  but cannot be resolved, the call fails rather than silently widening.
- `fromDate` is parsed to a `Date`; `unreadOnly: true` is mapped to `unread: true`;
  `limit` and `includeBody` are stripped before reaching Thunderbird and applied by
  the extension.
- Results are re-filtered against the resolved scope, and a scope mismatch is an error.

Inbox path casing varies by provider (`/INBOX` vs `/Inbox`); callers should be
prepared to retry with the alternate casing.

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
