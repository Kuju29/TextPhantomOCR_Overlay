"""Opaque user-click metadata, distinct from a billable provider-operation ID."""
import re


def identifier(value=None):
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", value):
        raise ValueError("user run identifier is invalid")
    return value
