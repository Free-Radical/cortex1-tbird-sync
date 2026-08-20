# Changelog

## Unreleased
- **Fixed silent filter loss in folder-scoped `messages.query`.** `queryFolderMessagesCompat`
  evaluated only `fromDate` and `unread`, so `author`, `subject`, `recipients`, `toDate`,
  `flagged`, `tags` and `headerMessageId` were accepted by the RPC and then discarded. A
  folder-scoped query carrying any of those returned the **entire folder listing**, which a
  caller could not distinguish from a genuine result set — a search for one sender appeared
  to succeed and silently returned everything. All of those fields are now honoured.
  - The compat path is now selected whenever any of them is present, not only for
    `fromDate` / `limit` / `unreadOnly`.
  - `toDate` is parsed and applied as an inclusive upper bound.
  - `text` is stripped before the native call — Thunderbird has no such MessageHeader
    property and rejects the whole query with a type error. It is resolved by the compat
    matcher across subject, author and recipients instead. An **unscoped** `text` query now
    returns an explicit error rather than an unfiltered listing.
  - The page budget widens for any narrowing filter, not just date cutoffs, so matches
    deeper in a large folder are no longer truncated away.
  - Added `tests/unit/query_filters.test.js` (57 tests), including end-to-end RPC
    regressions that fail against the previous behaviour, plus a contract test asserting
    every routing key in `COMPAT_QUERY_FILTER_KEYS` is actually honoured by the filter
    builder — the exact drift that caused this bug.
- Added `cortex.messages.getStateAuditByHeaderId` property audit coverage for raw
  JSON-safe Thunderbird snapshots, optional API availability, missing live
  fields, and the explicit not-bidirectionally-synced attribute list.
- Added `TBIRD_SYNC_PROPERTY_MATRIX.md` and linked it from README/DEVELOPER docs.
- Backfill scans now run on a dedicated slow lane so high-priority RPCs such as
  `accounts.list` and `cancel_job` can complete while a long scan is still
  running.

## 1.6.6 - 2026-02-16
- Real-time ingest now event + polling. `messages.onNewMailReceived` remains primary and inbox polling remains the bounded-delay fallback.
- Toolbar button shown by default in the main toolbar (`browser_action.default_area=maintoolbar`) with verified icon contract.
- Recency/backlog gates fixed:
  - `monitorAllFolders` argument is forwarded to listener registration.
  - backlog checks use DB-fresh processed/pending counts to avoid stale drift.
  - smoke/unit regressions added for recency, backlog, and manifest/action contracts.
