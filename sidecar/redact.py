"""Masking rules (PLAN §6.1).

Every piece of text the sidecar emits goes through Redactor.redact() first:
window titles, element names, field values, ambient text and voice
transcripts (via the `redact` command). Password fields are never read at
all; that rule lives in the callers, `looks_like_password_field()` helps them.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Callable, List, Mapping, Tuple

MAX_INPUT_CHARS = 100_000

# Field names that mean "this is a secret, don't read its value".
_PASSWORD_FIELD_RE = re.compile(
    r"\bpass(?:word|wort|code|phrase)?\b|\bpasswd\b|\bpwd\b|\bpin\b|\bcvv2?\b|\bcvc2?\b"
    r"|security code|\botp\b|one[- ]time|\b2fa\b|\bmfa\b|secret|kennwort|\btoken\b"
    r"|mot de passe|contrase(?:ñ|n)a|\bsenha\b|wachtwoord|has(?:ł|l)o",
    re.IGNORECASE,
)

_PEM_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
)
_PREFIX_SECRET_RES = [
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
]
# "password: hunter2", "api_key=abc123", "token = xyz"
_KV_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|apikey|secret|token|access[_-]?key|client[_-]?secret|password|passwort|passwd|pwd)"
    r"(\s*[:=]\s*)([^\s,;'\"]{4,})"
)
_BEARER_RE = re.compile(r"(?i)\b(bearer\s+)([A-Za-z0-9\-._~+/]{12,}=*)")
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:[  ]?[A-Z0-9]){11,30}\b")
_CARD_RE = re.compile(r"(?<![\d.,])\d(?:[   -]?\d){12,18}(?!\d)")
_SSN_RE = re.compile(r"\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b")
_ENTROPY_CANDIDATE_RE = re.compile(r"[A-Za-z0-9+/=_\-]{32,}")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_PHONE_RE = re.compile(r"(?<![\w+])\+?\d[\d ().\-]{6,}\d(?!\w)")
_DATE_LIKE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$")

_PASSWORD_KEYS = {"password", "passwort", "passwd", "pwd"}


def looks_like_password_field(name: str | None) -> bool:
    """True when a field's name says its value is a secret (never read it)."""
    return bool(name) and bool(_PASSWORD_FIELD_RE.search(name))


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def iban_ok(compact: str) -> bool:
    if not 15 <= len(compact) <= 34:
        return False
    rearranged = compact[4:] + compact[:4]
    try:
        number = "".join(str(int(ch, 36)) for ch in rearranged)
    except ValueError:
        return False
    return int(number) % 97 == 1


def _entropy(s: str) -> float:
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in counts.values())


@dataclass
class MaskOptions:
    passwords: bool = True
    secrets: bool = True
    cards: bool = True
    ssn: bool = True
    iban: bool = True
    email: bool = False
    phone: bool = False

    @classmethod
    def from_config(cls, mask: Mapping[str, object] | None) -> "MaskOptions":
        opts = cls()
        for name in ("passwords", "secrets", "cards", "ssn", "iban", "email", "phone"):
            if mask and isinstance(mask.get(name), bool):
                setattr(opts, name, mask[name])
        return opts


class Redactor:
    def __init__(self, options: MaskOptions | None = None):
        self.options = options or MaskOptions()
        steps: List[Callable[[str], str]] = []
        o = self.options
        if o.secrets:
            steps += [self._pem, self._prefix_secrets]
        if o.secrets or o.passwords:
            steps += [self._kv_secrets]
        if o.secrets:
            steps += [self._bearer]
        if o.iban:
            steps.append(self._ibans)
        if o.cards:
            steps.append(self._cards)
        if o.ssn:
            steps.append(self._ssns)
        if o.secrets:
            steps.append(self._high_entropy)
        if o.email:
            steps.append(self._emails)
        if o.phone:
            steps.append(self._phones)
        self._steps = steps

    def redact(self, text: str | None) -> str:
        return self.redact_with_flag(text)[0]

    def redact_with_flag(self, text: str | None) -> Tuple[str, bool]:
        """Return (masked text, whether anything was masked)."""
        if not text:
            return ("" if text is None else text), False
        original = text[:MAX_INPUT_CHARS]
        out = original
        for step in self._steps:
            out = step(out)
        return out, out != original

    # -- individual rules -------------------------------------------------

    @staticmethod
    def _pem(s: str) -> str:
        return _PEM_RE.sub("[SECRET]", s)

    @staticmethod
    def _prefix_secrets(s: str) -> str:
        for rx in _PREFIX_SECRET_RES:
            s = rx.sub("[SECRET]", s)
        return s

    def _kv_secrets(self, s: str) -> str:
        def repl(m: re.Match) -> str:
            key = m.group(1)
            is_password = key.lower() in _PASSWORD_KEYS
            if is_password and not self.options.passwords:
                return m.group(0)
            if not is_password and not self.options.secrets:
                return m.group(0)
            if m.group(3).startswith("["):  # already masked
                return m.group(0)
            return key + m.group(2) + ("[PASSWORD]" if is_password else "[SECRET]")

        return _KV_SECRET_RE.sub(repl, s)

    @staticmethod
    def _bearer(s: str) -> str:
        return _BEARER_RE.sub(lambda m: m.group(1) + "[SECRET]", s)

    @staticmethod
    def _ibans(s: str) -> str:
        def repl(m: re.Match) -> str:
            raw = m.group(0)
            # Positions of the significant characters, so a trailing word that
            # the regex swallowed ("... 00 EUR") can be dropped again.
            positions = [i for i, ch in enumerate(raw) if ch not in "  "]
            compact = "".join(raw[i] for i in positions)
            for length in range(len(compact), 14, -1):
                candidate = compact[:length]
                if iban_ok(candidate):
                    end = positions[length - 1] + 1
                    return f"[IBAN ••••{candidate[-4:]}]" + raw[end:]
            return raw

        return _IBAN_RE.sub(repl, s)

    @staticmethod
    def _cards(s: str) -> str:
        def repl(m: re.Match) -> str:
            digits = re.sub(r"\D", "", m.group(0))
            if 13 <= len(digits) <= 19 and luhn_ok(digits):
                return f"[CARD ••••{digits[-4:]}]"
            return m.group(0)

        return _CARD_RE.sub(repl, s)

    @staticmethod
    def _ssns(s: str) -> str:
        return _SSN_RE.sub("[SSN]", s)

    @staticmethod
    def _high_entropy(s: str) -> str:
        def repl(m: re.Match) -> str:
            token = m.group(0)
            if token.count("/") > 2:  # looks like a path, not a key
                return token
            if not (re.search(r"\d", token) and re.search(r"[A-Za-z]", token)):
                return token
            if _entropy(token) < 3.6:
                return token
            return "[SECRET]"

        return _ENTROPY_CANDIDATE_RE.sub(repl, s)

    @staticmethod
    def _emails(s: str) -> str:
        return _EMAIL_RE.sub("[EMAIL]", s)

    @staticmethod
    def _phones(s: str) -> str:
        def repl(m: re.Match) -> str:
            raw = m.group(0)
            digits = re.sub(r"\D", "", raw)
            if not 8 <= len(digits) <= 15:
                return raw
            if _DATE_LIKE_RE.match(raw.strip()):
                return raw
            if not (raw.startswith("+") or re.search(r"[ ().\-]", raw)):
                return raw
            return "[PHONE]"

        return _PHONE_RE.sub(repl, s)
