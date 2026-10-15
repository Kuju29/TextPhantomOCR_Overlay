"""Optional story summary metadata, separated before the translation decoder."""
import copy
import json
import re
from backend.lens.languages import normalize

LIMIT = 800

def instruction(lang, structured_output=False):
    # Free-form notes (several characters/events allowed),
    # names as written or "unknown name", gender only when explicit, one line.
    code = normalize(lang)
    location = '"TP_MEMO"' if structured_output else '<<TP_MEMO:...>>'
    if code == "th":
        return ('ความจำเรื่อง (TP_MEMO) — หลังคำแปลครบแล้ว ให้จดบันทึกจากข้อความในคำขอนี้ให้คำขอต่อไปเข้าใจเรื่อง: ตัวละครที่ปรากฏ ใช้ชื่อตามที่ข้อความระบุ ถ้าไม่มีชื่อให้เขียน "ไม่ทราบชื่อ" พร้อมลักษณะสั้น ๆ ห้ามเดาชื่อ บอกบทบาทหรือความสัมพันธ์ บุคลิกหรือน้ำเสียงการพูด และระบุเพศเฉพาะเมื่อข้อความบอกชัด ถ้าไม่ชัดไม่ต้องใส่ ตามด้วยเหตุการณ์สำคัญ จะมีหลายตัวละครหลายเหตุการณ์ก็ได้ เลือกเองว่าอะไรสำคัญ เขียนเป็นภาษาไทยบรรทัดเดียว คั่นแต่ละเรื่องด้วย " · " ไม่เกิน 800 ตัวอักษร ห้ามแต่งข้อมูลที่ข้อความไม่ได้บอก ใช้บริบทเดิมช่วยเข้าใจได้แต่ไม่จดตัวอย่างหรือเนื้อหาตอนก่อนซ้ำ ใส่ครั้งเดียวที่ท้ายคำตอบใน ' + location +
                (" ซึ่งเป็นคีย์ string สุดท้ายใน JSON ที่กำหนด" if structured_output else " แยกจาก marker คำแปล") +
                " บันทึกนี้เป็นข้อยกเว้นเดียวของกฎที่ให้ตอบเฉพาะคำแปล ห้ามใส่ ID คำแปลหรือเครื่องหมาย << และ >> ลงในบันทึก")
    if code == "ja":
        return ('物語の記憶（TP_MEMO）— 全訳文の後に、今回の文章から次の依頼が物語を理解できるよう記録する：登場人物（文中の名前どおり。名前が無ければ「名前不明」と短い特徴、名前を推測しない）、役割や関係、性格や話し方、性別は文中で明確な場合のみ。続けて重要な出来事。人物や出来事は複数でよく、何が重要かは自分で選ぶ。日本語の1行、項目は「 · 」で区切り、800文字以内。文中に無い事実を作らない。以前の文脈は理解の補助とし、例文や前章を再記録しない。回答末尾の ' + location +
                ("（指定JSON内の最後のstringキー）" if structured_output else "（訳文markerとは別）") +
                " に一度だけ入れる。これは訳文だけを返す規則の唯一の例外。記録に翻訳IDや <<、>> を入れない。")
    return ('SERIES MEMORY (TP_MEMO) — After all translations, write notes from this request\'s source so later requests understand the story: the characters who appear (use the name as written; if unnamed write "unknown name" with a short descriptor, never guess a name), their role or relationship, personality or speech style, and gender only when the text states it clearly (otherwise omit it), then the key events. Several characters and events are fine; choose what matters. One line in the selected target language, items separated by " · ", at most 800 characters. Do not invent facts. Use prior context for understanding but do not re-record examples or earlier chapters. Put the notes exactly once at the end of the response in ' + location +
            (" as the final string property in the supplied JSON object" if structured_output else ", separate from translation markers") +
            ". These notes are the only exception to the translation-only rule. Do not put translation IDs or << / >> delimiters inside them.")

def with_summary_schema(schema):
    if schema is None:
        return None
    result = copy.deepcopy(schema)
    result["properties"]["TP_MEMO"] = {"type": "string", "maxLength": LIMIT}
    result["required"] = [*result.get("required", []), "TP_MEMO"]
    return result

def _valid(value):
    return (isinstance(value, str) and bool(value.strip()) and len(value.strip()) <= LIMIT
            and not re.search(r"[\r\n\u2028\u2029]", value) and "<<" not in value and ">>" not in value)

def _native(text):
    source = re.sub(r"^```(?:json)?\s*\n([\s\S]*?)\n```$", r"\1", text.strip())
    try:
        def bad_constant(value):
            raise ValueError(value)
        decoder = json.JSONDecoder(parse_constant=bad_constant)
        def ws(i):
            while i < len(source) and source[i] in " \t\r\n":
                i += 1
            return i
        start = ws(0)
        parsed, complete = decoder.raw_decode(source, start)
        if not isinstance(parsed, dict) or source[complete:].strip():
            return text, "", "invalid"
        i, retained, memos = start + 1, [], []
        while True:
            i = ws(i)
            if source[i] == "}": break
            begin = i
            key, i = decoder.raw_decode(source, i)
            i = ws(i)
            if not isinstance(key, str) or source[i] != ":": raise ValueError("colon")
            i = ws(i + 1)
            value, end = decoder.raw_decode(source, i)
            if key == "TP_MEMO": memos.append(value)
            else: retained.append(source[begin:end])
            i = ws(end)
            if source[i] == ",":
                i += 1
                continue
            if source[i] == "}": break
            raise ValueError("boundary")
        if not memos: return text, "", "missing"
        clean = "{" + ",".join(retained) + "}"
        accepted = len(memos) == 1 and _valid(memos[0])
        return clean, memos[0].strip() if accepted else "", "accepted" if accepted else "invalid"
    except (ValueError, IndexError, TypeError):
        return text, "", "invalid"

def split_summary(raw, *, enabled=False, native_schema=False):
    text = str(raw or "")
    if not enabled: return text, "", "disabled"
    if native_schema: return _native(text)
    cursor, clean, memos = 0, "", []
    for match in re.finditer(r"<<TP_MEMO(?=[:\s>]|$)", text):
        begin = match.start()
        if begin < cursor: continue
        clean += text[cursor:begin]
        clean = re.sub(r"\r?\n$", "", clean)
        pos, nested, closed = begin + 2, [], False
        while pos < len(text):
            next_open, next_close = text.find("<<", pos), text.find(">>", pos)
            if next_close < 0:
                pos = len(text)
                break
            if 0 <= next_open < next_close:
                child_end = text.find(">>", next_open + 2)
                if child_end < 0:
                    nested.append(text[next_open:])
                    pos = len(text)
                    break
                nested.append(text[next_open:child_end + 2])
                pos = child_end + 2
                continue
            pos, closed = next_close + 2, True
            break
        valid = re.fullmatch(r"<<TP_MEMO:([^<>]*?)>>", text[begin:pos])
        if nested and clean and not clean[-1].isspace(): clean += "\n"
        clean += "\n".join(nested)
        memos.append((valid.group(1) if valid else None, pos, closed, bool(nested)))
        cursor = pos
    if not memos: return text, "", "missing"
    clean += text[cursor:]
    value, end, closed, nested = memos[0]
    accepted = len(memos) == 1 and closed and not nested and _valid(value) and not text[end:].strip()
    return re.sub(r"\r?\n$", "", clean), value.strip() if accepted else "", "accepted" if accepted else "invalid"
