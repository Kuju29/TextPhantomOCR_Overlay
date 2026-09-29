"""Request-owned cloud credentials. No environment/server-key fallback."""
from __future__ import annotations

from .rate_policy import cloud_local_endpoint_conflict, is_local_target


class MissingUserApiKey(ValueError):
    code = 'missing_api_key'

    def __init__(self):
        super().__init__('Cloud translation requires your API key.')


class ProviderEndpointConflict(ValueError):
    code = 'ai_provider_endpoint_conflict'

    def __init__(self):
        super().__init__('Selected Cloud provider conflicts with a Local server URL. Select the Local provider or correct the URL.')


def request_api_key(provider: str, base_url: str, supplied: str) -> str:
    if cloud_local_endpoint_conflict(provider, base_url):
        raise ProviderEndpointConflict()
    if str(provider or "").strip().lower() in {"", "auto"} and str(supplied or "").strip() and is_local_target("auto", base_url):
        raise ProviderEndpointConflict()
    if is_local_target(provider, base_url):
        return ''  # Never forward a cloud credential to Local.
    key = str(supplied or '').strip()
    if not key:
        raise MissingUserApiKey()
    return key
