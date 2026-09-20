"""AI transport boundaries.

Use a named provider seam when a provider has provider-specific behavior.  The
legacy execute_chat_completion export remains for generic/custom OpenAI-style
runtimes only.
"""
from .openai_chat import execute_chat_completion
from .openrouter_chat import execute_openrouter_chat
from .huggingface_chat import execute_huggingface_chat
from .openai_cloud_chat import execute_openai_cloud_chat
from .deepseek_chat import execute_deepseek_chat

__all__ = [
    "execute_chat_completion",
    "execute_openrouter_chat",
    "execute_huggingface_chat",
    "execute_openai_cloud_chat",
    "execute_deepseek_chat",
]
