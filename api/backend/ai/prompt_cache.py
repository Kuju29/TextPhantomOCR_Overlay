"""Cache hints for verified API families; never a result cache or extra call.
Docs checked 2026-09-28. Unknown custom endpoints remain unmodified. A hint is
not a cache hit: only returned usage can establish a read/write or actual cost.
TP_PROMPT_CACHE controls application hints, not automatic provider-side caching.
"""
from __future__ import annotations
import hashlib
import os
from urllib.parse import urlsplit

# Exact Alibaba models documented by OpenRouter. Snapshot variants are NOT inferred.
_ALIBABA_MODELS = frozenset({'deepseek/deepseek-v3.2', 'qwen/qwen3-max', 'qwen/qwen-plus',
                           'qwen/qwen3.6-plus', 'qwen/qwen3-coder-plus', 'qwen/qwen3-coder-flash'})
_GROQ_CACHED_MODELS = frozenset({'openai/gpt-oss-20b', 'openai/gpt-oss-120b',
                                'openai/gpt-oss-safeguard-20b'})

def enabled() -> bool:
    return os.getenv('TP_PROMPT_CACHE', 'auto').strip().lower() not in {'off', '0', 'false'}

def cache_policy(provider: str, model: str, base_url: str) -> dict:
    try:
        parsed = urlsplit(base_url)
        host = (parsed.hostname or '').lower()
        scheme = parsed.scheme.lower()
    except ValueError:
        host = ''
        scheme = ''
    name = model.lower()
    strategy, support = 'unknown', 'unknown'
    if host == 'openrouter.ai' and provider == 'openrouter':
        strategy, support = 'router_automatic', 'endpoint_dependent'
        if name.startswith('anthropic/claude-') or name in _ALIBABA_MODELS:
            strategy = 'explicit_prefix'
    elif host == 'api.anthropic.com' and provider == 'anthropic':
        strategy, support = ('explicit_prefix', 'documented') if name.startswith('claude-') else ('unknown', 'unknown')
    elif host == 'api.openai.com' and provider == 'openai':
        strategy, support = 'automatic', 'model_dependent'
    elif host == 'api.deepseek.com' and provider == 'deepseek':
        strategy, support = 'automatic', 'documented'
    elif host in {'api.together.ai', 'api.together.xyz'} and scheme == 'https' and provider == 'together':
        # Together automatically caches identical rendered prefixes. Its
        # prompt_cache_key routes matching requests toward that prefix; it does
        # not retain conversation history or prove any cache read.
        strategy, support = 'automatic', 'documented'
    elif host == 'generativelanguage.googleapis.com' and provider == 'gemini':
        strategy, support = 'implicit', 'model_dependent'
    elif host == 'api.groq.com' and provider == 'groq' and name in _GROQ_CACHED_MODELS:
        # Groq's automatic GPT-OSS prefix cache still requires resending the
        # same history. This reports availability, never a guaranteed hit.
        strategy, support = 'automatic', 'model_dependent'
    elif provider in {'ollama', 'lmstudio', 'vllm', 'gpt4all', 'jan', 'koboldcpp', 'llamacpp', 'llamafile', 'textgen'} or provider.startswith('local'):
        strategy, support = 'local_runtime', 'runtime_dependent'
    result = {'strategy': strategy if enabled() else 'disabled', 'support': support,
              'hit': None, 'discountGuaranteed': False, 'documentationDate': '2026-09-28'}
    if provider == 'together' and strategy == 'automatic':
        # Disabling the application hint cannot disable Together's automatic
        # cache. Only response usage may demonstrate a hit.
        result['providerCacheUncontrolled'] = True
    return result

def apply_chat_cache(payload: dict, *, provider: str, model: str, url: str,
                     headers: dict, cacheable_system: bool = True) -> tuple[dict, dict]:
    policy = cache_policy(provider, model, url)
    result = dict(payload)
    if policy['strategy'] in {'disabled', 'unknown', 'local_runtime'}:
        return result, policy
    messages = [dict(m) for m in payload.get('messages', [])]
    result['messages'] = messages
    system = next((m for m in messages if m.get('role') in {'system', 'developer'}), None)
    if not system or not system.get('content') or not cacheable_system:
        return result, policy
    text = system['content']
    if isinstance(text, list):
        text = '\n\n'.join(str(b.get('text') or '') for b in text if isinstance(b, dict))
    # Never include API keys, OCR, request IDs or timestamps in the prompt itself.
    account = headers.get('Authorization', headers.get('authorization', ''))
    key = 'tp-' + hashlib.sha256((account+'\0'+model+'\0'+str(text)).encode()).hexdigest()[:48]
    if provider == 'openrouter':
        # Do not inject an application-global session_id here.  OpenRouter uses
        # session_id as the provider-sticky routing key, and this helper's key is
        # intentionally stable for account/model/System-prefix cache reuse.  That
        # scope is broader than a real TextPhantom document Conversation, so it
        # can pin unrelated manga/documents to the same upstream endpoint.  Let
        # OpenRouter derive its normal conversation fingerprint from the opening
        # messages instead; a real cache hit can then enable stickiness at the
        # provider's own conversation scope.
        policy['stickyRouting'] = ('explicit_conversation_session' if result.get('session_id')
                                   else 'openrouter_conversation_fingerprint')
    elif provider in {'openai', 'together'}:
        result.setdefault('prompt_cache_key', key)
        if provider == 'together':
            policy['routingHint'] = 'prompt_cache_key'
    if policy['strategy'] == 'explicit_prefix' and isinstance(system['content'], str):
        system['content'] = [{'type': 'text', 'text': system['content'],
                              'cache_control': {'type': 'ephemeral'}}]
        policy['breakpoint'] = 'system_prefix_only'
    return result, policy
