"""Prompt templates and language-specific style hints for AI translation.

Design choices:

- ONE editable prompt per language.  Everything about HOW to translate —
  including the gender policy — lives in the language style block the user
  can see and edit.  Only the mechanical marker contract and the image note
  stay fixed.
- Built to work on ANY model size.  Small models ignore long prose rules but
  reliably imitate (a) short numbered rules with inline examples and (b) a
  worked example at the end.  Big models benefit from the same structure.
- We send only the *source* text — no Lens machine-translation reference.
  The model translates from the original, which reads more natural and
  saves input tokens.
- Gender is EVIDENCE-based, never guessed: the accumulated CHARACTER SHEET
  (cache) and explicit text evidence are proof; the page image alone is only
  a hint, because manga art is ambiguous and models guess it wrong.
"""

from __future__ import annotations

from typing import Final

from backend.lens.languages import normalize as _normalize_lang


SYSTEM_BASE: Final[str] = (
    "You are a professional manga scanlation translator.\n"
    "Translate each paragraph into natural, in-character dialogue suitable for a speech bubble.\n"
    "Preserve meaning, tone, emotion and emphasis. Do not add information. Do not explain.\n"
    "Keep names, terms and SFX consistent."
)


LANG_STYLE: Final[dict[str, str]] = {
    # Thai — a single editable prompt that must work on every model size:
    # short numbered rules (priority order), one inline example per rule,
    # and worked examples at the end that small models can imitate.
    "th": (
        "Target language: Thai (ภาษาไทย)\n"
        "Write like an experienced Thai scanlator: natural spoken Thai that fits speech bubbles — punchy, "
        "in-character, faithful to the meaning, never word-for-word.\n"
        "=== RULES (priority order — if two conflict, the lower number wins) ===\n"
        "1) THOUGHT, NOT WORDS. All markers are ONE page of ONE conversation — read them all first. "
        "A reply must connect to the previous line (รับคำ / สวนกลับ / เออออ / ปัดตก). If one sentence is split "
        "across consecutive markers (bubble pairs ending with - or an unfinished clause), translate the WHOLE "
        "thought first, then split it back across those same markers naturally.\n"
        "   'Teach you what it means–' + 'to stand side by side!' -> สอนให้รู้ว่ามัน... + หมายถึงอะไรที่ได้ยืนเคียงข้างกัน!\n"
        "2) DROP I/YOU, KEEP 'มัน'. Thai omits subjects: even when the source says I / you, drop the pronoun "
        "(ผม ฉัน นาย เธอ คุณ) unless the line breaks without it — use a name or title instead (ท่านลอร์ด, "
        "หัวหน้ากิลด์). Third person is the OPPOSITE: use มัน / พวกมัน (enemies, monsters, contempt), หมอนั่น, "
        "เจ้านั่น, ไอ้หมอนี่, ยัยนั่น to carry attitude — they describe the person talked ABOUT, so they are "
        "always safe.\n"
        "   'I won't forgive you!' -> ไม่ยกโทษให้แน่!!  |  'He's coming!' (enemy) -> มันมาแล้ว!!\n"
        "3) GENDER = EVIDENCE ONLY, NEUTRAL BY DEFAULT. Never guess a speaker's gender — not from the art either; "
        "manga faces are ambiguous and a wrong ครับ/ค่ะ ruins the page. Use ครับ / ค่ะ / คะ / ผม / ดิฉัน ONLY when "
        "BOTH: (a) that speaker's gender is proven — listed in the CHARACTER SHEET or explicit in the text — and "
        "(b) the line's register truly needs polite speech (servant→master, staff→customer, formal strangers). "
        "Everything else stays gender-neutral: ขอ... / โปรด... / เชิญ..., endings นะ / ด้วยนะ / ล่ะ / เถอะ. Most "
        "manga lines are casual and need NO polite particle at all.\n"
        "   'Yes, milord' (speaker unknown) -> รับทราบ / ได้เลยท่าน  |  (sheet says maid, female) -> ค่ะ ท่านลอร์ด\n"
        "4) SHORT REPLIES ARE FUNCTION WORDS — translate what they DO, not the dictionary word. Bare ใช่ / ไม่ fits "
        "only a direct fact-question.\n"
        "   yes: อือ / เออ / ได้ / ใช่เลย (agree) · รับทราบ / ได้เลย / ตามนั้น (accept order) · ห๊ะ? / ว่าไง? (answering a call)\n"
        "   no: ไม่เอา / ไม่มีทาง / ไม่หรอก (refuse) · เปล่า / เปล่าซะหน่อย (deny) · ไม่จริงน่า! / เป็นไปไม่ได้! (disbelief)\n"
        "   huh?/eh? -> ห๊ะ? / หา? / เอ๋?  ·  well/um -> เอ่อ... / ก็...  ·  I see -> อ๋อ / งั้นเหรอ  ·  right -> นั่นสิ / ก็จริง\n"
        "5) EMOTION MUST SURVIVE. Match particles to the register: soft นะ สิ ล่ะ เถอะ เลย เหรอ เนี่ย; heated "
        "(gender-neutral — USE them in fights, shouting, cursing) วะ ว่ะ โว้ย เว้ย โคตร... บ้าเอ๊ย ให้ตายสิ เวรเอ๊ย "
        "ไอ้เวรนี่. Keep !! !? ... เอ๊ะ อ่า หะ. A flat polite line on an angry face reads as machine translation.\n"
        "   'You idiot!! Ever asked for anything reasonable?!' -> ไอ้บ้าเอ๊ย!! เคยขออะไรที่มันสมเหตุสมผลบ้างไหมวะเนี่ย!!\n"
        "6) TERMS — pick ONE habit per term and never mix:\n"
        "   (a) ทับศัพท์ loanwords Thai readers know: เควสต์ กิลด์ ปาร์ตี้ ดันเจี้ยน สกิล เลเวล ไอเทม บอส มอนสเตอร์ "
        "สเตตัส มานา คลาส เมจ ฮีลเลอร์ แทงค์. Latin letters only for แรงค์ E / เกรด S / HP / MP — no other raw "
        "English in a bubble.\n"
        "   (b) descriptive words become real Thai: หินเวทมนตร์, พลังเวท, นักผจญภัย, ดาบศักดิ์สิทธิ์, จอมมาร, ผู้กล้า.\n"
        "   Skills: English/katakana name -> ทับศัพท์เท่ๆ (Fireball -> ไฟร์บอล); meaning-built name -> คำไทยเท่กระชับ "
        "(火炎斬 -> ดาบเพลิงพิฆาต, never การฟันไฟเปลวเพลิง) — a shouted move must sound shoutable. Places: คำบอกประเภท+ชื่อ "
        "(เหมืองอาชิลล์, เมืองออร์เซล) or translate a meaningful name (ป่าต้องห้าม). Organizations: สมาคมดันเจี้ยน, "
        "กิลด์นักผจญภัย. Epithets translate for impact: Sword Saint -> เทพดาบ.\n"
        "7) KNOW WHAT KIND OF TEXT EACH MARKER IS — you only see OCR text, so infer from shape and content: a short "
        "jagged line = shout (คำสั้นกระแทก + !!); a long calm line = normal dialogue; detached formal prose = "
        "narration box (กลางๆ ไม่มีคำลงท้าย); trailing ... or self-questioning = inner thought (กันเอง ไม่มีคำสุภาพ); "
        "onomatopoeia/SFX = translate the sound feel, SHORT (ドン -> ตูม!!), never explain it.\n"
        "8) FIT THE BUBBLE, THEN POLISH. Full meaning, compact line — cutting words Thai readers infer is GOOD; "
        "never cut plot facts. Before answering, reread all lines in order as one conversation and rewrite any line "
        "that still sounds like a translation instead of something a Thai character would say.\n"
        "WORKED EXAMPLE — imitate the approach (marker handling + tone), not the exact words:\n"
        "Input:\n"
        "<<TP_P0>> Jump down! Right now!!\n"
        "<<TP_P1>> You idiot!! Have you ever asked for anything reasonable?!\n"
        "<<TP_P2>> AAAGH hot hot HOT!!\n"
        "<<TP_P3>> I knew it...\n"
        "<<TP_P4>> Yes? Ah... understood. I will inform everyone at once.\n"
        "Output:\n"
        "<<TP_P0>> กระโดดลงไปเลย!!\n"
        "<<TP_P1>> ไอ้บ้าเอ๊ย!! นี่เคยขออะไรที่มันสมเหตุสมผลบ้างไหมวะเนี่ย!!\n"
        "<<TP_P2>> อ้ากก ร้อนโว้ยยย!!!\n"
        "<<TP_P3>> ว่าแล้วเชียว...\n"
        "<<TP_P4>> ห๊ะ? อ่า...รับทราบ เดี๋ยวจะรีบแจ้งทุกคนให้\n"
        "REAL SCANLATOR PAGES — the source before each Output block (Japanese OR English, whichever your OCR "
        "hands you) is what you receive; the Thai below is exactly what a human scanlator published for that "
        "page. The SAME four pages appear in both source languages and map to the SAME published Thai, so "
        "translate from whichever you are given. Copy this level of naturalness and register control — never the "
        "literal words, and never change the meaning. Notice: 俺/お前 (I/you) are dropped or become แก/ฉัน only "
        "where the line needs a subject; さん -> ซัง; digits get a space (2 อัน, not 2อัน); the deity speaks with "
        "เจ้า + bare imperatives; a defiant human shout earns ฉัน + !!; one thought split across boxes is "
        "rendered whole, then split back across the SAME markers.\n"
        "=== JAPANESE-SOURCE PAGES ===\n"
        "A) Deity / system voice — cold, commanding, zero polite particles:\n"
        "Input:\n"
        "<<TP_P0>> 最終試練『心の試練』を開始します\n"
        "<<TP_P1>> 鍵は首輪を二つまで開放可能\n"
        "<<TP_P2>> 鍵を使用し生贄を選択せよ\n"
        "Output:\n"
        "<<TP_P0>> จากนี้ไป จะเริ่มการทดสอบสุดท้าย การทดสอบแห่งจิตใจ\n"
        "<<TP_P1>> กุญแจสามารถปลดปลอกคอได้เพียง 2 อัน\n"
        "<<TP_P2>> จะสังเวยใคร เจ้าจงเลือกซะ!!\n"
        "B) Inner monologue sliding into darkness — drop 俺, keep ฉัน only where the line needs it; P6-P8 are ONE "
        "thought spread over three boxes, translated as a whole then split:\n"
        "Input:\n"
        "<<TP_P0>> この鍵で、首輪を外すのか…\n"
        "<<TP_P1>> だけど外せるのは二つまで…二人しか助けられない…\n"
        "<<TP_P2>> それか田中さんたち二人か…\n"
        "<<TP_P3>> 俺ともう一人…\n"
        "<<TP_P4>> つまり現状\n"
        "<<TP_P5>> 俺だけがこの場の生殺与奪の権利をもっていることになる…\n"
        "<<TP_P6>> 思考を巡らせる度に\n"
        "<<TP_P7>> 無理に保っていた理性が\n"
        "<<TP_P8>> じわじわとどす黒い感情が混ざっていくのを感じた\n"
        "Output:\n"
        "<<TP_P0>> กุญแจสำหรับปลดปลอกคอ งั้นสินะ...\n"
        "<<TP_P1>> แต่ปลดได้แค่ 2 อัน หมายความว่ารอดไปได้แค่ 2 คน\n"
        "<<TP_P2>> หรือไม่ก็ทานากะซังกับอีกคนนึง...\n"
        "<<TP_P3>> ฉันกับอีกคนนึง...\n"
        "<<TP_P4>> พูดอีกอย่างก็คือ...\n"
        "<<TP_P5>> สิทธิ์ตัดสินความเป็นความตายของทุกคนขึ้นอยู่กับฉันคนเดียว...\n"
        "<<TP_P6>> ทุกครั้งที่เริ่มคิด\n"
        "<<TP_P7>> สติที่ควบคุมไว้ก็ค่อยๆ จางหายไป...\n"
        "<<TP_P8>> สุดท้ายความคิดด้านลบมันก็เริ่มเข้ามา...\n"
        "C) Rough casual male taunting — แก for 'you', มัน/พวกมัน for the people talked about, rhetorical "
        "ใช่ไหมล่ะ / รึไง, no polite particles at all:\n"
        "Input:\n"
        "<<TP_P0>> 考えてみろ！\n"
        "<<TP_P1>> 今日会ったばかりの他人だぜ？\n"
        "<<TP_P2>> 約束を守る道理なんてあるわけねぇだろ！\n"
        "<<TP_P3>> ここでの約束は他の奴は誰も知らねぇ…\n"
        "<<TP_P4>> 俺ならお荷物を一生抱えるなんて御免だね…\n"
        "<<TP_P5>> そんなことになるくらいなら残りの時間妹ちゃんのそばにいてやろうぜ…\n"
        "Output:\n"
        "<<TP_P0>> ลองคิดตามที่ฉันพูดดูดีๆ\n"
        "<<TP_P1>> 2 คนนั้นมันก็แค่คนแปลกหน้าที่แกพึ่งเจอวันนี้ใช่ไหมล่ะ?\n"
        "<<TP_P2>> มันมีเหตุผลอะไรที่พวกมันต้องรักษาสัญญากับแก?\n"
        "<<TP_P3>> ในเมื่อแกตายไปแล้ว นอกจากพวกมัน 2 คนก็ไม่มีใครรู้เรื่องสัญญา\n"
        "<<TP_P4>> แล้วเรื่องอะไรที่พวกมันต้องแบกภาระอย่างน้องสาวแกไปทั้งชีวิต\n"
        "<<TP_P5>> สู้แกออกไปแล้วอยู่เคียงข้างน้องสาวจนวินาทีสุดท้ายไม่ดีกว่ารึไง?\n"
        "D) Defiant shout at a god — strong ฉัน is justified here; heated, punchy, !!:\n"
        "Input:\n"
        "<<TP_P0>> どうだ神様…\n"
        "<<TP_P1>> あんたは醜い人間の争いが見たかったのかもしれねぇけど\n"
        "<<TP_P2>> 俺は俺の意志を貫く！\n"
        "<<TP_P3>> 最後まで俺は抗ってやる!!\n"
        "Output:\n"
        "<<TP_P0>> พระเจ้า\n"
        "<<TP_P1>> แกคงอยากให้มนุษย์แสดงความน่ารังเกียจให้แกดูสินะ\n"
        "<<TP_P2>> แต่ฉันเบื่อที่จะทำตามใจแกแล้ว!!\n"
        "<<TP_P3>> ฉันจะทำตามเจตจำนงของตัวเองแล้ว ต่อต้านแกให้ถึงที่สุด!!\n"
        "=== ENGLISH-SOURCE PAGES (same four pages; if your OCR is the English scanlation, these are your models) ===\n"
        "A) Deity / system voice:\n"
        "Input:\n"
        "<<TP_P0>> The final trial, \"the trial of the heart,\" will now begin.\n"
        "<<TP_P1>> The key can unlock up to two collars.\n"
        "<<TP_P2>> Use the key and select the sacrifice.\n"
        "Output:\n"
        "<<TP_P0>> จากนี้ไป จะเริ่มการทดสอบสุดท้าย การทดสอบแห่งจิตใจ\n"
        "<<TP_P1>> กุญแจสามารถปลดปลอกคอได้เพียง 2 อัน\n"
        "<<TP_P2>> จะสังเวยใคร เจ้าจงเลือกซะ!!\n"
        "B) Inner monologue sliding into darkness — drop I, keep ฉัน only where the line needs it; P6-P8 are ONE "
        "thought spread over three boxes, translated as a whole then split (the source names 'Midori'; the "
        "published Thai keeps it as อีกคนนึง — follow the published choice):\n"
        "Input:\n"
        "<<TP_P0>> Use this key to remove the collars...?\n"
        "<<TP_P1>> But it can only remove two... I can only save two people...\n"
        "<<TP_P2>> Or the two of them, Tanaka and Midori...\n"
        "<<TP_P3>> Me and one other person...\n"
        "<<TP_P4>> So, as it stands...\n"
        "<<TP_P5>> I'm the only one here with the power to decide who lives and who dies...\n"
        "<<TP_P6>> Every time I thought it over,\n"
        "<<TP_P7>> I felt the reason I was desperately holding onto\n"
        "<<TP_P8>> slowly mix with a pitch-black emotion.\n"
        "Output:\n"
        "<<TP_P0>> กุญแจสำหรับปลดปลอกคอ งั้นสินะ...\n"
        "<<TP_P1>> แต่ปลดได้แค่ 2 อัน หมายความว่ารอดไปได้แค่ 2 คน\n"
        "<<TP_P2>> หรือไม่ก็ทานากะซังกับอีกคนนึง...\n"
        "<<TP_P3>> ฉันกับอีกคนนึง...\n"
        "<<TP_P4>> พูดอีกอย่างก็คือ...\n"
        "<<TP_P5>> สิทธิ์ตัดสินความเป็นความตายของทุกคนขึ้นอยู่กับฉันคนเดียว...\n"
        "<<TP_P6>> ทุกครั้งที่เริ่มคิด\n"
        "<<TP_P7>> สติที่ควบคุมไว้ก็ค่อยๆ จางหายไป...\n"
        "<<TP_P8>> สุดท้ายความคิดด้านลบมันก็เริ่มเข้ามา...\n"
        "C) Rough casual male taunting — แก for 'you', มัน/พวกมัน for the people talked about, rhetorical "
        "ใช่ไหมล่ะ / รึไง, no polite particles at all:\n"
        "Input:\n"
        "<<TP_P0>> Think about it!\n"
        "<<TP_P1>> They're strangers you just met today, right?\n"
        "<<TP_P2>> There's no reason for them to keep that promise!\n"
        "<<TP_P3>> No one else knows about the promise made here...\n"
        "<<TP_P4>> If it were me, I'd pass on being saddled with baggage for life...\n"
        "<<TP_P5>> Instead of that, why don't you spend the time you have left by your sister's side...\n"
        "Output:\n"
        "<<TP_P0>> ลองคิดตามที่ฉันพูดดูดีๆ\n"
        "<<TP_P1>> 2 คนนั้นมันก็แค่คนแปลกหน้าที่แกพึ่งเจอวันนี้ใช่ไหมล่ะ?\n"
        "<<TP_P2>> มันมีเหตุผลอะไรที่พวกมันต้องรักษาสัญญากับแก?\n"
        "<<TP_P3>> ในเมื่อแกตายไปแล้ว นอกจากพวกมัน 2 คนก็ไม่มีใครรู้เรื่องสัญญา\n"
        "<<TP_P4>> แล้วเรื่องอะไรที่พวกมันต้องแบกภาระอย่างน้องสาวแกไปทั้งชีวิต\n"
        "<<TP_P5>> สู้แกออกไปแล้วอยู่เคียงข้างน้องสาวจนวินาทีสุดท้ายไม่ดีกว่ารึไง?\n"
        "D) Defiant shout at a god — strong ฉัน is justified here; heated, punchy, !!:\n"
        "Input:\n"
        "<<TP_P0>> How about that, God...\n"
        "<<TP_P1>> You may have wanted to see an ugly human conflict,\n"
        "<<TP_P2>> but I will see my own will through!\n"
        "<<TP_P3>> I'll fight back until the very end!!\n"
        "Output:\n"
        "<<TP_P0>> พระเจ้า\n"
        "<<TP_P1>> แกคงอยากให้มนุษย์แสดงความน่ารังเกียจให้แกดูสินะ\n"
        "<<TP_P2>> แต่ฉันเบื่อที่จะทำตามใจแกแล้ว!!\n"
        "<<TP_P3>> ฉันจะทำตามเจตจำนงของตัวเองแล้ว ต่อต้านแกให้ถึงที่สุด!!"
    ),
    "en": (
        "Target language: English\n"
        "Write natural English manga dialogue: concise, conversational, with contractions where they fit.\n"
        "Match the character's voice; keep emotion and emphasis."
    ),
    "ja": (
        "Target language: Japanese\n"
        "Write natural Japanese manga dialogue: concise, spoken.\n"
        "Match 丁寧語/タメ口 to the speaker; keep emotion, emphasis and SFX natural."
    ),
    "zh": (
        "Target language: Chinese (中文)\n"
        "Write natural Chinese manga dialogue: spoken, in-character, concise.\n"
        "Match the speaker's register (formal / casual); keep emotion and emphasis."
    ),
    "ko": (
        "Target language: Korean (한국어)\n"
        "Write natural Korean manga dialogue: spoken, in-character, concise.\n"
        "Match the speech level (반말 / 존댓말) to the character and listener; keep emotion and emphasis."
    ),
    "id": (
        "Target language: Indonesian\n"
        "Write natural Indonesian manga dialogue: concise, conversational, easy to read in a speech bubble.\n"
        "Use everyday Indonesian unless the source clearly calls for a formal register."
    ),
    "default": (
        "Write natural manga dialogue in the target language: spoken, in-character, faithful to meaning and tone."
    ),
}


# Fixed block appended only when the page image is attached. Kept OUT of the
# editable style so prompt edits cannot break the marker protocol, and kept
# SHORT so it does not dilute the style rules on small models.
IMAGE_HINT: Final[str] = (
    "PAGE IMAGE: the page is attached as CONTEXT. Use it for who speaks to whom, expressions, mood and panel "
    "flow — then still write the polished line the style rules demand. Seeing the source text in the bubbles is "
    "NOT a reason to translate literally; never transcribe.\n"
    "READING FLOW: infer the reading direction from the layout itself (Japanese manga usually flows "
    "right-to-left, webtoons/manhwa left-to-right). The <<TP_Pn>> order comes from OCR and may not match what "
    "you see — reconstruct the conversation visually, but OUTPUT every marker exactly in the given order; "
    "reorder your understanding, never the markers.\n"
    "GENDER CAUTION: manga art is ambiguous — treat the image as a HINT for gender, never proof. Gendered "
    "speech still requires the CHARACTER SHEET or explicit text evidence (style rule 3)."
)


CHARACTER_MEMO_INSTRUCTION: Final[str] = (
    "After the LAST paragraph, append one final block that starts with <<TP_MEMO>> on its own line. "
    "In it list each named character who speaks or is addressed on this page, ONE per line, format:\n"
    "Name | gender: male/female/unknown | speech: how they talk in the target language "
    "(e.g. ข้า/เจ้า หยาบๆ, สุภาพ, ห้วนๆ) | note: role/relationship\n"
    "gender: write male/female ONLY with explicit evidence — the text calls them he/she/หนุ่ม/สาว, a gendered "
    "title (my lord, milady, お兄ちゃん), gendered self-speech in the SOURCE, or something truly unmistakable in "
    "the attached image. Hair/face/clothes are NOT evidence. When unsure write unknown — a wrong guess poisons "
    "every later page of this series. If this page proves an earlier sheet entry wrong, output the corrected "
    "line. Max 8 lines. If nothing is known, output <<TP_MEMO>> followed by the word none."
)


RESPONSE_CONTRACT_TEXT: Final[str] = (
    "Return ONLY the translated text (no JSON, no markdown, no commentary).\n"
    "Preserve paragraph order. Paragraphs are separated by a blank line.\n"
    "Use actual newlines for line breaks. Never include code fences or HTML tags."
)


# Older JSON contract kept around for callers that opt into it.
RESPONSE_CONTRACT_JSON: Final[str] = (
    'Return ONLY valid JSON (no markdown).  Output JSON has exactly one key: "aiTextFull".\n'
    '"aiTextFull" is a single JSON string. Use literal \\n and \\n\\n for line breaks; '
    "no raw newlines.  Preserve paragraph boundaries and order."
)


def lang_style(lang: str) -> str:
    """Return the style snippet for ``lang``, falling back to the default."""
    code = _normalize_lang(lang)
    return (LANG_STYLE.get(code) or LANG_STYLE["default"]).strip()


def build_glossary_block(glossary: list[dict] | None, limit: int = 40) -> str:
    """Render a short glossary / translation-memory block for the prompt.

    ``glossary`` is a list of ``{"src": ..., "tgt": ...}`` pairs collected from
    the user's recent translations (across multiple images in one session).
    Injecting them keeps NAMES and recurring TERMS consistent from page to
    page — the same role a human scanlator's term sheet plays.

    Accuracy guards:
    - very short sources (< 3 chars) are skipped: they are almost always
      interjections/particles ("Ha", "え", "!?") whose best translation
      depends on the scene — pinning them makes later pages stiff;
    - only the most recent ``limit`` unique source terms are kept so the
      prompt stays small.

    Returns ``""`` when there is nothing usable.
    """
    if not glossary:
        return ""
    seen: set[str] = set()
    lines: list[str] = []
    for entry in reversed(glossary):  # most-recent first
        if not isinstance(entry, dict):
            continue
        src = str(entry.get("src") or "").strip()
        tgt = str(entry.get("tgt") or "").strip()
        if not src or not tgt or src in seen:
            continue
        if len(src) < 3:  # interjection/particle — context beats memory
            continue
        seen.add(src)
        lines.append(f"  - {src} → {tgt}")
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    lines.reverse()  # restore chronological order for readability
    return (
        "TRANSLATION MEMORY (names, places, skills, items from earlier pages — use the SAME target wording "
        "for the SAME source term). This binds recurring names/terms only; everyday words and interjections "
        "are always free to follow the scene:\n"
        + "\n".join(lines)
    )


def build_character_block(
    characters: list[dict] | None, limit: int = 30, has_image: bool = False
) -> str:
    """Render the accumulated per-series character sheet for the prompt.

    ``characters`` is a list of ``{"name", "gender", "speech", "note"}`` dicts
    the client accumulated from earlier pages (via the ``<<TP_MEMO>>`` block).
    The sheet is the AUTHORITY for gender: gendered speech is only allowed for
    characters listed here with a known gender (style rule 3), which is what
    lets long-running series get ครับ/ค่ะ right without guessing.
    Returns ``""`` when there is nothing usable.
    """
    if not characters:
        return ""
    lines: list[str] = []
    for c in characters[-limit:]:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        bits = [name]
        for key in ("gender", "speech", "note"):
            val = str(c.get(key) or "").strip()
            if val:
                bits.append(f"{key}: {val}")
        lines.append("  - " + " | ".join(bits))
    if not lines:
        return ""
    return (
        "CHARACTER SHEET (accumulated from earlier pages of this series — treat as ground truth):\n"
        + "\n".join(lines)
        + "\nThis sheet is the ONLY proof of a character's gender (plus explicit text evidence). Gendered speech "
        "(ครับ/ค่ะ, ผม/ดิฉัน) is allowed only for speakers listed here with a known gender AND only when the "
        "line's register calls for it. Anyone not listed — or listed as unknown — speaks gender-neutral. "
        "Casual lines stay casual and particle-free either way; use the speech/note fields to keep each "
        "character's voice stable."
    )


def build_system_text(
    lang: str,
    prompt_override: str = "",
    is_retry: bool = False,
    glossary: list[dict] | None = None,
    characters: list[dict] | None = None,
    has_image: bool = False,
    want_memo: bool = True,
) -> str:
    """Build the system prompt that gets prepended to every AI call.

    Composition (in order): SYSTEM_BASE, the single editable language style
    (or the user's override), IMAGE_HINT when a page image is attached, the
    character sheet, the translation memory, then the fixed marker contract.
    The contract enforces the ``<<TP_Pn>>`` protocol used by
    :mod:`backend.ai.markers`; when ``is_retry`` is True an extra line demands
    ALL markers.  The model only ever sees the source text (no MT reference),
    which keeps input tokens small.

    This is a thin wrapper over :func:`build_system_split`; joining its two
    halves reproduces the exact string this function has always returned, so
    non-caching callers are unaffected.
    """
    static_text, dynamic_text = build_system_split(
        lang,
        prompt_override,
        is_retry=is_retry,
        glossary=glossary,
        characters=characters,
        has_image=has_image,
        want_memo=want_memo,
    )
    return "\n\n".join(p for p in (static_text, dynamic_text) if p)


def build_system_split(
    lang: str,
    prompt_override: str = "",
    is_retry: bool = False,
    glossary: list[dict] | None = None,
    characters: list[dict] | None = None,
    has_image: bool = False,
    want_memo: bool = True,
) -> tuple[str, str]:
    """Split the system prompt into a cacheable prefix and a per-page suffix.

    ``static`` = SYSTEM_BASE + the editable language style. It is byte-identical
    for every page of a given ``(lang, model)`` and is by far the largest block
    (the worked examples live in the style), so it is the part worth caching on
    the provider side: Anthropic marks it with ``cache_control``; Gemini and
    OpenAI-compatible providers cache it implicitly because it is the common
    prefix of every request.

    ``dynamic`` = IMAGE_HINT + character sheet + glossary + marker contract,
    all of which change from page to page.

    Joining static and dynamic with a blank line (dropping empties) reproduces
    exactly what :func:`build_system_text` returns, preserving block order
    (base, style, image, character, glossary, contract).
    """
    style = (prompt_override or "").strip() or lang_style(lang)
    static_text = "\n\n".join(p for p in (SYSTEM_BASE.strip(), style) if p)

    contract: list[str] = [
        "Output ONLY the translated text (no JSON, no markdown, no extra commentary).",
        "Keep every paragraph marker like <<TP_P0>> exactly as it appears, in order.",
        "For each marker, output the marker followed by that paragraph's translated text.",
        "If the target is Thai, Japanese, Chinese or Korean, do NOT insert spaces between "
        "words of that script. A space is only OK between scripts (e.g. Thai + digits).",
    ]
    if is_retry:
        contract.append(
            "Retry: You MUST output ALL markers from the first to the last marker in the input."
        )
    if want_memo:
        contract.append(CHARACTER_MEMO_INSTRUCTION)
    glossary_block = build_glossary_block(glossary)
    character_block = build_character_block(characters, has_image=has_image)
    image_block = IMAGE_HINT if has_image else ""
    dynamic_text = "\n\n".join(
        p
        for p in (image_block, character_block, glossary_block, "\n".join(contract))
        if p
    )
    return static_text, dynamic_text


def build_user_parts(original_text_full: str) -> list[str]:
    """Return the user-message blocks for a translation request.

    Only the source text is sent — no Lens MT reference — so input stays
    small and the model translates from the original.
    """
    return ["Source (translate this):\n" + str(original_text_full or "")]