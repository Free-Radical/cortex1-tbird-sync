#!/usr/bin/env python3
"""
Integration tests for cortex1-tbird-sync extension.

These tests verify the extension is communicating with cortex_server properly.
Requires:
  - cortex_server running on localhost:5001
  - cortex1-tbird-sync extension installed and active in Thunderbird
  - Thunderbird running

Usage:
  python tests/test_extension.py
  python tests/test_extension.py --quick   # Skip wait tests
"""

import json
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass


SERVER_URL = "http://localhost:5001"
POLL_WAIT_SECONDS = 5  # Time to wait for extension to poll


@dataclass
class TestResult:
    name: str
    passed: bool
    message: str


def api_get(endpoint: str) -> dict | None:
    """Make GET request to server API."""
    try:
        req = urllib.request.Request(f"{SERVER_URL}{endpoint}")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return None


def api_post(endpoint: str, data: dict) -> dict | None:
    """Make POST request to server API."""
    try:
        req = urllib.request.Request(
            f"{SERVER_URL}{endpoint}",
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return None


def test_server_health() -> TestResult:
    """Test that cortex_server is running."""
    try:
        req = urllib.request.Request(f"{SERVER_URL}/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.read().decode() == "OK":
                return TestResult("server_health", True, "Server is running")
    except Exception as e:
        pass
    return TestResult("server_health", False, "Server not responding at localhost:5001")


def test_pending_endpoint() -> TestResult:
    """Test GET /tbird-sync/pending endpoint."""
    result = api_get("/tbird-sync/pending")
    if result is not None and "commands" in result:
        return TestResult("pending_endpoint", True, f"Endpoint working, {len(result['commands'])} pending")
    return TestResult("pending_endpoint", False, "Failed to get pending commands")


def test_status_endpoint() -> TestResult:
    """Test GET /tbird-sync/status endpoint."""
    result = api_get("/tbird-sync/status")
    if result is not None and "pending_count" in result:
        return TestResult("status_endpoint", True, f"Status: {result['pending_count']} pending")
    return TestResult("status_endpoint", False, "Failed to get status")


def test_queue_endpoint() -> TestResult:
    """Test POST /tbird-sync/queue endpoint."""
    result = api_post("/tbird-sync/queue", {
        "action": "mark_read",
        "messageId": "test-queue-endpoint@example.com"
    })
    if result is not None and result.get("status") == "queued":
        return TestResult("queue_endpoint", True, f"Command queued with ID: {result.get('id')}")
    return TestResult("queue_endpoint", False, "Failed to queue command")


def test_complete_endpoint() -> TestResult:
    """Test POST /tbird-sync/complete endpoint."""
    result = api_post("/tbird-sync/complete", {
        "results": [{"id": "test-id", "success": True, "action": "mark_read"}]
    })
    if result is not None and result.get("status") == "ok":
        return TestResult("complete_endpoint", True, "Complete endpoint working")
    return TestResult("complete_endpoint", False, "Failed to post completion")


def test_extension_polling(quick: bool = False) -> TestResult:
    """Test that extension is polling and processing commands.

    Queues a command and waits for extension to process it.
    The command will fail (message doesn't exist) but that's OK -
    we're testing the communication.
    """
    if quick:
        return TestResult("extension_polling", True, "Skipped (--quick mode)")

    # Get initial status
    initial = api_get("/tbird-sync/status")
    if initial is None:
        return TestResult("extension_polling", False, "Could not get initial status")

    initial_results_count = len(initial.get("recent_results", []))

    # Queue a test command
    queue_result = api_post("/tbird-sync/queue", {
        "action": "mark_read",
        "messageId": f"test-polling-{int(time.time())}@example.com"
    })
    if not queue_result or queue_result.get("status") != "queued":
        return TestResult("extension_polling", False, "Failed to queue test command")

    cmd_id = queue_result.get("id")

    # Wait for extension to process
    print(f"    Waiting {POLL_WAIT_SECONDS}s for extension to poll...")
    time.sleep(POLL_WAIT_SECONDS)

    # Check if command was processed
    final = api_get("/tbird-sync/status")
    if final is None:
        return TestResult("extension_polling", False, "Could not get final status")

    final_results_count = len(final.get("recent_results", []))

    # Check if our command appears in results
    recent = final.get("recent_results", [])
    our_result = next((r for r in recent if r.get("id") == cmd_id), None)

    if our_result:
        # Command was processed (success or failure doesn't matter)
        return TestResult("extension_polling", True,
            f"Extension processed command: success={our_result.get('success')}")
    elif final_results_count > initial_results_count:
        return TestResult("extension_polling", True,
            "Extension is processing commands (new results appeared)")
    elif final.get("pending_count", 0) > 0:
        return TestResult("extension_polling", False,
            f"Command still pending - extension may not be active. Pending: {final.get('pending_count')}")
    else:
        return TestResult("extension_polling", False, "Could not verify extension polling")


def test_open_message_action() -> TestResult:
    """Test that open_message action can be queued."""
    result = api_post("/tbird-sync/queue", {
        "action": "open_message",
        "messageId": "test-open-message@example.com"
    })
    if result is not None and result.get("status") == "queued":
        return TestResult("open_message_action", True, "open_message action can be queued")
    return TestResult("open_message_action", False, "Failed to queue open_message action")


def test_archive_action() -> TestResult:
    """Test that archive batch action can be queued."""
    result = api_post("/tbird-sync/archive", {
        "messageIds": ["test1@example.com", "test2@example.com"]
    })
    if result is not None and result.get("status") == "queued":
        return TestResult("archive_action", True, f"archive queued for {result.get('count')} messages")
    return TestResult("archive_action", False, "Failed to queue archive action")


def test_move_action() -> TestResult:
    """Test that move batch action can be queued."""
    result = api_post("/tbird-sync/move", {
        "messageIds": ["test1@example.com"],
        "folder": "Archive"
    })
    if result is not None and result.get("status") == "queued":
        return TestResult("move_action", True, f"move queued to {result.get('folder')}")
    return TestResult("move_action", False, "Failed to queue move action")


def test_create_draft_action() -> TestResult:
    """Test that create_draft action can be queued."""
    result = api_post("/tbird-sync/create-draft", {
        "messageId": "test-draft@example.com",
        "body": "Test reply content",
        "replyAll": False
    })
    if result is not None and result.get("status") == "queued":
        return TestResult("create_draft_action", True, "create_draft action can be queued")
    return TestResult("create_draft_action", False, "Failed to queue create_draft action")


def test_send_reply_safety() -> TestResult:
    """Test that send_reply requires confirmation."""
    # Should fail without confirmed=true
    result = api_post("/tbird-sync/send-reply", {
        "messageId": "test-send@example.com",
        "body": "Test reply"
    })
    if result is None or "error" in result:
        return TestResult("send_reply_safety", True, "send_reply correctly requires confirmation")
    return TestResult("send_reply_safety", False, "send_reply should require confirmation")


def test_folders_discovery() -> TestResult:
    """Test that folder discovery can be queued."""
    result = api_get("/tbird-sync/folders")
    if result is not None and result.get("status") == "queued":
        return TestResult("folders_discovery", True, "folders discovery can be queued")
    return TestResult("folders_discovery", False, "Failed to queue folders discovery")


def run_tests(quick: bool = False) -> list[TestResult]:
    """Run all tests."""
    tests = [
        test_server_health,
        test_pending_endpoint,
        test_status_endpoint,
        test_queue_endpoint,
        test_complete_endpoint,
        test_open_message_action,
        test_archive_action,
        test_move_action,
        test_create_draft_action,
        test_send_reply_safety,
        test_folders_discovery,
        lambda: test_extension_polling(quick),
    ]

    results = []
    for test_func in tests:
        name = test_func.__name__ if hasattr(test_func, '__name__') else "extension_polling"
        print(f"  Running {name}...", end=" ")
        result = test_func()
        results.append(result)
        status = "PASS" if result.passed else "FAIL"
        print(f"{status} - {result.message}")

    return results


def main():
    quick = "--quick" in sys.argv

    print("\n=== Cortex1 Thunderbird Sync - Integration Tests ===\n")
    print(f"Server: {SERVER_URL}")
    print(f"Mode: {'Quick (skip wait tests)' if quick else 'Full'}")
    print()

    results = run_tests(quick)

    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)

    print()
    print(f"Results: {passed} passed, {failed} failed")
    print()

    if failed > 0:
        print("Failed tests:")
        for r in results:
            if not r.passed:
                print(f"  - {r.name}: {r.message}")
        print()
        print("Troubleshooting:")
        print("  1. Ensure cortex_server is running: python scripts/cortex_server.py")
        print("  2. Ensure Thunderbird is running with extension installed")
        print("  3. Check extension console: Tools > Developer Tools > Debug Add-ons")
        sys.exit(1)
    else:
        print("All tests passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()
