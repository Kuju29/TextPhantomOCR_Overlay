"""Shared OpenAI-compatible wire mechanics.

Provider modules must own policy, cache hints, model aliases and routing.  The
core below owns only one prepared HTTP/SSE request and normalized ChatResult.
"""
from .core import execute_openai_compatible_request

__all__ = ["execute_openai_compatible_request"]
