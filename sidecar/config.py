"""Runtime configuration: privacy settings, per-app modes and skip lists.

Repo defaults live in <repo>/config/*.json. On first run they are copied to
the runtime folder (%APPDATA%/apprentice/config by default), which is what
the dashboard edits. Writes are atomic (temp file + rename) so a crash or a
concurrent reader never sees half a file.
"""
from __future__ import annotations

import calendar
import copy
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_PRIVACY: Dict[str, Any] = {
    "mask": {"passwords": True, "secrets": True, "cards": True, "ssn": True, "iban": True,
             "email": False, "phone": False},
    "skip": {"banking": True, "password_managers": True, "private_windows": True},
    "blocked_apps": [],
    "blocked_domains": [],
    "allow_only": None,
    "raw_retention_days": 7,
    "local_only_apps": [],
    "ambient_screenshots": True,
}

SKIPLIST_KEYS = (
    "browsers", "password_manager_processes", "password_manager_title_markers",
    "banking_domains", "banking_domain_keywords", "banking_title_markers",
    "private_window_markers", "system_processes", "browser_internal_schemes",
    "browser_internal_allowed_hosts", "remote_session_processes",
)


def log(msg: str) -> None:
    print(f"[observer] {msg}", file=sys.stderr, flush=True)


def read_json(path: Path) -> Optional[Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as ex:
        log(f"could not read {path}: {ex}")
        return None


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _str_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, str) and v.strip()]


def normalize_privacy(raw: Any, defaults: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a (possibly partial or hand-edited) privacy file over the defaults."""
    out = copy.deepcopy(defaults)
    if not isinstance(raw, dict):
        return out
    for group in ("mask", "skip"):
        if isinstance(raw.get(group), dict):
            for k, v in raw[group].items():
                if k in out[group] and isinstance(v, bool):
                    out[group][k] = v
    for k in ("blocked_apps", "blocked_domains", "local_only_apps"):
        if k in raw:
            out[k] = _str_list(raw[k])
    if "allow_only" in raw:
        out["allow_only"] = None if raw["allow_only"] is None else _str_list(raw["allow_only"])
    if isinstance(raw.get("raw_retention_days"), int) and not isinstance(raw["raw_retention_days"], bool):
        out["raw_retention_days"] = max(0, raw["raw_retention_days"])
    if isinstance(raw.get("ambient_screenshots"), bool):
        out["ambient_screenshots"] = raw["ambient_screenshots"]
    return out


class ConfigStore:
    def __init__(self, config_dir: Path, defaults_dir: Optional[Path] = None):
        self.config_dir = Path(config_dir)
        self.defaults_dir = Path(defaults_dir) if defaults_dir else None
        self._lock = threading.RLock()
        self.privacy: Dict[str, Any] = copy.deepcopy(DEFAULT_PRIVACY)
        self.app_modes: Dict[str, Dict[str, Any]] = {}
        self.skiplists: Dict[str, List[str]] = {k: [] for k in SKIPLIST_KEYS}

    @property
    def privacy_path(self) -> Path:
        return self.config_dir / "privacy.json"

    @property
    def app_modes_path(self) -> Path:
        return self.config_dir / "app_modes.json"

    def _default_file(self, name: str) -> Optional[Path]:
        if self.defaults_dir is None:
            return None
        p = self.defaults_dir / name
        return p if p.exists() else None

    def load(self) -> None:
        """(Re)load everything; create the runtime files from the defaults if missing."""
        with self._lock:
            defaults = DEFAULT_PRIVACY
            dp = self._default_file("privacy.default.json")
            if dp:
                defaults = normalize_privacy(read_json(dp), DEFAULT_PRIVACY)

            if not self.privacy_path.exists():
                write_json_atomic(self.privacy_path, defaults)
            self.privacy = normalize_privacy(read_json(self.privacy_path), defaults)

            if not self.app_modes_path.exists():
                seed = read_json(self._default_file("app_modes.default.json")) if self._default_file("app_modes.default.json") else None
                write_json_atomic(self.app_modes_path, seed if isinstance(seed, dict) else {})
            modes = read_json(self.app_modes_path)
            self.app_modes = {k: v for k, v in modes.items() if isinstance(v, dict)} if isinstance(modes, dict) else {}

            lists: Dict[str, List[str]] = {k: [] for k in SKIPLIST_KEYS}
            for source in (self._default_file("skiplists.json"), self.config_dir / "skiplists.json"):
                data = read_json(source) if source else None
                if isinstance(data, dict):
                    for k in SKIPLIST_KEYS:
                        if k in data:
                            lists[k] = _str_list(data[k])
            self.skiplists = lists

    def app_mode(self, key: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self.app_modes.get(key, {}))

    def update_app_mode(self, key: str, **fields: Any) -> Dict[str, Any]:
        """Read-modify-write one app's entry. A field set to None is removed."""
        with self._lock:
            current = read_json(self.app_modes_path)
            modes = {k: v for k, v in current.items() if isinstance(v, dict)} if isinstance(current, dict) else dict(self.app_modes)
            entry = dict(modes.get(key, {}))
            for k, v in fields.items():
                if v is None:
                    entry.pop(k, None)
                else:
                    entry[k] = v
            modes[key] = entry
            write_json_atomic(self.app_modes_path, modes)
            self.app_modes = modes
            return dict(entry)

    def block_key(self, key: str) -> None:
        """Add an app key to the user's block list ("Never watch this app")."""
        with self._lock:
            raw = read_json(self.privacy_path)
            privacy = normalize_privacy(raw, self.privacy)
            if key.startswith("browser:"):
                domain = key.split(":", 1)[1]
                if domain and domain not in privacy["blocked_domains"]:
                    privacy["blocked_domains"].append(domain)
            elif key not in [a.lower() for a in privacy["blocked_apps"]]:
                privacy["blocked_apps"].append(key)
            write_json_atomic(self.privacy_path, privacy)
            self.privacy = privacy


def iso_now(now: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))


def parse_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError:
        return None
