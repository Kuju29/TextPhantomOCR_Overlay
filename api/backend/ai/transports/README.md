# AI transport boundaries

Provider policy must stay outside the shared wire core.

- `openai_compat/core.py` — one prepared OpenAI-compatible HTTP/SSE request; no vendor names or routing policy.
- `openai_compat/streaming.py` — SSE completion gates, bounded wire capture and usage merging.
- `openai_compat/response.py` — non-stream response decoding/text extraction.
- `openrouter_chat.py` — OpenRouter cache/routing/accounting seam.
- `huggingface_chat.py` — Hugging Face Router seam.
- `openai_cloud_chat.py` — OpenAI cloud seam.
- `deepseek_chat.py` — DeepSeek cloud seam.
- `openai_chat.py` — compatibility seam for generic/local/custom OpenAI-compatible runtimes.
- `cancellable_http.py` — cancellable JSON HTTP helper used by native/non-OpenAI transports.

Concrete provider modules prepare model-specific payloads and reasoning controls.
Transport modules do not select models, retry a generation, or repair output.
