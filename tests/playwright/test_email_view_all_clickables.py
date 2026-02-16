from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from email_view_clickables_helpers import (  # noqa: E402
    SignalCollector,
    collect_clickable_inventory,
    collect_dead_clicks,
    ensure_email_view_open,
    inject_dead_click_detector,
    install_destructive_route_guard,
    inventory_snapshot_payload,
    load_smoke_config,
    probe_clickable,
    read_snapshot,
    reset_dead_clicks,
    to_failure_slug,
    utc_timestamp,
    write_json,
    write_snapshot,
)


def _safe_rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def test_email_view_all_clickables_smoke() -> None:
    playwright_api = pytest.importorskip("playwright.sync_api")
    sync_playwright = playwright_api.sync_playwright

    repo_root = Path(__file__).resolve().parents[2]
    config = load_smoke_config(repo_root)

    if not config.base_url:
        pytest.skip("Set EMAIL_VIEW_BASE_URL to run email view clickable smoke test.")

    config.artifact_dir.mkdir(parents=True, exist_ok=True)
    report_path = config.artifact_dir / "email_view_clickables_report.json"

    failure_messages: list[str] = []
    results: list[dict[str, Any]] = []
    dead_click_events: list[dict[str, Any]] = []
    snapshot_status = {"matched": True, "updated": False, "details": ""}
    baseline_inventory: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=config.headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        if config.mock_destructive:
            install_destructive_route_guard(page, config.destructive_route_patterns)

        signal_collector = SignalCollector(page)
        signal_collector.install()

        try:
            ensure_email_view_open(page, config)

            # Inject the dead-click detector so the Codex heavy test also
            # asserts "no dead clicks" — shared helpers with the tripwire.
            inject_dead_click_detector(
                page,
                repo_root,
                container_selector=config.container_selector,
            )

            baseline_inventory = collect_clickable_inventory(page, config.container_selector)
            if not baseline_inventory:
                pytest.fail("No clickable controls detected in the email view container.")

            current_snapshot = inventory_snapshot_payload(baseline_inventory)
            expected_snapshot = read_snapshot(config.snapshot_path)
            if current_snapshot != expected_snapshot:
                if config.update_snapshot:
                    write_snapshot(config.snapshot_path, current_snapshot)
                    snapshot_status = {"matched": True, "updated": True, "details": "Snapshot updated from live inventory."}
                else:
                    snapshot_status = {
                        "matched": False,
                        "updated": False,
                        "details": (
                            "Inventory snapshot mismatch. Run with EMAIL_VIEW_UPDATE_SNAPSHOT=1 after "
                            "reviewing control changes."
                        ),
                    }
                    failure_messages.append(snapshot_status["details"])

            for index, baseline_control in enumerate(baseline_inventory, start=1):
                ensure_email_view_open(page, config)
                reset_dead_clicks(page)
                live_inventory = collect_clickable_inventory(page, config.container_selector)
                live_control = next(
                    (control for control in live_inventory if control["controlId"] == baseline_control["controlId"]),
                    None,
                )

                if live_control is None:
                    message = f"Control disappeared before probe: {baseline_control['controlId']}"
                    failure_messages.append(message)
                    results.append(
                        {
                            "index": index,
                            "controlId": baseline_control["controlId"],
                            "metadata": baseline_control,
                            "passed": False,
                            "reason": "control_missing_before_click",
                            "signals": {},
                            "screenshot": None,
                        }
                    )
                    continue

                probe = probe_clickable(page, live_control, signal_collector, config)
                screenshot_rel = None
                if not probe["passed"]:
                    slug = to_failure_slug(live_control, index)
                    screenshot_path = config.artifact_dir / f"failure_{index:03d}_{slug}.png"
                    page.screenshot(path=str(screenshot_path), full_page=True)
                    screenshot_rel = _safe_rel(screenshot_path, repo_root)
                    failure_messages.append(
                        f"{live_control['controlId']} ({slug}) failed: {probe['reason']}"
                    )

                results.append(
                    {
                        "index": index,
                        "controlId": live_control["controlId"],
                        "metadata": live_control,
                        "passed": probe["passed"],
                        "reason": probe["reason"],
                        "before": probe["before"],
                        "after": probe["after"],
                        "signals": probe["signals"],
                        "errors": probe["errors"],
                        "screenshot": screenshot_rel,
                    }
                )

                # Collect dead clicks recorded during this probe.
                probe_dead = collect_dead_clicks(page)
                if probe_dead:
                    dead_click_events.extend(probe_dead)

                for popup in list(signal_collector.popups):
                    try:
                        if not popup.is_closed():
                            popup.close()
                    except Exception:  # noqa: BLE001
                        pass

            # Summarise dead-click regressions across all probes.
            if dead_click_events:
                for dc in dead_click_events:
                    tid = dc.get("testId") or dc.get("accessibleName") or "unknown"
                    failure_messages.append(f"Dead click detected on: {tid}")
        finally:
            signal_collector.dispose()
            context.close()
            browser.close()

    report_payload = {
        "generated_at_utc": utc_timestamp(),
        "base_url": config.base_url,
        "container_selector": config.container_selector,
        "snapshot": snapshot_status,
        "inventory_count": len(baseline_inventory),
        "controls": results,
        "dead_clicks": dead_click_events,
    }
    write_json(report_path, report_payload)

    if failure_messages:
        failure_lines = "\n".join(f"- {message}" for message in failure_messages)
        pytest.fail(
            "Email view clickable smoke test found regressions.\n"
            f"Report: {_safe_rel(report_path, repo_root)}\n"
            f"{failure_lines}"
        )
