"""
Exercises the REAL JWT verification paths in server._verify_google_id_token /
_verify_apple_id_token without hitting live Google/Apple:

  * generate a local RSA keypair,
  * sign a fake id_token with it,
  * serve its public half as the JWK the verifier fetches (monkeypatch PyJWKClient),
  * assert genuine jwt.decode accepts a valid token and rejects wrong-audience /
    tampered / expired ones.

Run: venv/bin/python -m pytest tests/test_oauth_verify.py -q
"""
import time
import importlib

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

os_env = {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME": "ticket_platform_test",
    "GOOGLE_CLIENT_ID": "test-google-aud",
    "GOOGLE_CLIENT_SECRET": "x",
    "GOOGLE_REDIRECT_URI": "http://localhost/cb",
    "APPLE_CLIENT_ID": "test-apple-aud",
    "APPLE_TEAM_ID": "t", "APPLE_KEY_ID": "k",
    "APPLE_PRIVATE_KEY": "p", "APPLE_REDIRECT_URI": "http://localhost/cb",
}


@pytest.fixture(scope="module")
def server(monkeypatch_module):
    import os
    for k, v in os_env.items():
        os.environ[k] = v
    import server as srv
    importlib.reload(srv)
    return srv


@pytest.fixture(scope="module")
def monkeypatch_module():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key


def _sign(key, *, aud, iss, sub="sub123", email="u@example.com", email_verified=True, exp_delta=3600):
    now = int(time.time())
    return jwt.encode(
        {"aud": aud, "iss": iss, "sub": sub, "email": email,
         "email_verified": email_verified, "iat": now, "exp": now + exp_delta},
        key, algorithm="RS256",
    )


class _FakeSigningKey:
    def __init__(self, pubkey):
        self.key = pubkey


def _patch_jwks(server, keypair):
    pub = keypair.public_key()
    server._jwks_clients.clear()

    class _FakeClient:
        def __init__(self, url):
            pass

        def get_signing_key_from_jwt(self, token):
            return _FakeSigningKey(pub)

    server.jwt.PyJWKClient = _FakeClient


def test_google_valid(server, keypair):
    _patch_jwks(server, keypair)
    tok = _sign(keypair, aud="test-google-aud", iss="https://accounts.google.com")
    claims = server._verify_google_id_token(tok)
    assert claims["email"] == "u@example.com"
    assert claims["email_verified"] is True


def test_google_wrong_audience_rejected(server, keypair):
    _patch_jwks(server, keypair)
    tok = _sign(keypair, aud="someone-else", iss="https://accounts.google.com")
    with pytest.raises(jwt.PyJWTError):
        server._verify_google_id_token(tok)


def test_google_expired_rejected(server, keypair):
    _patch_jwks(server, keypair)
    tok = _sign(keypair, aud="test-google-aud", iss="https://accounts.google.com", exp_delta=-10)
    with pytest.raises(jwt.PyJWTError):
        server._verify_google_id_token(tok)


def test_google_tampered_rejected(server, keypair):
    _patch_jwks(server, keypair)
    tok = _sign(keypair, aud="test-google-aud", iss="https://accounts.google.com")
    tampered = tok[:-4] + ("aaaa" if not tok.endswith("aaaa") else "bbbb")
    with pytest.raises(jwt.PyJWTError):
        server._verify_google_id_token(tampered)


def test_apple_valid(server, keypair):
    _patch_jwks(server, keypair)
    tok = _sign(keypair, aud="test-apple-aud", iss="https://appleid.apple.com")
    claims = server._verify_apple_id_token(tok)
    assert claims["sub"] == "sub123"


def test_apple_wrong_issuer_rejected(server, keypair):
    _patch_jwks(server, keypair)
    tok = _sign(keypair, aud="test-apple-aud", iss="https://evil.example.com")
    with pytest.raises(jwt.PyJWTError):
        server._verify_apple_id_token(tok)
