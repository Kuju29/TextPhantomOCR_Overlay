""".83 multi-user API: the "local unlimited" header must not let internet users skip
the fairness gates on a Hugging Face Space.

HF puts every visitor behind its own proxy, whose address is private, so the old
"peer is loopback/private" check said yes to everyone who sent x-tp-local-unlimited.
"""
from pathlib import Path
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from starlette.requests import Request
from backend.api.local_client import wants_unlimited


def req(host='127.0.0.1', *extra):
    headers = [(b'x-tp-local-unlimited', b'1'), *extra]
    return Request({'type': 'http', 'method': 'POST', 'path': '/translate', 'headers': headers,
                    'query_string': b'', 'client': (host, 4567)})


CLEAN = {k: v for k, v in os.environ.items() if k not in ('TP_ALLOW_LOCAL_UNLIMITED', 'SPACE_ID', 'SPACE_HOST')}


class LocalUnlimited(unittest.TestCase):
    def test_own_computer_keeps_working(self):
        with patch.dict(os.environ, CLEAN, clear=True):
            self.assertTrue(wants_unlimited(req('127.0.0.1')))
            self.assertTrue(wants_unlimited(req('192.168.1.20')))

    def test_space_defaults_off(self):
        for name in ('SPACE_ID', 'SPACE_HOST'):
            with patch.dict(os.environ, {**CLEAN, name: 'owner/textphantom'}, clear=True):
                self.assertFalse(wants_unlimited(req('10.0.3.7')), name)

    def test_space_operator_can_still_opt_in(self):
        with patch.dict(os.environ, {**CLEAN, 'SPACE_ID': 'owner/tp', 'TP_ALLOW_LOCAL_UNLIMITED': '1'}, clear=True):
            self.assertTrue(wants_unlimited(req('10.0.3.7')))

    def test_proxied_request_is_never_local(self):
        with patch.dict(os.environ, {**CLEAN, 'TP_ALLOW_LOCAL_UNLIMITED': '1'}, clear=True):
            for header in (b'x-forwarded-for', b'forwarded', b'x-real-ip'):
                self.assertFalse(wants_unlimited(req('10.0.3.7', (header, b'203.0.113.9'))), header)

    def test_public_peer_never_local(self):
        with patch.dict(os.environ, {**CLEAN, 'TP_ALLOW_LOCAL_UNLIMITED': '1'}, clear=True):
            self.assertFalse(wants_unlimited(req('8.8.8.8')))


if __name__ == '__main__':
    unittest.main()
