# Thunderbird Property Sync Matrix

This file describes what `cortex1-tbird-sync` exposes today. It is intentionally conservative: it documents supported, partial, read-only, and unsupported surfaces instead of claiming that every Thunderbird message property round-trips.

## Canonical State

`buildTbState()` is the canonical normalized state returned after supported commands and by `sync_state` / `bulk_sync_state`.

| Property | Source | Direction | Status |
|---|---|---|---|
| `read` | `MessageHeader.read` | read/write | Supported via `mark_read`, `mark_unread`, `bulk_mark_read`, `messages.update`, and completion `tb_state`. |
| `flagged` | `MessageHeader.flagged` | read/write | Supported via `set_flagged`, `messages.update`, and completion `tb_state`. |
| `junk` | `MessageHeader.junk` | read/write | Supported via `set_junk`, `messages.update`, and completion `tb_state`. |
| `tags` | `MessageHeader.tags` | read/write | Supported for tag keys via `set_tags` and `messages.update`. Tag metadata is queryable, but not canonical state. |
| `folder.accountId` | `MessageHeader.folder.accountId` | read-only in state | Exposed in `tb_state`; mutations happen through archive/move/delete/copy commands. |
| `folder.path` | `MessageHeader.folder.path` | read-only in state | Exposed in `tb_state`; folder resolution is path/name based. |
| `folder.name` | `MessageHeader.folder.name` | read-only in state | Exposed in `tb_state`. |
| `folder.type` | `MessageHeader.folder.type` | read-only in state | Exposed in `tb_state` when Thunderbird provides it. |
| `folder.specialUse` | `MessageHeader.folder.specialUse` | read-only in state | Exposed in `tb_state`. |
| `folder.isFavorite` | `MessageHeader.folder.isFavorite` | read-only in state | Exposed in `tb_state`. |
| `folder.isRoot` | `MessageHeader.folder.isRoot` | read-only in state | Exposed in `tb_state`. |
| `date` | `MessageHeader.date` | read-only | Exposed in `tb_state` and message headers. |
| `subject` | `MessageHeader.subject` | read-only | Exposed in `tb_state` and message headers. |
| `author` | `MessageHeader.author` | read-only | Exposed in `tb_state` and message headers. |
| `headerMessageId` | `MessageHeader.headerMessageId` | read-only locator | Durable locator used by cortex RPC helpers. Duplicate or missing Message-ID values still need caller-side handling. |
| `size` | `MessageHeader.size` | read-only | Exposed in `tb_state` when Thunderbird provides it. |
| `stateReadAt` | local timestamp | read-only | Timestamp of local state capture. |

## Additional Header Exposure

`minifyMessageHeader()` and `cortex.messages.getStateAuditByHeaderId` expose additional message header fields that are not all canonical bidirectional state. The audit RPC also returns `raw_message_header`, a JSON-safe snapshot of every enumerable field Thunderbird returned on the live `MessageHeader` object.

| Property | Direction | Status |
|---|---|---|
| `id` / internal message id | read-only, unstable | Exposed for short-term operations only. Not durable across every move/import/profile case. |
| `recipients`, `ccList`, `bccList` | read-only | Exposed in message headers; not writable by tbird-sync for existing messages. |
| `external`, `headersOnly`, `priority` | read-only | Exposed by audit when Thunderbird provides them; not canonical writable state. |
| `junkScore` | read-only | Reported by audit when Thunderbird exposes it; not canonical writable state. |
| `new` | read-only | Reported by audit when Thunderbird exposes it; not canonical writable state. |

## Raw Audit Exposure

`cortex.messages.getStateAuditByHeaderId` now exposes the raw Thunderbird surfaces it can reach, in addition to the canonical `tb_state` subset:

| Audit field | Thunderbird API/source | Status |
|---|---|---|
| `raw_message_header` | `messages.query()` result | JSON-safe snapshot of every enumerable `MessageHeader` property returned by Thunderbird. |
| `raw_folder` | `MessageHeader.folder` | JSON-safe snapshot of every enumerable `MailFolder` property returned by Thunderbird. |
| `full_message_part` | `messages.getFull()` | JSON-safe snapshot of the full MIME `MessagePart` tree. |
| `headers` | `messages.getHeaders()` when available | Raw header map plus lower-cased header names; reports `api not available` or API errors explicitly. |
| `attachments` | `messages.listAttachments()` when available | Raw attachment metadata plus the existing best-effort manifest derived from `getFull()`. |
| `folder_info` | `folders.getFolderInfo()` when available | Folder counts, quota, and last-used metadata as Thunderbird/provider diagnostics. |
| `folder_capabilities` | `folders.getCapabilities()` when available | Folder capability booleans as Thunderbird diagnostics. |
| `missing_or_not_synced_attributes` | audit-generated | Lists expected fields missing from the live API object and every known field class not synced bidirectionally. |

## Commands

| Command / RPC | Direction | Status |
|---|---|---|
| `mark_read`, `mark_unread` | C1 -> Thunderbird | Supported, returns authoritative `tb_state` after refetch. |
| `set_flagged` | C1 -> Thunderbird | Supported, returns authoritative `tb_state` after refetch. |
| `set_junk` | C1 -> Thunderbird | Supported, returns authoritative `tb_state` after refetch. |
| `set_tags` | C1 -> Thunderbird | Supported for tag keys. |
| `archive`, `move`, `delete` | C1 -> Thunderbird | Supported. Moved/archived messages may return `tb_state: null` if Thunderbird changes the internal id before refetch. |
| `cortex.messages.updateByHeaderId` | C1 -> Thunderbird | Generic update for Thunderbird-supported `MessageProperties`; caller must avoid unsupported properties. |
| `cortex.messages.findByLocator` | Thunderbird -> C1 | Resolves by Message-ID candidates first, then bounded sender/subject/date scans of saved and fallback folders. Optional All Mail/Trash discovery is opt-in, and recipient/CC evidence is only used to break otherwise ambiguous matches when unique. |
| `cortex.messages.getFullByHeaderId` | Thunderbird -> C1 | Returns raw `getFull()` payload plus canonical `state`. |
| `cortex.messages.getRawByHeaderId` | Thunderbird -> C1 | Returns raw message source. |
| `cortex.messages.getStateAuditByHeaderId` | Thunderbird -> C1 | Returns normalized state, audited capabilities, best-effort attachment/calendar manifests, and explicit unsupported-property notes. |

## Partial Or Unsupported

| Surface | Status | Reason |
|---|---|---|
| `MessageHeader.id`, `external`, `headersOnly`, `junkScore`, `new`, `priority`, `recipients`, `ccList`, `bccList`, `size` | Exposed, not two-way synced | Read-only metadata, presentation metadata, or unstable locators. |
| `MailFolder.id`, `isTag`, `isUnified`, `isVirtual`, `subFolders` | Exposed, not two-way synced | Folder metadata is diagnostic; message moves/archives/deletes are command paths. |
| `MailFolderInfo.favorite`, `lastUsed`, `lastUsedAsDestination`, `newMessageCount`, `quota`, `totalMessageCount`, `unreadMessageCount` | Exposed, not two-way synced | Provider/Thunderbird-derived diagnostics. |
| `MailFolderCapabilities.canAddMessages`, `canAddSubfolders`, `canBeDeleted`, `canBeRenamed`, `canDeleteMessages` | Exposed, not two-way synced | Capability report, not mutable message state. |
| `MessagePart.body`, `contentType`, `decryptionStatus`, `headers`, `name`, `partName`, `parts`, `rawBody`, `rawHeaders`, `size` | Exposed, not two-way synced | Full MIME tree is inspectable; tbird-sync does not mutate arbitrary MIME parts. |
| `MessageAttachment.contentDisposition`, `contentType`, `headers`, `name`, `partName`, `size`, `contentId`, `message` | Exposed, not two-way synced | Attachment metadata is exposed when APIs provide it; bytes/download lifecycle are not synced. |
| Native replied / forwarded flags | Partial | Thunderbird WebExtension `MessageHeader` / `MessageProperties` do not expose these as complete mutable flags. tbird-sync uses compose events and sent-folder/header inference where available. |
| Calendar invites / ICS state | Metadata-only | Calendar parts may appear as `text/calendar`, but acceptance/provider state is not synced. |
| Full raw headers | Available, not normalized | `getFull()` / `getHeaders()` / `getRaw()` expose headers, but tbird-sync does not canonicalize every header into state. |
| Security/authentication/crypto state | Unsupported | Authentication results, encryption/signature verification, and provider security verdicts are not normalized. |
| Threads/conversations | Unsupported | Thunderbird WebExtension messages API does not expose stable `threadId` or a thread API. |
| Duplicate/missing Message-ID conflict handling | Partial | `headerMessageId` is the durable locator; conflict modeling belongs in the caller/server layer. |

## Audit RPC

Use:

```json
{
  "action": "rpc",
  "method": "cortex.messages.getStateAuditByHeaderId",
  "args": ["message-id@example.com"]
}
```

The response is an explicit capability report. It should be treated as the source of truth for what `tbird-sync` normalizes versus what remains raw, partial, or unsupported.
