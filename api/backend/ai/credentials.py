"""Request-owned cloud credentials. No environment/server-key fallback."""
from __future__ import annotations

from .rate_policy import is_local_target


class MissingUserApiKey(ValueError):
    code = 'missing_api_key'

    def __init__(self):
        super().__init__('Cloud translation requires your API key.')


def request_api_key(provider: str, base_url: str, supplied: str) -> str:
    if is_local_target(provider, base_url):
        return ''  # Never forward a cloud credential to Local.
    key = str(supplied or '').strip()
    if not key:
        raise MissingUserApiKey()
    return key
