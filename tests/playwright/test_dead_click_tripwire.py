"""
Dead-click tripwire test — fast CI gate.

Complementary to test_email_view_all_clickables.py (Codex "inventory + probe
everything" test).  This test is **focused and fast**: it injects the
DeadClickDetector into the email view, performs a handful of *representative*
clicks (reply, forward, attachment, menu toggles), and asserts that zero dead
clicks were recorded.

Environment variables:
    EMAIL_VIEW_BASE_URL       – target email app URL (required, else skipped).
    EMAIL_VIEW_*              – all vars from email_view_clickables_helpers.
    DEAD_CLICK_OBSERVE_MS     – observation window override (default 750).
    DEAD_CLICK_DEV_MODE       – "1" to enable dev toasts during test.
    DEAD_CLICK_REPRESENTATIVE – comma-separated data-testid values to click.
                                Defaults to a sensible set for a typical email view.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest

THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parents[1]

if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from email_view_clickables_helpers import (  # noqa: E402
    SignalCollector,
    ensure_email_view_open,
    install_destructive_route_guard,
    load_smoke_config,
    write_json,
    utc_timestamp,
)

# ---------------------------------------------------------------------------
# Defaults for representative controls (data-testid values)
# ---------------------------------------------------------------------------
DEFAULT_REPRESENTATIVE_TESTIDS = (
    "btn-reply,"
    "btn-reply-all,"
    "btn-forward,"
    "btn-archive,"
    "btn-delete,"
    "btn-more-actions,"
    "btn-mark-unread,"
    "btn-attachment-open,"
    "btn-toggle-details"
)


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _read_detector_source() -> str:
    """Read dead_click_detector.js source for page injection."""
    detector_path = REPO_ROOT / "dead_click_detector.js"
    if not detector_path.exists():
        pytest.fail(f"dead_click_detector.js not found at {detector_path}")
    return detector_path.read_text(encoding="utf-8")


def _representative_testids() -> list[str]:
    raw = os.getenv("DEAD_CLICK_REPRESENTATIVE", DEFAULT_REPRESENTATIVE_TESTIDS)
    return [tid.strip() for tid in raw.split(",") if tid.strip()]


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

def test_dead_click_tripwire() -> None:
    """Open email view, click representative controls, assert zero dead clicks."""
    playwright_api = pytest.importorskip("playwright.sync_api")
    sync_playwright = playwright_api.sync_playwright

    config = load_smoke_config(REPO_ROOT)
    if not config.base_url:
        pytest.skip("Set EMAIL_VIEW_BASE_URL to run dead-click tripwire test.")

    observe_ms = int(os.getenv("DEAD_CLICK_OBSERVE_MS", "750"))
    dev_mode = _env_bool("DEAD_CLICK_DEV_MODE", False)
    detector_source = _read_detector_source()
    representative = _representative_testids()

    artifact_dir = config.artifact_dir.parent / "dead_click_tripwire"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    dead_clicks: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=config.headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        if config.mock_destructive:
            install_destructive_route_guard(page, config.destructive_route_patterns)

        signal_collector = SignalCollector(page)
        signal_collector.install()

        try:
            # 1. Navigate to email view
            ensure_email_view_open(page, config)

            # 2. Inject dead-click detector
            page.evaluate(detector_source)
            page.evaluate(
                """
                (opts) => {
                    const container = document.querySelector(opts.containerSelector) || document.body;
                    DeadClickDetector.install(document.body, {
                        container: container,
                        devMode: opts.devMode,
                        observeMs: opts.observeMs
                    });
                }
                """,
                {
                    "containerSelector": config.container_selector,
                    "devMode": dev_mode,
                    "observeMs": observe_ms,
                },
            )

            # 3. Click each representative control (if present)
            for testid in representative:
                selector = f"[data-testid='{testid}']"
                locator = page.locator(selector)

                if locator.count() == 0:
                    results.append({
                        "testid": testid,
                        "status": "not_found",
                        "note": "Control not present in current view — skipped.",
                    })
                    continue

                try:
                    locator.first.scroll_into_view_if_needed(timeout=config.action_timeout_ms)
                    locator.first.click(timeout=config.action_timeout_ms)
                except Exception as exc:  # noqa: BLE001
                    results.append({
                        "testid": testid,
                        "status": "click_failed",
                        "error": str(exc),
                    })
                    # Re-navigate to email view for next control
                    ensure_email_view_open(page, config)
                    # Re-inject detector after navigation
                    page.evaluate(detector_source)
                    page.evaluate(
                        """
                        (opts) => {
                            const container = document.querySelector(opts.containerSelector) || document.body;
                            DeadClickDetector.install(document.body, {
                                container: container,
                                devMode: opts.devMode,
                                observeMs: opts.observeMs
                            });
                        }
                        """,
                        {
                            "containerSelector": config.container_selector,
                            "devMode": dev_mode,
                            "observeMs": observe_ms,
                        },
                    )
                    continue

                # Wait for observation window to complete
                page.wait_for_timeout(observe_ms + 200)

                results.append({
                    "testid": testid,
                    "status": "clicked",
                })

                # Re-navigate for next control (so each starts from clean state)
                ensure_email_view_open(page, config)
                # Carry over dead-click events before re-injecting
                current_events = page.evaluate("() => Array.isArray(window.__deadClicks) ? window.__deadClicks.slice() : []")
                dead_clicks.extend(current_events)

                # Re-inject detector
                page.evaluate(detector_source)
                page.evaluate(
                    """
                    (opts) => {
                        const container = document.querySelector(opts.containerSelector) || document.body;
                        DeadClickDetector.install(document.body, {
                            container: container,
                            devMode: opts.devMode,
                            observeMs: opts.observeMs
                        });
                    }
                    """,
                    {
                        "containerSelector": config.container_selector,
                        "devMode": dev_mode,
                        "observeMs": observe_ms,
                    },
                )

            # Collect any remaining dead clicks
            final_events = page.evaluate("() => Array.isArray(window.__deadClicks) ? window.__deadClicks.slice() : []")
            dead_clicks.extend(final_events)

        finally:
            signal_collector.dispose()
            context.close()
            browser.close()

    # De-duplicate events by timestamp
    seen_ts: set[int] = set()
    unique_dead: list[dict[str, Any]] = []
    for evt in dead_clicks:
        ts = evt.get("ts", 0)
        if ts not in seen_ts:
            seen_ts.add(ts)
            unique_dead.append(evt)

    # Write report
    report = {
        "generated_at_utc": utc_timestamp(),
        "base_url": config.base_url,
        "observe_ms": observe_ms,
        "representative_testids": representative,
        "click_results": results,
        "dead_click_count": len(unique_dead),
        "dead_clicks": unique_dead,
    }
    write_json(artifact_dir / "dead_click_tripwire_report.json", report)

    # Assert zero dead clicks
    if unique_dead:
        labels = []
        for evt in unique_dead:
            c = evt.get("control", {})
            label = c.get("testId") or c.get("accessibleName") or c.get("tag") or "unknown"
            labels.append(f"  - {evt.get('type', 'dead_click')}: {label} @ {evt.get('route', '?')}")
        detail = "\n".join(labels)
        pytest.fail(
            f"Dead-click tripwire tripped: {len(unique_dead)} dead click(s) detected.\n"
            f"Report: tests/artifacts/dead_click_tripwire/dead_click_tripwire_report.json\n"
            f"{detail}"
        )
