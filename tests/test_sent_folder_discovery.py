import json
import re
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


def test_manifest_loads_sent_folder_module_before_background():
    manifest = json.loads(_read("manifest.json"))
    scripts = manifest["background"]["scripts"]
    assert scripts[:2] == ["sent_folder_discovery.js", "background.js"]


def test_build_includes_sent_folder_module_in_xpi():
    build_bat = _read("build.bat")
    assert "sent_folder_discovery.js" in build_bat
    assert "Compress-Archive" in build_bat


def test_xpi_background_includes_locator_rpc_helpers():
    with zipfile.ZipFile(REPO_ROOT / "cortex1-tbird-sync.xpi") as zf:
        background = zf.read("background.js").decode("utf-8")

    assert "cortex.messages.findByLocator" in background
    assert "findMessageByLocator" in background


def test_xpi_contains_current_source_files():
    """The shipped XPI must not lag behind the source files it packages."""
    expected_files = ("manifest.json", "sent_folder_discovery.js", "background.js")
    with zipfile.ZipFile(REPO_ROOT / "cortex1-tbird-sync.xpi") as zf:
        for rel_path in expected_files:
            packaged = zf.read(rel_path).decode("utf-8").replace("\r\n", "\n")
            source = _read(rel_path).replace("\r\n", "\n")
            assert packaged == source


def test_xpi_background_includes_recover_body_action():
    with zipfile.ZipFile(REPO_ROOT / "cortex1-tbird-sync.xpi") as zf:
        background = zf.read("background.js").decode("utf-8")

    assert '"recover_body"' in background
    assert 'case "recover_body":' in background
    assert 'action: "recover_body",' in background
    assert "body_text" in background
    assert "body_html" in background


def test_sent_folder_discovery_does_not_require_folder_id_field():
    # Regression test: Thunderbird/Betterbird folders don't expose a numeric `id` field.
    # The earlier implementation incorrectly gated on `folder.id != null` and discovered 0 sent folders.
    js = _read("sent_folder_discovery.js")
    assert re.search(r"\bfolder\.id\b", js) is None
    assert re.search(r"\bfolder\\[\"id\"\\]\b", js) is None


def test_sent_folder_key_is_account_and_path_or_name():
    js = _read("sent_folder_discovery.js")
    assert "accountId" in js
    assert "path" in js
    assert "name" in js
    assert "return `${accountId}:${path || name}`;" in js


def test_sent_folder_discovery_uses_query_and_tree_traversal():
    js = _read("sent_folder_discovery.js")
    assert "messenger.folders.query" in js
    assert 'query({ type: "sent" })' in js
    assert "messenger.accounts.list" in js
    assert "walkFolderTree" in js


def test_background_uses_module_for_sent_folder_discovery():
    bg = _read("background.js")
    assert "Cortex1SentFolderDiscovery.getSentFolders" in bg
    assert "sent_folders_count" in bg
    # Regression: avoid assuming messages.list is newest-first; that can short-circuit to 0 processed.
    assert "seemsNewestFirst && dateMs < cutoffMs" not in bg


def test_backfill_resolves_account_filter_and_reports_it():
    bg = _read("background.js")
    assert "resolveAccountIdFilter" in bg
    assert "account_filter_requested" in bg
    assert "account_filter_resolved" in bg
    # Ensure resolved filter is used for discovery (not the raw string).
    assert "getSentFolders(accountFilterResolved)" in bg


def test_backfill_progress_heartbeat_and_completion_totals():
    bg = _read("background.js")
    assert "PROGRESS_EVERY_N_MESSAGES" in bg
    assert "PROGRESS_MIN_INTERVAL_MS" in bg
    # Completion should report total==processed so server UI renders 100%.
    assert (
        'postProgressUpdate(commandId, result.processed, result.processed, "completed"' in bg
        or 'postProgressUpdate(commandId, result.processed, result.processed, finalStatus' in bg
    )
    if 'postProgressUpdate(commandId, result.processed, result.processed, finalStatus' in bg:
        assert 'const finalStatus = result.completed_reason === "cancelled" ? "cancelled" : "completed";' in bg
    assert 'postProgressUpdate(commandId, processed, processed, "failed"' in bg
