# cortex1-tbird-sync — TODO

## Improvements
- [ ] Reduce/structure noisy logs — categorize + rate-limit repeated errors (e.g., connection refused), bounded ring buffer with "dropped N entries" counters
- [ ] Make logging paths explicit on server side — document `CORTEX_RPC_LOG_PATH`, optionally support posting extension logs to server for centralized troubleshooting

## Known Limitations
- [ ] `forwarded` and `replied` status not available via Thunderbird WebExtension API — only readable from X-Mozilla-Status headers in mbox files (may be stale until folder compact)

## Done
- [x] Rebuild and hardgate packaged XPI freshness, including `recover_body` support
- [x] Locator fallback honors richer cortex1-core payloads: ordered fallback folders, opt-in All Mail/Trash discovery, and recipient/CC ambiguity tie-breaks
- [x] Locator fallback honors core's bounded 7-day recovery window
- [x] Preserve queued Thunderbird event pushes across temporary WebSocket disconnects
- [x] Rebuild and guard packaged XPI to include `cortex.messages.findByLocator` RPC implementation
- [x] Add queued `delete` command support for single and batch c1server actions
- [x] WebSocket IPC (sole transport for commands)
- [x] Real-time ingest: event + polling (monitorAllFolders)
- [x] Toolbar button in main toolbar by default
- [x] Recency/backlog gate fixes (monitorAllFolders forwarding, DB-fresh counts)
- [x] Diagnostics export from extension UI
- [x] Generic RPC action (allowlisted Thunderbird WebExtension methods)
