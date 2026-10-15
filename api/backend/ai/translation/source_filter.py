"""Prune provider inputs and restore the caller's complete source sequence."""
from copy import copy
from dataclasses import dataclass

from backend.ai import markers
from backend.ai.translation.contracts import AiConfig, AiResult
from backend.ai.translation_paths.origins import checked_origins


@dataclass
class FilteredSource:
    texts: list[str]
    kept: list[int]
    config: AiConfig
    wire_to_original: dict[str, str]

    @property
    def skipped(self):
        kept = set(self.kept)
        return [index for index in range(len(self.texts)) if index not in kept]

    def skipped_result(self) -> AiResult:
        return AiResult(aiTextFull=markers.apply(self.texts), meta={
            'skipped': True, 'skipped_reason': 'no_translatable_text',
            'generationAttempts': 0, 'providerAttempts': 0,
            'generation_attempts': 0, 'provider_attempts': 0,
            'translationMode': self.config.translation_mode,
            'accepted_losslessly': True, 'content_modified': False,
            'usage': {'inputTokens': None, 'outputTokens': None, 'totalTokens': None,
                      'source': None, 'providerHttpStatuses': []},
            'batchCount': 0, 'batchRanges': [], **self.counts(),
        })

    def counts(self):
        return {'sourceUnitCount': len(self.texts), 'translatableUnitCount': len(self.kept),
                'skippedSourceUnitCount': len(self.skipped), 'skipped_source_indices': self.skipped}

    def restore(self, result: AiResult) -> AiResult:
        if self.skipped:
            parsed = markers.extract_paragraphs_exact(result.get('aiTextFull', ''), len(self.kept))
            if parsed is not None:
                values = list(self.texts)
                for index, value in zip(self.kept, parsed[0]):
                    values[index] = value
                result['aiTextFull'] = markers.apply(values)
            # Decoder diagnostics refer to provider IDs. Map compact Independent
            # Pn IDs back to the original sequence; stable Conversation I IDs
            # remain unchanged for its API/document ownership contract.
            meta = result.setdefault('meta', {})
            for key in ('omitted_ids', 'alignment_uncertain_ids', 'duplicate_output_ids'):
                if key in meta:
                    meta[key] = [self.wire_to_original.get(str(uid), uid) for uid in meta[key]]
        result.setdefault('meta', {}).update(self.counts())
        return result


def prepare_source(source: str, ai: AiConfig) -> FilteredSource | None:
    expected = markers.expected_ids(source)
    parsed = markers.extract_paragraphs_exact(source, len(expected)) if expected else None
    if parsed is None:
        return None  # Existing canonical validator owns malformed source.
    texts = list(parsed[0])
    kept = [index for index, text in enumerate(texts) if markers.has_translatable_text(text)]
    conversation = dict(ai.conversation or {})
    origins = checked_origins(conversation.get('origins')) if ai.translation_mode == 'conversation' else []
    original_wire = [uid for row in origins for uid in row['unitIds']] if origins else expected
    if origins and len(original_wire) != len(texts):
        raise ValueError('Conversation image/unit IDs do not match the current source')
    kept_set = set(kept)
    if origins:
        filtered_origins, offset = [], 0
        for row in origins:
            positions = [i for i in range(len(row['unitIds'])) if offset + i in kept_set]
            if positions:
                filtered_origins.append({**row,
                    'unitIds': [row['unitIds'][i] for i in positions],
                    'originalIds': [row['originalIds'][i] for i in positions]})
            offset += len(row['unitIds'])
        conversation['origins'] = filtered_origins
    sent_wire = [original_wire[i] for i in kept] if origins else [f'P{i}' for i in range(len(kept))]
    target_mapping = {original_wire[index]: sent for index, sent in zip(kept, sent_wire)}
    contexts = []
    for group in ai.source_context or []:
        targets = list(dict.fromkeys(target_mapping[uid] for uid in group.get('targetIds', []) if uid in target_mapping))
        units = [dict(row) for row in group.get('units', []) if markers.has_translatable_text(row.get('text', ''))]
        if targets and units:
            contexts.append({**group, 'targetIds': targets, 'units': units})
    # READY attaches private one-use model/endpoint evidence outside dataclass
    # fields. Preserve its identity and lock; copying only declared fields loses
    # that proof, and deepcopy would duplicate its one-use state.
    config = copy(ai)
    config.conversation = conversation
    config.source_context = contexts
    config.page_context = [dict(row) for row in ai.page_context or [] if markers.has_translatable_text(row.get('text', ''))]
    return FilteredSource(texts, kept, config,
        {sent: (sent if origins else f'P{index}') for index, sent in zip(kept, sent_wire)})
