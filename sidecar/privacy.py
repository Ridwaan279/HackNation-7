"""Privacy gate (PLAN §6.2–6.3): decide whether a window may be observed at all.

Runs before anything reads a window's content. A blocked window produces a
single `blocked` event with a reason and nothing else.
"""
from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Set, Tuple

from config import ConfigStore
from model import WindowInfo

_SCHEME_SLASHES_RE = re.compile(r"^([a-z][a-z0-9+.\-]*)://(.*)$")
_SCHEME_OPAQUE_RE = re.compile(r"^(about|data|javascript|mailto|view-source|blob):(.*)$")


@dataclass(frozen=True)
class Decision:
    blocked: bool
    reason: Optional[str]  # BlockReason in contracts.ts
    key: str  # lowercase process name, or "browser:<domain>"
    domain: Optional[str] = None


def parse_url(text: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Return (scheme, host) from an address-bar value, or (None, None) if it isn't a URL.

    Chromium hides "https://", so "minierp.local/invoices" is a URL too.
    While the user types a search, the value isn't a URL and we return (None, None).
    """
    if not text:
        return None, None
    s = text.strip().lower()
    if not s or re.search(r"\s", s):
        return None, None
    m = _SCHEME_SLASHES_RE.match(s)
    if m:
        scheme, rest = m.group(1), m.group(2)
    else:
        m2 = _SCHEME_OPAQUE_RE.match(s)
        if m2:
            scheme, rest = m2.group(1), m2.group(2)
        else:
            scheme, rest = None, s
    if scheme == "file":
        return "file", "local-file"
    host = re.split(r"[/?#]", rest, maxsplit=1)[0]
    if "@" in host:
        host = host.rsplit("@", 1)[1]
    if host.startswith("["):  # IPv6 literal
        host = host[1:].split("]", 1)[0]
    elif ":" in host:
        host = host.split(":", 1)[0]
    host = host.strip(".")
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return (scheme, None) if scheme else (None, None)
    if scheme is None or scheme in ("http", "https"):
        if host != "localhost" and "." not in host and not _is_ip(host):
            return None, None
    return scheme, host


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def domain_matches(host: str, pattern: str) -> bool:
    """"mybank.com" and "*.mybank.com" both match mybank.com and its subdomains (fail closed)."""
    p = pattern.strip().lower()
    if p.startswith("*."):
        p = p[2:]
    p = p.strip(".")
    if p.startswith("www."):
        p = p[4:]
    return bool(p) and (host == p or host.endswith("." + p))


def _norm_app(name: str) -> str:
    n = name.strip().lower()
    return n if n.endswith(".exe") or not n else n + ".exe"


class PrivacyGate:
    def __init__(self, config: ConfigStore, own_pids: Iterable[int] = ()):
        self.config = config
        self.own_pids: Set[int] = {p for p in own_pids if p}

    # -- helpers used by the engine ---------------------------------------

    def is_browser(self, win: WindowInfo) -> bool:
        return win.process.lower() in self._lower("browsers")

    def is_remote_session(self, win: WindowInfo) -> bool:
        return win.process.lower() in self._lower("remote_session_processes")

    def private_markers(self) -> List[str]:
        return list(self.config.skiplists.get("private_window_markers", []))

    def _lower(self, list_name: str) -> Set[str]:
        return {x.lower() for x in self.config.skiplists.get(list_name, [])}

    def _title_has(self, title: str, list_name: str) -> bool:
        t = title.lower()
        return any(marker.lower() in t for marker in self.config.skiplists.get(list_name, []))

    # -- the decision --------------------------------------------------------

    def decide(self, win: WindowInfo, url: Optional[str], private_hint: bool, mode: str) -> Decision:
        process = win.process.lower()
        privacy = self.config.privacy
        skip = privacy.get("skip", {})
        browser = self.is_browser(win)
        scheme, host = parse_url(url) if browser else (None, None)
        if browser and host:
            key = f"browser:{host}"
        else:
            key = process
        domain = host if browser else None

        def blocked(reason: str) -> Decision:
            return Decision(True, reason, key, domain)

        if mode == "paused":
            return blocked("paused")
        if win.pid in self.own_pids:
            return blocked("self")
        if process in self._lower("system_processes"):
            return blocked("system")
        if skip.get("password_managers", True):
            if process in self._lower("password_manager_processes"):
                return blocked("password_manager")
            if self._title_has(win.title, "password_manager_title_markers"):
                return blocked("password_manager")
        if browser:
            if scheme in self._lower("browser_internal_schemes") and (host or "") not in self._lower("browser_internal_allowed_hosts"):
                return blocked("system")
            if skip.get("private_windows", True):
                if private_hint or self._title_has(win.title, "private_window_markers"):
                    return blocked("private_window")
            if skip.get("banking", True) and self._is_banking(host, win.title):
                return blocked("banking")

        blocked_apps = {_norm_app(a) for a in privacy.get("blocked_apps", [])}
        if _norm_app(process) in blocked_apps or key in {a.strip().lower() for a in privacy.get("blocked_apps", [])}:
            return blocked("user_blocked")
        if host and any(domain_matches(host, d) for d in privacy.get("blocked_domains", [])):
            return blocked("user_blocked")

        allow = privacy.get("allow_only")
        if allow is not None:
            allowed = False
            for entry in allow:
                e = entry.strip().lower()
                if e.startswith("browser:"):
                    allowed = allowed or (host is not None and domain_matches(host, e.split(":", 1)[1]))
                elif "." in e and not e.endswith(".exe"):
                    allowed = allowed or (host is not None and domain_matches(host, e))
                else:
                    allowed = allowed or _norm_app(e) == _norm_app(process)
            if not allowed:
                return blocked("user_blocked")

        return Decision(False, None, key, domain)

    def _is_banking(self, host: Optional[str], title: str) -> bool:
        if host:
            if any(domain_matches(host, d) for d in self.config.skiplists.get("banking_domains", [])):
                return True
            labels = host.split(".")
            for kw in self._lower("banking_domain_keywords"):
                if any(kw in label for label in labels):
                    return True
            return False
        # Address unknown: fall back to the title.
        return self._title_has(title, "banking_title_markers")
