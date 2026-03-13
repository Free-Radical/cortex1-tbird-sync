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

---

## Architecture SSOT Sync

cortexONE-Docs (https://github.com/Free-Radical/cortexONE-Docs) is the Single Source of Truth for system architecture and design. When changing any of the following in this repo, the corresponding docs in cortexONE-Docs MUST be updated in the same work session:

- WebExtension IPC protocol or message format
- Sync endpoints or polling behavior
- Email metadata fields passed to cortex1-core

Key docs to check:
- `docs/cortex1/v1/modules/email-module.md`
- `docs/cortex1/v1/SSOT-Core.md`

---

## TODO.md Must Stay Current

The repo's `TODO.md` MUST be updated before pushing when any of the following change:
- MVP blockers are completed or added
- New features are implemented that affect the roadmap
- Blocked items become unblocked
- Post-MVP items are promoted to MVP or vice versa

TODO.md is the public-facing roadmap for this repo. Stale TODOs mislead contributors and other repos that depend on this one.

## No Stale or Misplaced Files

When deleting or removing code, features, or dependencies, all associated artifacts MUST be cleaned up in the same commit:
- Documentation that describes the removed feature
- Tests that test the removed code
- Hook references, CI config, and package.json scripts that invoke removed files
- Config entries, env vars, and imports that reference removed modules

Build artifacts, runtime logs, and files belonging to other repos must not accumulate in the working tree. Add them to `.gitignore` or delete them.

## Repository Visibility

This repository is **public** (source-available). It is distributed as a Thunderbird extension and must remain accessible for users to review, build, and install. Do not make this repo private without providing an alternative distribution channel.

## Proprietary Content Guard (Public Repo)

This repository is **public**. Before every push, reasonable efforts MUST be made to verify that no proprietary techniques, secret algorithms, internal business logic, API keys, credentials, or "secret sauce" from private repos (cortex1-core, zeroveil-gateway-pro, zeroveil-pro, cortex1-forge) has leaked into this codebase.

**Pre-push requirement:** The pre-push hook MUST display a prominent warning and require explicit user acknowledgment (interactive Y/n prompt) before allowing any push to a remote. The warning must state:

```
╔══════════════════════════════════════════════════════════════╗
║  WARNING: This is a PUBLIC repository.                      ║
║  Have you verified no proprietary code or secrets are       ║
║  included in this push?                                     ║
╚══════════════════════════════════════════════════════════════╝
```

If the user does not confirm, the push MUST be blocked. Non-interactive pushes (CI/CD) should fail-safe by blocking unless an explicit bypass env var is set.

**What to check:**
- No internal API endpoints, auth tokens, or credentials
- No proprietary algorithms or business logic from private repos
- No references to internal infrastructure (hostnames, IPs, internal URLs)
- No config files or env templates with real values
- No code copied from private repos without explicit approval from the repo owner

## Branch Hygiene

- **Single-branch policy:** All completed work MUST be merged to `master`. No long-lived feature branches.
- **Before every push:** Verify only `master` exists on remote (`git branch -r`). Stale branches must be deleted.
- **Before starting work:** Check for stale local or remote branches and clean them up.
- **Recovery:** All deleted branch commits remain recoverable via `git reflog` (90 days local) and by commit hash on GitHub (permanent).
