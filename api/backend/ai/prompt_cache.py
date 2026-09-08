"""Cache hints for verified API families; never a result cache or extra call.
Docs checked 2026-09-07. Unknown custom endpoints remain unmodified. A hint is
not a cache hit: only returned usage can establish a read/write or actual cost.
"""
from __future__ import annotations
import hashlib
import os
from urllib.parse import urlsplit

# Exact Alibaba models documented by OpenRouter. Snapshot variants are NOT inferred.
_ALIBABA_MODELS = frozenset({'deepseek/deepseek-v3.2', 'qwen/qwen3-max', 'qwen/qwen-plus',
                           'qwen/qwen3.6-plus', 'qwen/qwen3-coder-plus', 'qwen/qwen3-coder-flash'})

def enabled() -> bool:
    return os.getenv('TP_PROMPT_CACHE', 'auto').strip().lower() not in {'off', '0', 'false'}

def cache_policy(provider: str, model: str, base_url: str) -> dict:
    try:
        host = (urlsplit(base_url).hostname or '').lower()
    except ValueError:
        host = ''
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
    elif host == 'generativelanguage.googleapis.com' and provider == 'gemini':
        strategy, support = 'implicit', 'model_dependent'
    elif provider in {'ollama', 'lmstudio', 'vllm', 'gpt4all', 'jan', 'koboldcpp', 'llamacpp', 'llamafile', 'textgen'} or provider.startswith('local'):
        strategy, support = 'local_runtime', 'runtime_dependent'
    return {'strategy': strategy if enabled() else 'disabled', 'support': support,
            'hit': None, 'discountGuaranteed': False, 'documentationDate': '2026-09-07'}

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
        result.setdefault('session_id', key)
    elif provider == 'openai':
        result.setdefault('prompt_cache_key', key)
    if policy['strategy'] == 'explicit_prefix' and isinstance(system['content'], str):
        system['content'] = [{'type': 'text', 'text': system['content'],
                              'cache_control': {'type': 'ephemeral'}}]
        policy['breakpoint'] = 'system_prefix_only'
    return result, policy
