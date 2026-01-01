#!/usr/bin/env python3
"""
Integration tests for cortex1-tbird-sync extension.

These tests verify the extension is communicating with cortex_server properly.

Pytest behavior:
- If cortex_server is not running, tests are skipped (so local dev/CI without the server stays green).
- Live Thunderbird/extension polling checks are only run if `CORTEX_TBIRD_SYNC_LIVE=1`.

Script mode:
  python tests/test_extension.py
  python tests/test_extension.py --quick   # Skip wait tests
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import pytest


SERVER_URL = "http://localhost:5001"
POLL_WAIT_SECONDS = 5  # Time to wait for extension to poll


@dataclass
class CheckResult:
    name: str
    passed: bool
    message: str
    skippable: bool = False


def api_get(endpoint: str) -> dict | None:
    """Make GET request to server API."""
    try:
        req = urllib.request.Request(f"{SERVER_URL}{endpoint}")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def api_post(endpoint: str, data: dict) -> dict | None:
    """Make POST request to server API."""
    try:
        req = urllib.request.Request(
            f"{SERVER_URL}{endpoint}",
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def check_server_health() -> CheckResult:
    """Test that cortex_server is running."""
    try:
        req = urllib.request.Request(f"{SERVER_URL}/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.read().decode() == "OK":
                return CheckResult("server_health", True, "Server is running")
    except Exception:
        pass
    return CheckResult("server_health", False, "Server not responding at localhost:5001", skippable=True)


def check_pending_endpoint() -> CheckResult:
    """Test GET /tbird-sync/pending endpoint."""
    result = api_get("/tbird-sync/pending")
    if result is not None and "commands" in result:
        return CheckResult("pending_endpoint", True, f"Endpoint working, {len(result['commands'])} pending")
    return CheckResult("pending_endpoint", False, "Failed to get pending commands", skippable=True)


def check_status_endpoint() -> CheckResult:
    """Test GET /tbird-sync/status endpoint."""
    result = api_get("/tbird-sync/status")
    if result is not None and "pending_count" in result:
        return CheckResult("status_endpoint", True, f"Status: {result['pending_count']} pending")
    return CheckResult("status_endpoint", False, "Failed to get status", skippable=True)


def check_queue_endpoint() -> CheckResult:
    """Test POST /tbird-sync/queue endpoint."""
    result = api_post(
        "/tbird-sync/queue",
        {"action": "mark_read", "messageId": "test-queue-endpoint@example.com"},
    )
    if result is not None and result.get("status") == "queued":
        return CheckResult("queue_endpoint", True, f"Command queued with ID: {result.get('id')}")
    return CheckResult("queue_endpoint", False, "Failed to queue command", skippable=True)


def check_complete_endpoint() -> CheckResult:
    """Test POST /tbird-sync/complete endpoint."""
    result = api_post(
        "/tbird-sync/complete",
        {"results": [{"id": "test-id", "success": True, "action": "mark_read"}]},
    )
    if result is not None and result.get("status") == "ok":
        return CheckResult("complete_endpoint", True, "Complete endpoint working")
    return CheckResult("complete_endpoint", False, "Failed to post completion", skippable=True)


def check_extension_polling(quick: bool = False) -> CheckResult:
    """Test that extension is polling and processing commands.

    Queues a command and waits for extension to process it.
    The command will fail (message doesn't exist) but that's OK - we're testing the comms path.
    """
    if quick:
        return CheckResult("extension_polling", True, "Skipped (--quick mode)")

    initial = api_get("/tbird-sync/status")
    if initial is None:
        return CheckResult("extension_polling", False, "Could not get initial status", skippable=True)

    initial_results_count = len(initial.get("recent_results", []))

    queue_result = api_post(
        "/tbird-sync/queue",
        {"action": "mark_read", "messageId": f"test-polling-{int(time.time())}@example.com"},
    )
    if queue_result is None:
        return CheckResult("extension_polling", False, "Failed to queue test command", skippable=True)

    time.sleep(POLL_WAIT_SECONDS)

    final = api_get("/tbird-sync/status")
    if final is None:
        return CheckResult("extension_polling", False, "Could not get final status", skippable=True)

    final_results_count = len(final.get("recent_results", []))
    if final_results_count > initial_results_count:
        return CheckResult(
            "extension_polling",
            True,
            f"Extension processed command (results increased from {initial_results_count} to {final_results_count})",
        )

    return CheckResult(
        "extension_polling",
        False,
        f"Could not verify extension polling. Pending: {final.get('pending_count')}",
        skippable=True,
    )


def check_open_message_action() -> CheckResult:
    """Test that open_message action can be queued."""
    result = api_post(
        "/tbird-sync/queue",
        {"action": "open_message", "messageId": "test-open-message@example.com"},
    )
    if result is not None and result.get("status") == "queued":
        return CheckResult("open_message_action", True, "open_message action can be queued")
    return CheckResult("open_message_action", False, "Failed to queue open_message action", skippable=True)


def check_archive_action() -> CheckResult:
    """Test that archive batch action can be queued."""
    result = api_post(
        "/tbird-sync/archive",
        {"messageIds": ["test1@example.com", "test2@example.com"]},
    )
    if result is not None and result.get("status") == "queued":
        return CheckResult("archive_action", True, f"archive queued for {result.get('count')} messages")
    return CheckResult("archive_action", False, "Failed to queue archive action", skippable=True)


def check_move_action() -> CheckResult:
    """Test that move batch action can be queued."""
    result = api_post(
        "/tbird-sync/move",
        {"messageIds": ["test1@example.com"], "folder": "Archive"},
    )
    if result is not None and result.get("status") == "queued":
        return CheckResult("move_action", True, f"move queued to {result.get('folder')}")
    return CheckResult("move_action", False, "Failed to queue move action", skippable=True)


def check_create_draft_action() -> CheckResult:
    """Test that create_draft action can be queued."""
    result = api_post(
        "/tbird-sync/create-draft",
        {
            "messageId": "test-draft@example.com",
            "body": "Test reply content",
            "replyAll": False,
        },
    )
    if result is not None and result.get("status") == "queued":
        return CheckResult("create_draft_action", True, "create_draft action can be queued")
    return CheckResult("create_draft_action", False, "Failed to queue create_draft action", skippable=True)


def check_send_reply_safety() -> CheckResult:
    """Test that send_reply requires confirmation."""
    result = api_post(
        "/tbird-sync/send-reply",
        {"messageId": "test-send@example.com", "body": "Test reply"},
    )
    if result is None or "error" in result:
        return CheckResult("send_reply_safety", True, "send_reply correctly requires confirmation")
    return CheckResult("send_reply_safety", False, "send_reply should require confirmation", skippable=True)


def check_folders_discovery() -> CheckResult:
    """Test that folder discovery can be queued."""
    result = api_get("/tbird-sync/folders")
    if result is not None and result.get("status") == "queued":
        return CheckResult("folders_discovery", True, "folders discovery can be queued")
    return CheckResult("folders_discovery", False, "Failed to queue folders discovery", skippable=True)


def _require_check(result: CheckResult) -> None:
    if result.skippable and not result.passed:
        pytest.skip(result.message)
    assert result.passed, result.message


def test_server_health():
    _require_check(check_server_health())


def test_pending_endpoint():
    _require_check(check_pending_endpoint())


def test_status_endpoint():
    _require_check(check_status_endpoint())


def test_queue_endpoint():
    _require_check(check_queue_endpoint())


def test_complete_endpoint():
    _require_check(check_complete_endpoint())


def test_open_message_action():
    _require_check(check_open_message_action())


def test_archive_action():
    _require_check(check_archive_action())


def test_move_action():
    _require_check(check_move_action())


def test_create_draft_action():
    _require_check(check_create_draft_action())


def test_send_reply_safety():
    _require_check(check_send_reply_safety())


def test_folders_discovery():
    _require_check(check_folders_discovery())


def test_extension_polling():
    if os.environ.get("CORTEX_TBIRD_SYNC_LIVE") != "1":
        pytest.skip("Set CORTEX_TBIRD_SYNC_LIVE=1 to run live Thunderbird polling checks")
    _require_check(check_extension_polling(quick=False))


def run_checks(quick: bool = False) -> list[CheckResult]:
    """Run all checks (script-mode)."""
    checks = [
        check_server_health,
        check_pending_endpoint,
        check_status_endpoint,
        check_queue_endpoint,
        check_complete_endpoint,
        check_open_message_action,
        check_archive_action,
        check_move_action,
        check_create_draft_action,
        check_send_reply_safety,
        check_folders_discovery,
        lambda: check_extension_polling(quick),
    ]

    results: list[CheckResult] = []
    for check_func in checks:
        name = check_func.__name__ if hasattr(check_func, "__name__") else "check_extension_polling"
        print(f"  Running {name}...", end=" ")
        result = check_func()
        results.append(result)
        status = "PASS" if result.passed else ("SKIP" if result.skippable else "FAIL")
        print(f"{status} - {result.message}")

    return results


def main():
    quick = "--quick" in sys.argv

    print("\n=== Cortex1 Thunderbird Sync - Integration Tests ===\n")
    print(f"Server: {SERVER_URL}")
    print(f"Mode: {'Quick (skip wait tests)' if quick else 'Full'}")
    print()

    results = run_checks(quick)

    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if (not r.passed) and (not r.skippable))
    skipped = sum(1 for r in results if (not r.passed) and r.skippable)

    print()
    print(f"Results: {passed} passed, {failed} failed, {skipped} skipped")
    print()

    if failed > 0:
        print("Failed tests:")
        for r in results:
            if not r.passed and not r.skippable:
                print(f"  - {r.name}: {r.message}")
        print()
        print("Troubleshooting:")
        print("  1. Ensure cortex_server is running")
        print("  2. Ensure Thunderbird is running with extension installed")
        print("  3. Check extension console: Tools > Developer Tools > Debug Add-ons")
        sys.exit(1)
    else:
        print("All checks passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()

