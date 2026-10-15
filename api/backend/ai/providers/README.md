# Provider runtime policy

TextPhantom keeps provider-specific policy in provider leaves and shares only
wire mechanics. The design intentionally follows the useful parts of Hermes'
provider model without copying behavior that would silently change a user's
selected provider, API key, price, or model.

## Named provider inventory

Cloud (9): Gemini, OpenAI, OpenRouter, Anthropic, Groq, DeepSeek, Together,
Hugging Face Router, Featherless.

Local (9): Ollama, LM Studio, Jan, text-generation-webui, KoboldCpp,
vLLM, llamafile, GPT4All, llama.cpp.

The picker has a tenth Local option, Custom local adapter, implemented only
in the Extension. The [API provider-boundary regressions](../../../../scripts/test-api-provider-boundary-matrix.py)
and [extension catalogue regressions](../../../../scripts/test-cloud-provider-catalog.mjs)
exercise the named adapters. A provider leaf alone is not evidence of stored
conversation, verified Thinking controls or an actual cache hit.

## Policy

- OpenRouter is the only named provider that receives OpenRouter `provider`
  routing preferences. Direct providers never inherit them.
- .86 provider routing (`backend/ai/routing`, contract in the Center's
  `docs/routing-stats-contract.md`): Manual OpenRouter orders endpoints and an
  unqualified Hugging Face model gets a `model:<provider>` suffix chosen from
  measured results (stats), the .83 cheapest-cache order (auto) or the admin's
  list (manual). A user-selected HF `model:provider` or policy suffix and a
  caller-chosen OpenRouter order/only are always respected. Paid stays decided
  by the Center; the API only reports validation outcomes and `avoid_host`.
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
  the wire field. Manual Cloud rejects an unverified Lowest setting before
  generation; Paid forwards the user's intent to Center's model contract.
  Local provider-managed fallback, where permitted by its native adapter,
  remains explicitly unverified. Unknown explicit Off stops before generation. The UI has
  no Provider default choice. OpenAI-compatible response shape alone cannot
  prove a thinking control.
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
