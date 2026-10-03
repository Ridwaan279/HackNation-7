import pytest

from redact import MaskOptions, Redactor, iban_ok, looks_like_password_field, luhn_ok


@pytest.fixture
def r():
    return Redactor()


# -- PLAN §6.1 test vectors ------------------------------------------------

def test_card_keeps_last_four(r):
    assert r.redact("Card 4242 4242 4242 4242 on file") == "Card [CARD ••••4242] on file"


def test_card_with_dashes_and_no_separators(r):
    assert r.redact("4242-4242-4242-4242") == "[CARD ••••4242]"
    assert r.redact("4242424242424242") == "[CARD ••••4242]"


def test_iban_keeps_last_four(r):
    assert r.redact("Pay to DE89 3704 0044 0532 0130 00") == "Pay to [IBAN ••••3000]"
    assert r.redact("DE89370400440532013000") == "[IBAN ••••3000]"


def test_iban_followed_by_uppercase_word(r):
    # The regex swallows " EUR"; the shrinking check must still find the IBAN.
    assert r.redact("DE89 3704 0044 0532 0130 00 EUR") == "[IBAN ••••3000] EUR"


def test_ssn(r):
    assert r.redact("SSN 123-45-6789.") == "SSN [SSN]."


def test_aws_key(r):
    assert r.redact("key AKIAIOSFODNN7EXAMPLE here") == "key [SECRET] here"


# -- other secrets -----------------------------------------------------------

@pytest.mark.parametrize("secret", [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-proj-abcdefghijklmnopqrstuvwx1234",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "xoxb-1234567890-abcdefghij",
    "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
    "glpat-abcdefghijklmnopqrst",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
])
def test_prefixed_secrets(r, secret):
    out = r.redact(f"value {secret} end")
    assert out == "value [SECRET] end"


def test_pem_private_key(r):
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----"
    assert r.redact(f"x {pem} y") == "x [SECRET] y"


def test_key_value_secrets(r):
    assert r.redact("password: hunter2") == "password: [PASSWORD]"
    assert r.redact("api_key=abcd1234efgh") == "api_key=[SECRET]"
    assert r.redact("Token = zz9plural") == "Token = [SECRET]"


def test_bearer_token(r):
    assert r.redact("Authorization: Bearer abcdefghijklmnop123") == "Authorization: Bearer [SECRET]"


def test_high_entropy_token(r):
    assert r.redact("id Zx9QmP4vL2rT8sW1yB6nC3hJ5kD7fG0aE end") == "id [SECRET] end"


# -- things that must NOT be masked ------------------------------------------

@pytest.mark.parametrize("text", [
    "Invoice 4471 from Müller GmbH, €7,200.00",
    "Cost center 4711 → 0400",
    "INV-2024-000123",
    "Due 2026-10-03",
    "Phone +49 170 1234567",              # phone masking is off by default
    "sabine@example.com",                 # email masking is off by default
    "C:/Users/sabine/Documents/Q3/accruals/final-version-2024.xlsx",
    "4242 4242 4242 4241",                # fails Luhn
    "DE00 3704 0044 0532 0130 00",        # fails mod-97
    "000-12-3456",                        # invalid SSN area
    "The token approval workflow",        # prose, no key=value
    "Equipment over €5,000 is always capex.",
])
def test_not_masked(r, text):
    assert r.redact(text) == text


def test_idempotent(r):
    once = r.redact("4242 4242 4242 4242 DE89 3704 0044 0532 0130 00 password: x1y2z3")
    assert r.redact(once) == once


def test_flag(r):
    assert r.redact_with_flag("nothing here") == ("nothing here", False)
    assert r.redact_with_flag("SSN 123-45-6789")[1] is True


def test_empty_and_none(r):
    assert r.redact("") == ""
    assert r.redact(None) == ""


def test_optional_email_and_phone():
    r = Redactor(MaskOptions(email=True, phone=True))
    assert r.redact("mail sabine@example.com now") == "mail [EMAIL] now"
    assert r.redact("call +49 170 1234567") == "call [PHONE]"
    assert r.redact("on 03.10.2026") == "on 03.10.2026"


def test_options_from_config_can_disable_rules():
    r = Redactor(MaskOptions.from_config({"cards": False}))
    assert r.redact("4242 4242 4242 4242") == "4242 4242 4242 4242"
    assert r.redact("SSN 123-45-6789") == "SSN [SSN]"


def test_options_ignore_non_bool_values():
    opts = MaskOptions.from_config({"cards": "no", "email": True})
    assert opts.cards is True and opts.email is True


def test_input_is_capped():
    r = Redactor()
    assert len(r.redact("a" * 200_000)) == 100_000


# -- helpers -------------------------------------------------------------------

def test_luhn_and_iban_helpers():
    assert luhn_ok("4242424242424242")
    assert not luhn_ok("4242424242424241")
    assert iban_ok("DE89370400440532013000")
    assert not iban_ok("DE89370400440532013001")


@pytest.mark.parametrize("name,expected", [
    ("Password", True), ("New password", True), ("Passwort", True), ("PIN", True),
    ("CVV", True), ("Security code", True), ("One-time code", True), ("API token", True),
    ("Client secret", True), ("Kennwort", True), ("Mot de passe", True),
    ("Passport number", False), ("Bypass approval", False), ("Spin count", False),
    ("Cost center", False), ("Supplier", False), ("", False), (None, False),
])
def test_password_field_names(name, expected):
    assert looks_like_password_field(name) is expected
