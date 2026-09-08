"""Provider-neutral HTTP transports used by concrete AI providers."""

from .openai_chat import execute_chat_completion

__all__ = ["execute_chat_completion"]
