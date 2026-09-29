"""HF Hub IDs, routing policies and serving metadata — no generation calls.

Do not treat a routing policy as a provider, or a model's training context as
an allocation at every HF upstream. All returned numeric limits are catalogue
facts for this exact selected model/route.
"""
from __future__ import annotations
from collections import Counter
from copy import deepcopy
import re
from .huggingface_limits import catalogue_limits

POLICIES = frozenset({'fastest', 'cheapest', 'preferred'})
SUFFIX = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
HUB_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$')


def split_model(model: str) -> tuple[str, str, str]:
    value = str(model or '').strip()
    if ':' not in value:
        return value, '', 'auto_fastest'
    base, suffix = value.rsplit(':', 1)
    if not base or not SUFFIX.fullmatch(suffix):
        return value, '', 'invalid'
    return base, suffix, suffix if suffix in POLICIES else 'provider'


def live_entries(card):
    return [row for row in card.get('providers', []) if isinstance(row, dict)
            and str(row.get('status', '')).lower() == 'live'
            and SUFFIX.fullmatch(str(row.get('provider', '')))
            and row['provider'] not in POLICIES] if isinstance(card, dict) and isinstance(card.get('providers'), list) else []


def selection_capabilities(card, selected):
    if not isinstance(card, dict):
        return {}
    base, suffix, policy = split_model(selected)
    if card.get('id') != base or policy == 'invalid':
        return {}
    live = live_entries(card)
    counts = Counter(row['provider'] for row in live)
    names = sorted(counts)
    if policy == 'provider' and (suffix not in names or counts[suffix] != 1):
        return {}
    routes, common = catalogue_limits(card.get('providers'))
    result = {}
    architecture = card.get('architecture')
    inputs = architecture.get('input_modalities') if isinstance(architecture, dict) else None
    if isinstance(inputs, list) and inputs:
        result['vision'] = {'supported': 'image' in {str(x).lower() for x in inputs},
                            'source': 'huggingface_live_chat_model_catalogue'}
    if policy == 'provider':
        if suffix in routes:
            result['limits'] = deepcopy(routes[suffix])
    else:
        if routes:
            result['provider_limits'] = deepcopy(routes)
        if common:
            result['limits'] = deepcopy(common)
    # Diagnostic only. It never authorizes Thinking, extra context or a pin.
    result['hf_route'] = {'policy': policy, 'provider': suffix if policy == 'provider' else '',
        'liveProviders': names[:64], 'missingLimitProviders': [n for n in names if n not in routes][:64],
        'contextStatus': 'reported' if result.get('limits', {}).get('contextTokens') else 'unreported'}
    return result


def add_explicit_choices(models, cards, capabilities, candidates):
    """Preserve base choices first; expose only user-selectable live routes.

    No selection is changed. Selecting a route obtains its own health/Thinking
    proof; base/other-route probe results must not be copied into these choices.
    """
    cards = cards if isinstance(cards, list) else []
    out = list(dict.fromkeys(models))
    counts = Counter(str(card.get('id', '')) for card in cards if isinstance(card, dict))
    for card in cards:
        if not isinstance(card, dict):
            continue
        base = str(card.get('id', ''))
        if base not in models or counts[base] != 1:
            continue
        capabilities[base] = {**capabilities.get(base, {}), **selection_capabilities(card, base)}
        names = Counter(row['provider'] for row in live_entries(card))
        for suffix in ['fastest', 'cheapest', 'preferred', *sorted(n for n, count in names.items() if count == 1)]:
            selected = base + ':' + suffix
            out.append(selected)
            capabilities[selected] = selection_capabilities(card, selected)
            candidates[selected] = {'eligibility': 'usable', 'evidence': 'huggingface_live_text_route',
                'routingPolicy': 'hf_' + ('explicit_provider' if suffix not in POLICIES else suffix)}
    return tuple(dict.fromkeys(out))
