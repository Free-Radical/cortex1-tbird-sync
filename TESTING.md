# Testing Guide

Test strategy for `cortex1-tbird-sync` (Thunderbird extension).

This repo has JavaScript/Jest tests as the primary gate, plus Python checks for integration contracts.

---

## Quick Start

```bash
# Install deps
npm ci

# Main gate (includes coverage thresholds)
npm test
```

---

## Test Tiers

## 1) Unit tests (fast, required)

- Command/action handlers
- RPC allowlisting and execution
- Audit RPC property exposure, optional Thunderbird API availability, and JSON-safe raw snapshot handling
- Event queue and diagnostics behavior
- `tb_state` response construction

Run:

```bash
npm run test:unit
```

Expected runtime: ~5-20s.

## 2) Integration tests (stub server, required)

- Extension behavior against `tests/stub_server.js`
- WebSocket command/result flows
- LAN/remote Cortex URL preservation is covered by unit transport tests; `cortex_server_url` may point at a local-LAN host and must convert to `ws(s)://.../tbird-sync/ws` without being forced back to loopback.

Run:

```bash
npm run test:integration
```

Expected runtime: ~10-40s.

## 3) Python contract tests (required for sent-folder and API checks)

Run:

```bash
python -m pytest tests/test_sent_folder_discovery.py -q
python -m pytest tests/test_extension.py -q
```

Notes:

- `tests/test_extension.py` skips live polling checks unless `CORTEX_TBIRD_SYNC_LIVE=1`.
- Server target is `http://localhost:5001` in current test script.

## 4) Optional load tests (manual)

Run:

```bash
node tests/load/ws_load_test.js
```

Useful environment variables:

- `CORTEX_SERVER_URL`
- `CORTEX_WS_URL`
- `WS_THROUGHPUT_TARGET`
- `WS_HTTP_RATIO_TARGET`
- `WS_MEM_GROWTH_MB_TARGET`
- `WS_BACKOFF_TEST_URL`

---

## Coverage Thresholds

`package.json` enforces global Jest thresholds:

- statements: 50
- branches: 40
- functions: 45
- lines: 50

`npm test` will fail if thresholds drop below these values.

---

## Pre-Commit Minimum

Before committing extension logic changes:

```bash
npm test
python -m pytest tests/test_sent_folder_discovery.py -q
```

For server-interaction changes, also run:

```bash
python -m pytest tests/test_extension.py -q
```

For live behavior changes, run:

```bash
set CORTEX_TBIRD_SYNC_LIVE=1
python -m pytest tests/test_extension.py -q
```

---

## Failure Handling

- If RPC/transport tests fail, check `INVARIANTS.md` first (allowlist and WebSocket contracts).
- If sent-folder tests fail, verify no `folder.id` dependency was introduced.
- If only coverage fails, add focused tests for changed logic instead of lowering thresholds.

---

## Test Hygiene

- Keep unit tests deterministic (`CORTEX_TEST_MODE` is used in test setup).
- Do not require a real Thunderbird instance for default CI/local green paths.
- Keep live checks opt-in and clearly labeled.
