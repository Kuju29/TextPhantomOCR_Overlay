# Provider runtime policy

TextPhantom keeps provider-specific policy in provider leaves and shares only
wire mechanics. The design intentionally follows the useful parts of Hermes'
provider model without copying behavior that would silently change a user's
selected provider, API key, price, or model.

## Named provider inventory

Cloud (9): Gemini, OpenAI, OpenRouter, Anthropic, Groq, DeepSeek, Together,
Hugging Face Router, Featherless.

Local (10): Ollama, LM Studio, LocalAI, Jan, text-generation-webui, KoboldCpp,
vLLM, llamafile, GPT4All, llama.cpp.

## Policy

- OpenRouter is the only named provider that receives OpenRouter `provider`
  routing preferences. Direct providers never inherit them.
- Hugging Face Router stays on automatic fastest/failover routing unless the
  user explicitly selects a `model:provider` suffix. Observed upstream headers
  are telemetry, not sticky routing instructions.
- Direct cloud providers use their own native API or their provider-owned
  OpenAI-compatible leaf. TextPhantom does not silently cross-provider fallback
  because doing so can change credentials, billing, and model semantics.
- Local OpenAI-compatible runtimes are treated as direct custom endpoints. The
  runtime owns model discovery and generation; TextPhantom does not inject cloud
  routing policy.
- Ollama keeps its native `/api/*` protocol because it exposes useful context,
  loaded-model, usage, and thinking metadata that generic OpenAI compatibility
  would hide.
- Reasoning controls are sent only when the exact provider/model contract proves
  the wire field. Unknown support means provider default; it is not guessed from
  OpenAI-compatible response shape.
- Model discovery/probing is bounded and separate from inference. Opening UI
  during an active translation must not generate provider probes.
- Workload learning is provider/model scoped. Streaming transports report
  first-content and total provider time; native non-streaming transports fall
  back to total provider time. Latency changes future unsent work only.
- Provider terminal/usage frames are authoritative. Marker completion does not
  justify truncating a stream before usage/terminal evidence is captured.

## Deliberate divergence from Hermes

Hermes supports an explicit cross-provider fallback chain. TextPhantom does not
perform that automatically: users supply provider-specific keys and translation
behavior/cost can change when providers are switched. A future fallback feature
must therefore be opt-in and user-owned.
