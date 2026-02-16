# Changelog

## Unreleased

## 1.6.6 - 2026-02-16
- Real-time ingest now event + polling. `messages.onNewMailReceived` remains primary and inbox polling remains the bounded-delay fallback.
- Toolbar button shown by default in the main toolbar (`browser_action.default_area=maintoolbar`) with verified icon contract.
- Recency/backlog gates fixed:
  - `monitorAllFolders` argument is forwarded to listener registration.
  - backlog checks use DB-fresh processed/pending counts to avoid stale drift.
  - smoke/unit regressions added for recency, backlog, and manifest/action contracts.
