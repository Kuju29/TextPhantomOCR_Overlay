# Extension AI transport boundaries

- `server.js` owns the browser -> TextPhantom API request/response boundary.
- `direct-local.js` owns direct browser -> local runtime streaming.

Provider-specific cloud wire behavior belongs on the API side under
`api/backend/ai/transports/`; the extension must not branch on OpenRouter,
Hugging Face, OpenAI, etc.  This prevents a cloud-provider fix from changing
browser orchestration or Local AI behavior.
