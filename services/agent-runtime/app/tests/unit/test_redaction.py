from app.security.redaction import redact


def test_redacts_key_value_secrets():
    assert "REDACTED" in redact("API_KEY=supersecretvalue")
    assert "REDACTED" in redact("password: hunter2")
    assert "REDACTED" in redact("Authorization: Bearer abc.def.ghi")


def test_redacts_token_shapes():
    assert "REDACTED" in redact("sk-abcdefghijklmnopqrstuvwx")
    assert "REDACTED" in redact("AKIAIOSFODNN7EXAMPLE")
    assert "REDACTED" in redact(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----"
    )


def test_leaves_ordinary_text_alone():
    text = "2 passed in 0.01s"
    assert redact(text) == text


def test_handles_empty():
    assert redact(None) == ""
    assert redact("") == ""
