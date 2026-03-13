# cortex1-tbird-sync — TODO

## Improvements
- [ ] Reduce/structure noisy logs — categorize + rate-limit repeated errors (e.g., connection refused), bounded ring buffer with "dropped N entries" counters
- [ ] Make logging paths explicit on server side — document `CORTEX_RPC_LOG_PATH`, optionally support posting extension logs to server for centralized troubleshooting
- [ ] Add `delete` single-message action (currently only batch delete via `move`)

## Known Limitations
- [ ] `forwarded` and `replied` status not available via Thunderbird WebExtension API — only readable from X-Mozilla-Status headers in mbox files (may be stale until folder compact)

## Done
- [x] WebSocket IPC (primary) with HTTP polling fallback
- [x] Real-time ingest: event + polling (monitorAllFolders)
- [x] Toolbar button in main toolbar by default
- [x] Recency/backlog gate fixes (monitorAllFolders forwarding, DB-fresh counts)
- [x] Diagnostics export from extension UI
- [x] Generic RPC action (allowlisted Thunderbird WebExtension methods)
