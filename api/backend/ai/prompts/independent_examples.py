"""Bounded style examples; no chat history or provider calls."""
import re
import unicodedata

MAX_PAIRS = 20
MAX_POOL_CHARS = 3000
MAX_REQUEST_PAIRS = 4
MAX_REQUEST_CHARS = 600


def suitable(text, target):
    letters = [c for c in str(text) if c.isalpha()]
    code = str(target).lower().split('-')[0]
    def script(c):
        name = unicodedata.name(c, '')
        if code == 'th': return 'THAI' in name
        if code == 'ja': return any(s in name for s in ('CJK', 'HIRAGANA', 'KATAKANA'))
        # The API's Korean page validator rejects Han-only dialogue. Teaching
        # must be stricter than readable display, never learn a rejected row.
        if code == 'ko': return 'HANGUL' in name
        if code == 'zh': return 'CJK' in name
        return True
    return code not in ('th', 'ja', 'ko', 'zh') or bool(letters) and all(map(script, letters))


def bounded_pairs(rows):
    seen, result, chars = set(), [], 0
    for row in reversed(rows):
        src, tgt = str(row.get('src', '')).strip(), str(row.get('tgt', '')).strip()
        if (not src or not tgt or src == tgt or len(src) > 160 or len(tgt) > 240
                or any(c in src + tgt for c in '\r\n\u2028\u2029') or src in seen
                or chars + len(src) + len(tgt) > MAX_POOL_CHARS):
            continue
        seen.add(src); result.append({'src': src, 'tgt': tgt}); chars += len(src) + len(tgt)
        if len(result) == MAX_PAIRS: break
    return list(reversed(result))


def format_story_examples(pairs, target):
    code = str(target).lower().split('-')[0]
    if code == 'th':
        heading = 'ตัวอย่างคำแปลที่ตรวจผ่านแล้วจากเรื่องนี้ (ใช้ดูสไตล์เท่านั้น ให้แปล ID ของข้อความต้นฉบับในคำขอนี้):'
        source, translation = 'ต้นฉบับ', 'คำแปล'
    elif code == 'ja':
        heading = 'この作品で検証済みの訳例（文体の参考のみ。今回の原文IDを翻訳すること）：'
        source, translation = '原文', '訳文'
    else:
        heading = 'PREVIOUSLY ACCEPTED TRANSLATIONS FROM THIS STORY (style reference only; translate the current SOURCE IDs):'
        source, translation = 'SOURCE', 'TRANSLATION'
    return '\n'.join([heading, *[f'{i}. {source}: {p["src"]}\n   {translation}: {p["tgt"]}'
        for i, p in enumerate(pairs, 1)]]) if pairs else ''


def _features(value):
    words = re.findall(r'[^\W_]+', unicodedata.normalize('NFKC', value).lower())
    letters = ''.join(words)
    return {w for w in words if len(w) >= 2} | {letters[i:i+2] for i in range(len(letters)-1)}


def select_pairs(pool, current_source, target):
    features = _features(current_source)
    ranked = sorted(enumerate(pool), key=lambda row:
        (-len(features & _features(row[1]['src'])), -row[0]))
    chosen = []
    for candidate in ranked:
        proposed = sorted([*chosen, candidate])
        if len(format_story_examples([p for _, p in proposed], target)) <= MAX_REQUEST_CHARS:
            chosen = proposed
        if len(chosen) == MAX_REQUEST_PAIRS: break
    if pool and not chosen:
        raise ValueError('independent_story_examples_budget_insufficient')
    return [p for _, p in chosen]
