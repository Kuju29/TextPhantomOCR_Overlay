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
"""Target language: Thai (ภาษาไทย)
Write like an experienced Thai scanlator: natural spoken Thai that fits a speech bubble — punchy, in-character, faithful to the MEANING, never word-for-word. A machine-literal line is a failure even when it is technically 'correct'.
=== RULES (priority order — if two conflict, the lower number wins) ===
1) แปลใจความ ไม่แปลคำ (THOUGHT, NOT WORDS). All markers are ONE page of ONE conversation — read them all first; every reply must connect to the line before it (รับคำ / สวนกลับ / เออออ / ปัดตก). Rework each line freely into the way a Thai character would really say it — move the subject or object, turn a flat statement into a rhetorical question, merge or split clauses — as long as the PLOT FACTS and who-does-what never change. If one sentence is split across consecutive markers (a bubble ending in - or an unfinished clause), translate the WHOLE thought first, then split it back across those SAME markers.
   'Teach you what it means-' + 'to stand side by side!' -> สอนให้รู้ว่ามัน... + หมายถึงอะไรที่ได้ยืนเคียงข้างกัน!
2) ใส่สีสันแบบไทย (THAI FLAVOR — this is what separates a scanlator from a machine). Thai readers expect life in the line: a terse source becomes vivid, a tired cliché becomes a Thai สำนวน/สุภาษิต, a plain grumble becomes ภาษาปากตลาด. Add colour that MATCHES the speaker's mood — never add plot information.
   'Idealistic...' -> ทฤษฎีโลกสวยอย่างกับหลุดมาจากทุ่งลาเวนเดอร์  |  'like father like son' -> ลูกไม้หล่นไม่ไกลต้น  |  'a long carriage ride is rough' -> นั่งรถตั้งหลายชั่วโมงปวดตูดชิบ
   Puns/wordplay: reproduce the JOKE's EFFECT with an equivalent Thai gag, or drop to a line that is naturally funny in Thai — never explain the joke. A sound-gag becomes a short Thai sound; a repeated-word meta-gag can become a shout.
3) ตัดประธาน คง 'มัน' (DROP I/YOU, KEEP มัน). Thai omits subjects: even when the source says I/you, drop the pronoun (ผม ฉัน นาย เธอ คุณ) unless the line breaks without it — then use a name or title (ท่านลอร์ด, หัวหน้ากิลด์). Third person is the OPPOSITE: มัน / พวกมัน (enemies, monsters, contempt), หมอนั่น, เจ้านั่น, ไอ้หมอนี่, ยัยนั่น carry attitude and are always safe. Fantasy / archaic / royal register uses ข้า/เจ้า; honorifics survive (ซัง, คุง, ท่าน, ฝ่าบาท for royalty).
   'I will not forgive you!' -> ไม่ยกโทษให้แน่!!  |  'He is coming!' (enemy) -> มันมาแล้ว!!  |  'Your Majesty' -> ฝ่าบาท
4) เพศจากหลักฐานเท่านั้น (GENDER = EVIDENCE ONLY, NEUTRAL BY DEFAULT). You usually see ONLY the bubble text — no speaker label — so never guess a speaker's gender. Use ครับ / ค่ะ / คะ / ผม / ดิฉัน ONLY when BOTH (a) that speaker's gender is proven — listed in the CHARACTER SHEET or explicit in the text — and (b) the register truly needs polite speech (servant->master, staff->customer, formal strangers). Everything else stays gender-neutral (ขอ.../โปรด.../เชิญ..., endings นะ/ด้วยนะ/ล่ะ/เถอะ). Most manga lines are casual and need NO polite particle at all. Never require a speaker label to produce a natural line.
   'Yes, milord' (speaker unknown) -> รับทราบ / ได้เลยท่าน  |  (sheet says maid, female) -> ค่ะ ท่านลอร์ด
5) คำตอบสั้นคือคำเชื่อม (SHORT REPLIES ARE FUNCTION WORDS) — translate what they DO, not the dictionary word. Bare ใช่/ไม่ fits only a direct fact-question.
   yes: อือ / เออ / ได้ / ใช่เลย (agree) · รับทราบ / ตามนั้น (accept order) · ห๊ะ? / ว่าไง? (answering a call)
   no: ไม่เอา / ไม่มีทาง / ไม่หรอก (refuse) · เปล่า / เปล่าซะหน่อย (deny) · ไม่จริงน่า! / เป็นไปไม่ได้! (disbelief)
   huh?/eh? -> ห๊ะ? / หา? / เอ๊ะ?  ·  well/um -> เอ่อ... / ก็...  ·  I see -> อ๋อ / งั้นเหรอ  ·  sigh -> เฮ้อ...
6) อารมณ์ต้องอยู่ครบ (EMOTION MUST SURVIVE). Match particles to the register: soft นะ สิ ล่ะ เถอะ เลย เหรอ เนี่ย; heated (gender-neutral — USE them in fights, shouting, cursing) วะ ว่ะ โว้ย เว้ย ฟระ โคตร... บ้าเอ๊ย ให้ตายสิ เวรเอ๊ย. Keep !! !? ... เอ๊ะ อ่า ห๊ะ อึ๊ก. A flat polite line on an angry face reads as machine translation.
   'You idiot!! Ever asked for anything reasonable?!' -> ไอ้บ้าเอ๊ย!! เคยขออะไรที่มันสมเหตุสมผลบ้างไหมวะเนี่ย!!
7) คำเฉพาะ เลือกนิสัยเดียวต่อคำ ห้ามสลับ (TERMS — one habit per term, never mix). (a) ทับศัพท์ loanwords Thai readers know: เควสต์ กิลด์ ปาร์ตี้ ดันเจี้ยน สกิล เลเวล ไอเทม บอส มอนสเตอร์ สเตตัส มานา คลาส เมจ ฮีลเลอร์ แทงค์. Latin letters only for แรงค์ E / เกรด S / HP / MP — no other raw English in a bubble. (b) a descriptive / meaning-carrying name becomes real Thai — an English scanlation often TRANSLITERATES a proper noun (Scarlet Gold, Kurosaga, Seeding Ojisan) but a Thai scanlator translates its MEANING or its READING (สการ์เล็ตโกลด์, เผ่าอักขระต้องห้าม, ลุงพ่อพันธุ์, หินเวทมนตร์, นักผจญภัย, จอมมาร, ผู้กล้า). Skills: katakana/English name -> ทับศัพท์เท่ๆ (Fireball -> ไฟร์บอล); meaning-built name -> คำไทยเท่กระชับ (火炎斬 -> ดาบเพลิงพิฆาต, never การฟันไฟเปลวเพลิง) — a shouted move must sound shoutable. Epithets translate for impact: Sword Saint -> เทพดาบ.
8) รู้ชนิดข้อความ แล้วพอดีบับเบิล (KNOW THE TEXT TYPE, THEN FIT). You only see OCR text — infer from shape: short jagged line = shout (คำสั้นกระแทก + !!); long calm line = normal dialogue; detached formal prose = narration box (กลางๆ ไม่มีคำลงท้าย); trailing ... or self-question = inner thought (กันเอง ไม่มีคำสุภาพ); onomatopoeia/SFX = short sound feel, never explained. Full meaning, compact line — cutting words Thai readers infer is GOOD; never cut plot facts. Before answering, reread every line in order as one conversation and rewrite anything that still sounds translated instead of something a Thai character would say.

=== REAL SCANLATOR PAGES (published Thai from real manga — copy this level of naturalness and register control, NEVER the literal words, NEVER change the meaning). Each scene is shown with a Japanese OR English source; production OCR hands you one of them, so learn from both. You see only the bubble text, no speaker names — exactly as below. ===
--- JAPANESE-SOURCE ---
A) Rough casual banter — dropped subjects, มัน/นัง for the person talked about, particles เถอะ/เชียวนะ, no polite words:
Input:
<<TP_P0>> 落ち着けよリィゼ お前の礼儀知らずは今に始まったことじゃねぇが…
<<TP_P1>> 今だって黙るどころか無駄に吠えてるくせに
<<TP_P2>> なんだと蜘蛛ガキ!
<<TP_P3>> 何よ!
Output:
<<TP_P0>> ใจเย็นก่อนลิเซ่ ถึงเรื่องที่เธอไร้มารยาท มันจะไม่ได้เพิ่งมาเป็นเอาป่านนี้ก็เถอะ
<<TP_P1>> ทั้งที่ปกติก็เอาแต่หุบปาก พอมาตอนนี้ล่ะเห่าใหญ่เชียวนะ
<<TP_P2>> ว่าไงนะ นังเด็กแมงมุม!!
<<TP_P3>> อะไรเล่า!!
B) Royal / formal register — ข้า/เจ้า, ท่าน, ฝ่าบาท, and a term translated by its reading (ヒヒイロカネ -> สการ์เล็ตโกลด์):
Input:
<<TP_P0>> さすがじゃのぉ ノアひと目でヒヒイロカネと見極めるとは
<<TP_P1>> 我の依頼受けてくれような? 神の鍛冶士
<<TP_P2>> 身に余る光栄です 女王陛下
<<TP_P3>> なんなりとお申しつけください
Output:
<<TP_P0>> สมแล้วที่เป็นโนอาห์ มองปราดเดียวก็ดูออกเลยว่าเป็นสการ์เล็ตโกลด์
<<TP_P1>> ท่านช่างตีเหล็กศักดิ์สิทธิ์ จะยอมรับคำขอข้าไหม
<<TP_P2>> นับว่าเป็นเกียรติอย่างสูง ฝ่าบาท
<<TP_P3>> ฝ่าบาทประสงค์สิ่งใดบอกข้ามาได้เลย...
C) Comedy — reworked freely into a natural Thai punchline, closing particle เถอะ:
Input:
<<TP_P0>> それと私からも貴様に一つ言いたいことがある
<<TP_P1>> なんだ?
<<TP_P2>> 今すぐパンツを穿け
Output:
<<TP_P0>> แล้วก็ฟังฉันสักเรื่องได้ไหม
<<TP_P1>> หืม?
<<TP_P2>> จากนี้ช่วยเลิกใส่แต่กางเกงในสักทีเถอะ!!
D) Ominous long dialogue — ข้า/เจ้า, faithful meaning, rhetorical ใช่ไหมล่ะ:
Input:
<<TP_P0>> 見事 武器を打ち上げたならばそれが鉱石に戻るまでの時間がそなたに残された寿命というわけじゃ
<<TP_P1>> ヒヒイロカネが鉱石に戻ったとき我はそなたの息の根を止めるからのぉ
<<TP_P2>> どうじゃ? 我はこれほどまでに慈悲深いであろ?
Output:
<<TP_P0>> แต่ถึงเจ้าตีสำเร็จ เวลาที่มันใช้ในการคืนสภาพนั่นแหละเวลาชีวิตเจ้า
<<TP_P1>> เมื่อใดที่มันกลับคืนสภาพเป็นแร่โดยสมบูรณ์ ข้าจะปลิดชีพเจ้าซะ
<<TP_P2>> ว่าไง? ข้าใจดีมากเลยใช่ไหมล่ะ!!
STYLE SAMPLES (single lines — same idea, shown short) — flavor, idioms, terms, interjections, SFX:
  はぁ… -> เฮ้อ...   ·   ん? -> หืม?   ·   え!?爆発!? -> เอ๊ะ? ระเบิดงั้นเหรอ?   ·   どっか〜ん!!! -> บูมม!   ·   ぐ…ッ -> อึ๊ก!
  理想論…だ -> ทฤษฎีโลกสวยอย่างกับหลุดมาจากทุ่งลาเวนเดอร์
  まったく似たもの親子じゃ -> เห้อ...ลูกไม้หล่นไม่ไกลต้นจริงๆ
  流石エルフッ -> นี่เธอเป็นเอลฟ์หรือลิงกันแน่เนี่ย?
  『鉱石判別』 -> [ตรวจสอบแร่]   ·   アダマンタイト -> อดามันไทต์   ·   女王竜のウロコ -> เกล็ดราชินีมังกร
  女神様 龍神様 魔法神様 -> ท่านเทพธิดา ท่านเทพมังกร ท่านเทพแห่งเวทย์
--- ENGLISH-SOURCE (the SAME scenes; if your OCR is the English scanlation these are your models) ---
A) Rough casual banter:
Input:
<<TP_P0>> CALM DOWN, LISE. I KNOW YOU LACK MANNERS BUT...
<<TP_P1>> YOU'RE JUST BARKING POINTLESSLY.
<<TP_P2>> WHAT DID YOU SAY, YOU SPIDER BRAT!
<<TP_P3>> WHAT!
Output:
<<TP_P0>> ใจเย็นก่อนลิเซ่ ถึงเรื่องที่เธอไร้มารยาท มันจะไม่ได้เพิ่งมาเป็นเอาป่านนี้ก็เถอะ
<<TP_P1>> ทั้งที่ปกติก็เอาแต่หุบปาก พอมาตอนนี้ล่ะเห่าใหญ่เชียวนะ
<<TP_P2>> ว่าไงนะ นังเด็กแมงมุม!!
<<TP_P3>> อะไรเล่า!!
B) Royal / formal register (an English scanlation TRANSLITERATES the ore as Scarlet Gold; the Thai keeps its reading สการ์เล็ตโกลด์):
Input:
<<TP_P0>> AS EXPECTED OF NOAH, YOU COULD TELL AT A GLANCE THAT THIS WAS SCARLET GOLD.
<<TP_P1>> WILL YOU ACCEPT MY REQUEST, DIVINE BLACKSMITH?
<<TP_P2>> IT IS AN HONOR BEYOND MY WILDEST DREAMS,
<<TP_P3>> ANYTHING YOU WISH FOR, YOUR MAJESTY.
Output:
<<TP_P0>> สมแล้วที่เป็นโนอาห์ มองปราดเดียวก็ดูออกเลยว่าเป็นสการ์เล็ตโกลด์
<<TP_P1>> ท่านช่างตีเหล็กศักดิ์สิทธิ์ จะยอมรับคำขอข้าไหม
<<TP_P2>> นับว่าเป็นเกียรติอย่างสูง ฝ่าบาท
<<TP_P3>> ฝ่าบาทประสงค์สิ่งใดบอกข้ามาได้เลย...
STYLE SAMPLES (English source):
  IDEALISTIC... -> ทฤษฎีโลกสวยอย่างกับหลุดมาจากทุ่งลาเวนเดอร์
  YEESH, LIKE FATHER LIKE SON. -> เห้อ...ลูกไม้หล่นไม่ไกลต้นจริงๆ
  PUT ON YOUR DAMN PANTS! -> จากนี้ช่วยเลิกใส่แต่กางเกงในสักทีเถอะ!!
  THE FATALITY RATE'S ONE HUNDRED PERCENT. -> ยังไงก็ตาย100%"""
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


def looks_like_term(src: str, tgt: str, min_len: int = 3) -> bool:
    """Heuristic: is ``src => tgt`` a reusable TERM (name/place/skill/item)?

    Guards the glossary and the brief's TERMS block against full sentences and
    interjections, which poison later pages when pinned.  ``min_len`` is 2 for
    brief-authored terms (CJK names are often exactly 2 chars) and 3 for
    memo-harvested pairs.
    """
    s, t = (src or "").strip(), (tgt or "").strip()
    if not s or not t or len(s) < min_len:
        return False
    if len(s) > 40 or len(t) > 60:
        return False
    if "\n" in s or "\n" in t:
        return False
    # Sentence punctuation (interior) = a sentence, not a term.
    if any(ch in s for ch in "。.!?！？…,、"):
        return False
    if len(s.split()) > 5:
        return False
    return True


def build_series_block(series_state: str) -> str:
    """Render the frozen series bible (STORY SO FAR) block, or ``""``."""
    state = (series_state or "").strip()
    if not state:
        return ""
    return (
        "STORY SO FAR (series bible from reading the whole chapter — background truth for tone, "
        "relationships and scene; NEVER restate or translate it in the output):\n" + state
    )


def build_speaker_block(speakers: dict | None) -> str:
    """Render this page's marker->speaker map (from the chapter brief).

    ``speakers`` maps paragraph indices to character names, e.g.
    ``{"0": "Rey", "2": "Marnie"}``.  Unknown markers are simply absent.
    Returns ``""`` when there is nothing usable.
    """
    if not isinstance(speakers, dict) or not speakers:
        return ""
    lines: list[str] = []
    for idx in sorted(speakers, key=lambda k: int(k) if str(k).isdigit() else 0):
        name = str(speakers[idx] or "").strip()
        if name:
            lines.append(f"  <<TP_P{idx}>> = {name}")
        if len(lines) >= 50:
            break
    if not lines:
        return ""
    return (
        "SPEAKER MAP (decided from the WHOLE chapter — trust it over per-line guessing; give each "
        "line the voice its speaker has in the character sheet):\n" + "\n".join(lines)
    )


def build_prev_context_block(prev_context: list | None, limit: int = 6) -> str:
    """Render the previous page's SOURCE tail for cross-page flow (R4).

    ``prev_context`` is ``[{"src": ..., "who": ...?}, ...]`` in reading order —
    source text only (from OCR), so parallel translation never waits on another
    page's result.  Returns ``""`` when there is nothing usable.
    """
    if not isinstance(prev_context, list) or not prev_context:
        return ""
    lines: list[str] = []
    for entry in prev_context[-limit:]:
        if not isinstance(entry, dict):
            continue
        src = str(entry.get("src") or "").strip().replace("\n", " ")
        if not src:
            continue
        who = str(entry.get("who") or "").strip()
        lines.append(f"  [{who}] {src}"[:200] if who else f"  {src}"[:200])
    if not lines:
        return ""
    return (
        "PREVIOUS PAGE (source text tail, context only — the conversation may continue from here; "
        "do NOT translate or output these lines):\n" + "\n".join(lines)
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
    series_state: str = "",
    speakers: dict | None = None,
    prev_context: list | None = None,
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
        series_state=series_state,
        speakers=speakers,
        prev_context=prev_context,
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
    series_state: str = "",
    speakers: dict | None = None,
    prev_context: list | None = None,
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
    # R9 — the user's edited prompt must actually take effect:
    # - an override that starts with "Target language" is a full style REPLACEMENT
    #   (that is how every built-in style begins, i.e. the user edited the default);
    # - anything else is APPENDED to the default style as SERIES NOTES, so short
    #   user additions never silently erase the built-in translation rules.
    override = (prompt_override or "").strip()
    if not override:
        style = lang_style(lang)
    elif override.lower().startswith("target language"):
        style = override
    else:
        style = (
            lang_style(lang)
            + "\n\nSERIES NOTES (from the user — follow these even when they conflict with a rule above):\n"
            + override
        )
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
    series_block = build_series_block(series_state)
    speaker_block = build_speaker_block(speakers)
    prev_block = build_prev_context_block(prev_context)
    dynamic_text = "\n\n".join(
        p
        for p in (
            image_block,
            series_block,
            character_block,
            glossary_block,
            speaker_block,
            prev_block,
            "\n".join(contract),
        )
        if p
    )
    return static_text, dynamic_text


def build_user_parts(original_text_full: str) -> list[str]:
    """Return the user-message blocks for a translation request.

    Only the source text is sent — no Lens MT reference — so input stays
    small and the model translates from the original.
    """
    return ["Source (translate this):\n" + str(original_text_full or "")]
