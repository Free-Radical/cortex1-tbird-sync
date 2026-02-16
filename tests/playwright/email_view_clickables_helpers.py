from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


INTERACTIVE_SELECTORS = (
    "button, a[href], [role='button'], [role='menuitem'], [role='tab'], [onclick], [tabindex]"
)


@dataclass(frozen=True)
class SmokeConfig:
    base_url: str
    list_path: str
    container_selector: str
    message_row_selector: str
    subject_selector: str
    body_selector: str
    target_subject: str | None
    artifact_dir: Path
    snapshot_path: Path
    mutation_threshold: int
    action_timeout_ms: int
    settle_ms: int
    update_snapshot: bool
    headless: bool
    mock_destructive: bool
    destructive_route_patterns: tuple[str, ...]


class SignalCollector:
    def __init__(self, page: Any, max_console: int = 20) -> None:
        self.page = page
        self.max_console = max_console
        self.console_errors: list[dict[str, str]] = []
        self.page_errors: list[str] = []
        self.dialogs: list[dict[str, str]] = []
        self.popups: list[Any] = []
        self.downloads: list[dict[str, str]] = []
        self.requests = 0
        self.responses = 0

        self._handlers: dict[str, Any] = {
            "console": self._on_console,
            "pageerror": self._on_pageerror,
            "dialog": self._on_dialog,
            "popup": self._on_popup,
            "download": self._on_download,
            "request": self._on_request,
            "response": self._on_response,
        }

    def install(self) -> None:
        for event_name, handler in self._handlers.items():
            self.page.on(event_name, handler)

    def dispose(self) -> None:
        for event_name, handler in self._handlers.items():
            self.page.remove_listener(event_name, handler)

    def mark(self) -> dict[str, int]:
        return {
            "requests": self.requests,
            "responses": self.responses,
            "dialogs": len(self.dialogs),
            "popups": len(self.popups),
            "downloads": len(self.downloads),
            "console_errors": len(self.console_errors),
            "page_errors": len(self.page_errors),
        }

    def diff(self, mark: dict[str, int]) -> dict[str, Any]:
        popup_pages = self.popups[mark["popups"] :]
        popup_urls = [popup.url or "" for popup in popup_pages]

        return {
            "requests": self.requests - mark["requests"],
            "responses": self.responses - mark["responses"],
            "dialogs": self.dialogs[mark["dialogs"] :],
            "popup_urls": popup_urls,
            "downloads": self.downloads[mark["downloads"] :],
            "console_errors": self.console_errors[mark["console_errors"] :],
            "page_errors": self.page_errors[mark["page_errors"] :],
        }

    def recent_errors(self, limit: int = 5) -> dict[str, Any]:
        return {
            "console_errors": self.console_errors[-limit:],
            "page_errors": self.page_errors[-limit:],
        }

    def _append_limited(self, values: list[Any], item: Any) -> None:
        values.append(item)
        if len(values) > self.max_console:
            del values[0 : len(values) - self.max_console]

    def _on_console(self, msg: Any) -> None:
        msg_type = msg.type
        if msg_type != "error":
            return
        self._append_limited(
            self.console_errors,
            {
                "type": msg_type,
                "text": msg.text,
                "location": json.dumps(msg.location or {}, sort_keys=True),
            },
        )

    def _on_pageerror(self, error: Any) -> None:
        self._append_limited(self.page_errors, str(error))

    def _on_dialog(self, dialog: Any) -> None:
        self.dialogs.append({"type": dialog.type, "message": dialog.message})
        if dialog.type == "beforeunload":
            dialog.accept()
            return
        dialog.dismiss()

    def _on_popup(self, popup: Any) -> None:
        self.popups.append(popup)

    def _on_download(self, download: Any) -> None:
        self.downloads.append(
            {
                "url": download.url,
                "suggested_filename": download.suggested_filename,
            }
        )

    def _on_request(self, request: Any) -> None:
        self.requests += 1

    def _on_response(self, response: Any) -> None:
        self.responses += 1


def load_smoke_config(repo_root: Path) -> SmokeConfig:
    base_url = os.getenv("EMAIL_VIEW_BASE_URL", "").strip()
    list_path = os.getenv("EMAIL_VIEW_LIST_PATH", "/mail")

    artifact_dir_env = os.getenv(
        "EMAIL_VIEW_ARTIFACT_DIR",
        str(repo_root / "tests" / "artifacts" / "playwright" / "email_view_smoke"),
    )
    artifact_dir = Path(artifact_dir_env)

    snapshot_path_env = os.getenv(
        "EMAIL_VIEW_SNAPSHOT_PATH",
        str(repo_root / "tests" / "playwright" / "snapshots" / "email_view_clickables_snapshot.json"),
    )
    snapshot_path = Path(snapshot_path_env)

    return SmokeConfig(
        base_url=base_url,
        list_path=list_path,
        container_selector=os.getenv(
            "EMAIL_VIEW_CONTAINER_SELECTOR",
            "[data-testid='email-view'], [data-testid='message-view'], main",
        ),
        message_row_selector=os.getenv(
            "EMAIL_VIEW_MESSAGE_ROW_SELECTOR",
            "[data-testid='email-list-item'], [role='row'][data-message-id], [role='listitem']",
        ),
        subject_selector=os.getenv(
            "EMAIL_VIEW_SUBJECT_SELECTOR",
            "[data-testid='email-subject'], [data-testid='message-subject'], h1, [role='heading']",
        ),
        body_selector=os.getenv(
            "EMAIL_VIEW_BODY_SELECTOR",
            "[data-testid='email-body'], [data-testid='message-body'], article",
        ),
        target_subject=os.getenv("EMAIL_VIEW_TARGET_SUBJECT") or None,
        artifact_dir=artifact_dir,
        snapshot_path=snapshot_path,
        mutation_threshold=int(os.getenv("EMAIL_VIEW_MUTATION_THRESHOLD", "2")),
        action_timeout_ms=int(os.getenv("EMAIL_VIEW_ACTION_TIMEOUT_MS", "2500")),
        settle_ms=int(os.getenv("EMAIL_VIEW_SETTLE_MS", "900")),
        update_snapshot=_env_bool("EMAIL_VIEW_UPDATE_SNAPSHOT", False),
        headless=_env_bool("EMAIL_VIEW_HEADLESS", True),
        mock_destructive=_env_bool("EMAIL_VIEW_MOCK_DESTRUCTIVE", True),
        destructive_route_patterns=tuple(
            pattern.strip().lower()
            for pattern in os.getenv(
                "EMAIL_VIEW_DESTRUCTIVE_PATTERNS",
                "/delete,/archive,/trash,/spam,/junk,/send,/move",
            ).split(",")
            if pattern.strip()
        ),
    )


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def build_absolute_url(base_url: str, path: str) -> str:
    if not path:
        return base_url
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def ensure_email_view_open(page: Any, config: SmokeConfig) -> None:
    entry_url = build_absolute_url(config.base_url, config.list_path)
    page.goto(entry_url, wait_until="domcontentloaded", timeout=30000)

    rows = page.locator(config.message_row_selector)
    rows.first.wait_for(state="visible", timeout=20000)

    if config.target_subject:
        row = rows.filter(has_text=config.target_subject).first
    else:
        row = rows.first

    row.wait_for(state="visible", timeout=15000)
    row.click(timeout=config.action_timeout_ms)

    page.locator(config.subject_selector).first.wait_for(state="visible", timeout=20000)
    page.locator(config.body_selector).first.wait_for(state="visible", timeout=20000)
    page.locator(config.container_selector).first.wait_for(state="visible", timeout=20000)


def collect_clickable_inventory(page: Any, container_selector: str) -> list[dict[str, Any]]:
    payload = page.evaluate(
        """
        ({ containerSelector, interactiveSelectors }) => {
          const container = document.querySelector(containerSelector);
          if (!container) {
            return { error: `Container not found: ${containerSelector}`, items: [] };
          }

          document.querySelectorAll('[data-click-probe-id]').forEach((el) => el.removeAttribute('data-click-probe-id'));

          const selectors = interactiveSelectors.split(',').map((s) => s.trim()).filter(Boolean);
          const query = selectors.join(',');
          const nodes = Array.from(container.querySelectorAll(query));

          const candidateMatcher = [
            ['button', (el) => el.matches('button')],
            ['link', (el) => el.matches('a[href]')],
            ['role=button', (el) => el.getAttribute('role') === 'button'],
            ['role=menuitem', (el) => el.getAttribute('role') === 'menuitem'],
            ['role=tab', (el) => el.getAttribute('role') === 'tab'],
            ['onclick', (el) => el.hasAttribute('onclick')],
            ['tabindex>=0', (el) => el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0],
          ];

          const canonicalSelector = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [onclick], [tabindex]';
          const seen = new Set();
          const items = [];

          const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();

          const getAriaName = (el) => {
            const ariaLabel = normalize(el.getAttribute('aria-label'));
            if (ariaLabel) return ariaLabel;

            const labelledBy = normalize(el.getAttribute('aria-labelledby'));
            if (labelledBy) {
              const parts = labelledBy
                .split(/\\s+/)
                .map((id) => document.getElementById(id))
                .filter(Boolean)
                .map((node) => normalize(node.innerText || node.textContent || ''))
                .filter(Boolean);
              if (parts.length) return normalize(parts.join(' '));
            }

            return normalize(el.innerText || el.textContent || '');
          };

          const isVisible = (el) => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const inViewport = rect.bottom > 0 && rect.right > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
            return inViewport;
          };

          const isEnabled = (el) => {
            if (el.getAttribute('aria-disabled') === 'true') return false;
            if (typeof el.disabled === 'boolean' && el.disabled) return false;
            if (el.matches(':disabled')) return false;
            return true;
          };

          const isInteractiveByTabIndex = (el) => {
            if (!(el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0)) return false;
            const role = normalize(el.getAttribute('role')).toLowerCase();
            if (role === 'button' || role === 'menuitem' || role === 'tab') return true;
            if (el.hasAttribute('onclick')) return true;
            const tag = el.tagName.toLowerCase();
            if (tag === 'button' || tag === 'a' || tag === 'summary') return true;
            const cursor = window.getComputedStyle(el).cursor;
            return cursor === 'pointer';
          };

          const isNotCovered = (el) => {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const top = document.elementFromPoint(cx, cy);
            if (!top) return false;
            return top === el || el.contains(top) || top.contains(el);
          };

          for (const node of nodes) {
            const el = node.closest(canonicalSelector) || node;
            if (!el || seen.has(el)) continue;

            const matches = candidateMatcher
              .filter(([, matcher]) => matcher(el))
              .map(([name]) => name);
            if (!matches.length) continue;

            if (!isInteractiveByTabIndex(el) && matches.length === 1 && matches[0] === 'tabindex>=0') {
              continue;
            }

            if (!isVisible(el) || !isEnabled(el) || !isNotCovered(el)) {
              continue;
            }

            seen.add(el);

            const rect = el.getBoundingClientRect();
            const tagName = (el.tagName || '').toLowerCase();
            const role = normalize(el.getAttribute('role'));
            const href = normalize(el.getAttribute('href'));
            const dataTestId = normalize(el.getAttribute('data-testid'));
            const innerText = normalize(el.innerText || el.textContent || '');
            const accessibleName = getAriaName(el);
            const probeId = `probe-${String(items.length + 1).padStart(3, '0')}`;
            el.setAttribute('data-click-probe-id', probeId);

            items.push({
              probeId,
              detection: matches,
              tagName,
              role,
              accessibleName,
              innerText,
              href,
              dataTestId,
              ariaExpanded: normalize(el.getAttribute('aria-expanded')),
              ariaPressed: normalize(el.getAttribute('aria-pressed')),
              ariaHasPopup: normalize(el.getAttribute('aria-haspopup')),
              disabled: !isEnabled(el),
              boundingBox: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            });
          }

          return { error: null, items };
        }
        """,
        {
            "containerSelector": container_selector,
            "interactiveSelectors": INTERACTIVE_SELECTORS,
        },
    )

    if payload.get("error"):
        raise AssertionError(payload["error"])

    inventory = payload.get("items") or []
    assign_control_ids(inventory)
    return inventory


def assign_control_ids(inventory: list[dict[str, Any]]) -> None:
    occurrences: dict[str, int] = {}
    for item in inventory:
        fingerprint = control_fingerprint(item)
        index = occurrences.get(fingerprint, 0)
        item["fingerprint"] = fingerprint
        item["controlOrdinal"] = index
        item["controlId"] = f"{fingerprint}:{index}"
        occurrences[fingerprint] = index + 1


def control_fingerprint(item: dict[str, Any]) -> str:
    normalized = "|".join(
        [
            _normalize_text(item.get("tagName")),
            _normalize_text(item.get("role")),
            _normalize_text(item.get("accessibleName")),
            _normalize_text(item.get("innerText")),
            _normalize_href(item.get("href")),
            _normalize_text(item.get("dataTestId")),
        ]
    )
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]
    return digest


def inventory_snapshot_payload(inventory: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": 1,
        "controls": [
            {
                "controlId": item["controlId"],
                "tagName": _normalize_text(item.get("tagName")),
                "role": _normalize_text(item.get("role")),
                "accessibleName": _normalize_text(item.get("accessibleName")),
                "innerText": _normalize_text(item.get("innerText")),
                "href": _normalize_href(item.get("href")),
                "dataTestId": _normalize_text(item.get("dataTestId")),
                "detection": list(item.get("detection") or []),
            }
            for item in inventory
        ],
    }


def read_snapshot(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "controls": []}
    return json.loads(path.read_text(encoding="utf-8"))


def write_snapshot(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def install_destructive_route_guard(page: Any, patterns: tuple[str, ...]) -> None:
    if not patterns:
        return

    def _route_handler(route: Any, request: Any) -> None:
        method = request.method.upper()
        url = request.url.lower()
        if method in {"POST", "PUT", "PATCH", "DELETE"} and any(pattern in url for pattern in patterns):
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"status":"mocked-by-email-view-smoke"}',
            )
            return
        route.continue_()

    page.route("**/*", _route_handler)


def capture_surface_counts(page: Any) -> dict[str, int]:
    return {
        "dialogs": page.locator("dialog,[role='dialog'],[aria-modal='true']").count(),
        "menus": page.locator("[role='menu'],[role='listbox']").count(),
        "toasts": page.locator("[role='alert'],[aria-live='polite'],[aria-live='assertive'],[data-testid*='toast']").count(),
    }


def start_dom_mutation_probe(page: Any, container_selector: str) -> None:
    page.evaluate(
        """
        (selector) => {
          if (window.__emailViewMutationProbe && window.__emailViewMutationProbe.observer) {
            window.__emailViewMutationProbe.observer.disconnect();
          }

          const target = document.querySelector(selector) || document.body;
          const probe = { count: 0, observer: null };
          probe.observer = new MutationObserver((mutations) => {
            probe.count += mutations.length;
          });
          probe.observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
          window.__emailViewMutationProbe = probe;
        }
        """,
        container_selector,
    )


def stop_dom_mutation_probe(page: Any) -> int:
    return int(
        page.evaluate(
            """
            () => {
              const probe = window.__emailViewMutationProbe;
              if (!probe) return 0;
              if (probe.observer) probe.observer.disconnect();
              const count = Number(probe.count || 0);
              delete window.__emailViewMutationProbe;
              return count;
            }
            """
        )
    )


def probe_clickable(
    page: Any,
    control: dict[str, Any],
    signal_collector: SignalCollector,
    config: SmokeConfig,
) -> dict[str, Any]:
    selector = f"[data-click-probe-id='{control['probeId']}']"
    locator = page.locator(selector)
    if locator.count() == 0:
        return {
            "passed": False,
            "reason": "control_not_found_before_click",
            "signals": {},
            "before": {},
            "after": {},
            "errors": signal_collector.recent_errors(),
        }

    locator.first.scroll_into_view_if_needed(timeout=config.action_timeout_ms)

    before_surface = capture_surface_counts(page)
    before_url = page.url
    before_pressed = (locator.first.get_attribute("aria-pressed") or "").strip().lower()
    before_expanded = (locator.first.get_attribute("aria-expanded") or "").strip().lower()

    mark = signal_collector.mark()
    start_dom_mutation_probe(page, config.container_selector)

    click_error = ""
    try:
        locator.first.click(timeout=config.action_timeout_ms)
    except Exception as exc:  # noqa: BLE001
        click_error = str(exc)

    page.wait_for_timeout(config.settle_ms)

    dom_mutations = stop_dom_mutation_probe(page)
    signal_diff = signal_collector.diff(mark)

    after_surface = capture_surface_counts(page)
    after_url = page.url

    after_pressed = ""
    after_expanded = ""
    if locator.count() > 0:
        after_pressed = (locator.first.get_attribute("aria-pressed") or "").strip().lower()
        after_expanded = (locator.first.get_attribute("aria-expanded") or "").strip().lower()

    url_changed = after_url != before_url
    popup_opened = any(url.strip() for url in signal_diff["popup_urls"])
    download_started = bool(signal_diff["downloads"])
    toggled = (before_pressed != after_pressed) or (before_expanded != after_expanded)
    surface_changed = (
        after_surface["dialogs"] > before_surface["dialogs"]
        or after_surface["menus"] > before_surface["menus"]
        or after_surface["toasts"] > before_surface["toasts"]
    )
    network_activity = signal_diff["requests"] > 0 or signal_diff["responses"] > 0
    dom_changed = dom_mutations > config.mutation_threshold
    network_plus_ui = network_activity and (surface_changed or toggled or dom_changed)

    signals = {
        "url_changed": url_changed,
        "popup_opened": popup_opened,
        "download_started": download_started,
        "aria_toggled": toggled,
        "surface_changed": surface_changed,
        "network_activity": network_activity,
        "network_plus_ui": network_plus_ui,
        "dom_mutations": dom_mutations,
        "requests": signal_diff["requests"],
        "responses": signal_diff["responses"],
        "popup_urls": signal_diff["popup_urls"],
        "downloads": signal_diff["downloads"],
        "dialogs": signal_diff["dialogs"],
        "console_errors": signal_diff["console_errors"],
        "page_errors": signal_diff["page_errors"],
        "click_error": click_error,
    }

    passed = (
        not click_error
        and (
            url_changed
            or popup_opened
            or download_started
            or toggled
            or surface_changed
            or network_plus_ui
            or dom_changed
        )
    )

    if click_error:
        reason = "click_failed"
    elif not passed:
        reason = "no_op_click_regression"
    else:
        reason = "ok"

    return {
        "passed": passed,
        "reason": reason,
        "signals": signals,
        "before": {
            "url": before_url,
            "aria_pressed": before_pressed,
            "aria_expanded": before_expanded,
            "surface": before_surface,
        },
        "after": {
            "url": after_url,
            "aria_pressed": after_pressed,
            "aria_expanded": after_expanded,
            "surface": after_surface,
        },
        "errors": signal_collector.recent_errors(),
    }


def to_failure_slug(control: dict[str, Any], fallback_index: int) -> str:
    label_parts = [
        control.get("dataTestId") or "",
        control.get("accessibleName") or "",
        control.get("innerText") or "",
        control.get("tagName") or "",
    ]
    raw_label = "-".join(part for part in label_parts if part).strip() or f"control-{fallback_index}"
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", raw_label).strip("-").lower()
    return slug[:80] if slug else f"control-{fallback_index}"


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _normalize_href(href: Any) -> str:
    value = str(href or "").strip()
    if not value:
        return ""
    value = re.sub(r"https?://[^/]+", "", value, flags=re.IGNORECASE)
    return _normalize_text(value)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# =============================================================================
# Dead-click detector integration helpers (shared by tripwire + heavy test)
# =============================================================================

_DETECTOR_SOURCE_CACHE: str | None = None


def _read_detector_source(repo_root: Path) -> str:
    """Read dead_click_detector.js source for page injection (cached)."""
    global _DETECTOR_SOURCE_CACHE  # noqa: PLW0603
    if _DETECTOR_SOURCE_CACHE is None:
        path = repo_root / "dead_click_detector.js"
        if not path.exists():
            raise FileNotFoundError(f"dead_click_detector.js not found at {path}")
        _DETECTOR_SOURCE_CACHE = path.read_text(encoding="utf-8")
    return _DETECTOR_SOURCE_CACHE


def inject_dead_click_detector(
    page: Any,
    repo_root: Path,
    container_selector: str = "[data-testid='email-view'], [data-testid='message-view'], main",
    observe_ms: int = 750,
    dev_mode: bool = False,
) -> None:
    """Inject the DeadClickDetector into the page and install it.

    After calling this, ``window.__deadClicks`` is a live array and
    ``window.__deadClickDetector`` exposes the detector API.
    """
    source = _read_detector_source(repo_root)
    page.evaluate(source)
    page.evaluate(
        """
        (opts) => {
            if (typeof DeadClickDetector === 'undefined') return;
            if (DeadClickDetector.isInstalled()) return;
            // Set the debug gate flag — install() is a no-op without it.
            window.__DEAD_CLICK_DEBUG__ = true;
            const container = document.querySelector(opts.containerSelector) || document.body;
            DeadClickDetector.install(document.body, {
                container: container,
                devMode: opts.devMode,
                observeMs: opts.observeMs,
            });
        }
        """,
        {
            "containerSelector": container_selector,
            "devMode": dev_mode,
            "observeMs": observe_ms,
        },
    )


def collect_dead_clicks(page: Any) -> list[dict[str, Any]]:
    """Return the current ``window.__deadClicks`` buffer from the page."""
    return page.evaluate(
        "() => Array.isArray(window.__deadClicks) ? window.__deadClicks.slice() : []"
    )


def reset_dead_clicks(page: Any) -> None:
    """Clear the dead-click buffer in the page."""
    page.evaluate(
        """
        () => {
            if (window.__deadClickDetector && typeof window.__deadClickDetector.reset === 'function') {
                window.__deadClickDetector.reset();
            }
        }
        """
    )


def assert_no_dead_clicks(
    page: Any,
    *,
    label: str = "dead-click check",
) -> list[dict[str, Any]]:
    """Collect dead clicks and return them.  Useful for test assertions.

    Returns the list (empty on success) so callers can build custom messages.
    Does NOT raise — callers decide how to handle non-empty results.
    """
    return collect_dead_clicks(page)
