# Invariants

KEEP THIS FILE CURRENT. These are hard rules for `cortex1-tbird-sync`.

---

## NEVER

- Reintroduce HTTP polling as a command transport. This extension is WebSocket-first and currently WebSocket-only for command IPC.
- Bypass RPC allowlisting in `background.js`.
- Allow event listener methods (`*.addListener`, `*.removeListener`, `*.hasListener`) through generic RPC execution.
- Assume Thunderbird folders expose `folder.id` for sent-folder discovery.
- Assume `messages.list()` is newest-first unless explicitly sorted.
- Remove or silently drop `tb_state` fields from action responses where state sync is expected.
- Ship unbounded in-memory/storage queues for debug logs, failures, or event queue buffers.
- Change command/result payload shapes without updating server expectations and tests together.

---

## ALWAYS

- Keep WebSocket endpoint contract: `/tbird-sync/ws`.
- Keep `manifest.json` background script order: `sent_folder_discovery.js` before `background.js`.
- Keep `cortex.*` helper RPC methods functional for header-message-id workflows.
- Keep `buildTbState()` schema stable (state flags, folder info, metadata, `stateReadAt`).
- Preserve queue limits and persistence behavior (`EVENT_QUEUE_LIMIT`, debug/failure caps).
- Validate new RPC methods against allowlist checks and unit tests.
- Run tests before commit (see `TESTING.md`).
- If a contract test fails, fix production code first; only change tests when behavior is intentionally changed.

---

## Transport Contracts

- Primary and required IPC path: WebSocket.
- Connection backoff must remain bounded (exponential with max delay cap).
- Completion batching must not block command intake.

---

## RPC Contracts

- `isAllowedRpcMethodPath()` is the gate for generic RPC.
- `cortex.findMessageByHeaderId` and related `cortex.messages.*ByHeaderId` methods are compatibility-critical.
- Aggregate RPCs such as `cortex.getInboxCounts` and `cortex.getNewestInboxMessageByAccount` must remain callable and stable.

---

## Sent Folder Discovery Contracts

- Discovery must use account/path or account/name keys, not folder numeric IDs.
- Regression rules are enforced by `tests/test_sent_folder_discovery.py`.

---

## Protected Files

Changes here require extra care and targeted tests:

- `background.js`
- `sent_folder_discovery.js`
- `manifest.json`
- `tests/setup.js`
- `package.json`
- `build.bat`

---

## Verification Commands

```bash
# Full JS test suite with coverage thresholds
npm test

# Focused JS suites
npm run test:unit
npm run test:integration

# Python regression checks
python -m pytest tests/test_sent_folder_discovery.py -q
python -m pytest tests/test_extension.py -q
```

For live Thunderbird checks, set `CORTEX_TBIRD_SYNC_LIVE=1` before running `tests/test_extension.py`.

---

See `TESTING.md` for test tiers, runtime expectations, and troubleshooting.
