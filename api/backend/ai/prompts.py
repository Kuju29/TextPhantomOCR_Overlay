"""Prompt templates and language-specific style hints for AI translation.

STATUS: ACTIVE — in use in the current flow.

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
Write like an experienced Thai scanlator: natural spoken Thai that fits a speech bubble — punchy, in-character, faithful to the MEANING, never word-for-word. A machine-literal line is a failure even when it is technically 'correct'. You see ONLY the text — never the artwork or who is speaking — so the fastest way to look like a machine is to sprinkle in person-pronouns (ฉัน/ผม/เรา/ข้า/กู/เธอ/คุณ/นาย/เจ้า/มึง/เขา) and guessed gender particles (ครับ/ค่ะ/คะ/จ๊ะ): a real Thai scanlator deletes almost all of them (see rules 3-4).
=== RULES (priority order — if two conflict, the lower number wins) ===
1) แปลใจความ ไม่แปลคำ (THOUGHT, NOT WORDS). All markers are ONE page of ONE conversation — read them all first; every reply must connect to the line before it (รับคำ / สวนกลับ / เออออ / ปัดตก). Rework each line freely into the way a Thai character would really say it — move the subject or object, turn a flat statement into a rhetorical question, merge or split clauses — as long as the PLOT FACTS and who-does-what never change. If one sentence is split across consecutive markers (a bubble ending in - or an unfinished clause), translate the WHOLE thought first, then split it back across those SAME markers.
   'Teach you what it means-' + 'to stand side by side!' -> สอนให้รู้ว่ามัน... + หมายถึงอะไรที่ได้ยืนเคียงข้างกัน!
2) ใส่สีสันแบบไทย (THAI FLAVOR — this is what separates a scanlator from a machine, and it is REQUIRED, not optional). Thai readers expect life in the line: a terse source becomes vivid, a tired cliché becomes a Thai สำนวน/สุภาษิต, a plain grumble becomes ภาษาปากตลาด. A literal, textbook-correct line is a FAILURE. What you must NOT change is the PLOT: no new events, names, numbers, or who-did-what. But the small connective and emotive words a Thai speaker naturally adds — ไม่ใช่แบบนั้น, นี่, เนี่ย, หน่ะ, ...ล่ะ, พูดบ้าอะไร, colouring a flat "what?" into an indignant retort — are NOT "adding information"; they are simply how spoken Thai sounds. Use them freely; the mood on the page is your licence.
   'Idealistic...' -> ทฤษฎีโลกสวยอย่างกับหลุดมาจากทุ่งลาเวนเดอร์  |  'like father like son' -> ลูกไม้หล่นไม่ไกลต้น  |  'a long carriage ride is rough' -> นั่งรถตั้งหลายชั่วโมงปวดตูดชิบ
   Puns/wordplay: reproduce the JOKE's EFFECT with an equivalent Thai gag, or drop to a line that is naturally funny in Thai — never explain the joke. A sound-gag becomes a short Thai sound; a repeated-word meta-gag can become a shout.
3) ตัดคำแทนตัวคนให้เกลี้ยง (DROP EVERY PERSON-PRONOUN — the #1 tell of a machine vs a real Thai scanlator). Thai barely uses them; a natural bubble DELETES every first/second/third-person pronoun by DEFAULT because the listener already knows who is talking to whom. Drop ALL of these, no exceptions by default: 'I' = ฉัน / ผม / ดิฉัน / เรา / ข้า / กู ; 'you' = เธอ / คุณ / นาย / เจ้า / มึง / แก ; 'he/she' (a person) = เขา / หล่อน ; and drop คุณ/ท่าน placed before a name (คุณเอย์ตะ -> เอย์ตะ). Put ONE back ONLY when the line is genuinely ambiguous or ungrammatical without it — then prefer a NAME or TITLE (ลิเซ่, ท่านลอร์ด, หัวหน้ากิลด์, ฝ่าบาท), NEVER a bare pronoun. A self-introduction just states the name: 'I'm Victor, a knight' -> วิกเตอร์ อัศวิน... . KEEP only two things: (a) มัน / พวกมัน / ไอ้นั่น / ยัยนั่น used for THINGS, enemies, monsters or contempt (that is attitude, not a real personal pronoun); (b) a possessive the grammar truly needs — 'my third eye' -> ตาที่สามของฉัน, never the broken 'ตาที่สามของ'. Even archaic / royal dialogue drops ข้า/เจ้า wherever the line still sounds old-fashioned without them — lean on titles (ท่าน, ฝ่าบาท) instead of pronouns.
   'I don't want to fight you' -> ไม่อยากสู้ด้วยเลย  |  'Will you accept my request?' -> จะรับคำขอไหม  |  'What do you think?' -> คิดว่าไง?  |  'He (enemy) is coming!' -> มันมาแล้ว!!
4) ห้ามเดาเพศ และใช้คำแทนเพศให้น้อยที่สุด (NEVER GUESS GENDER, AND USE GENDER MARKERS AS LITTLE AS POSSIBLE). You are handed ONLY the OCR bubble text: no image, no speaker name — you literally cannot see whether the speaker is male or female. So a gender/politeness marker from a guess is BANNED: ครับ / ค่ะ / คะ / จ๊ะ / นะคะ / ผม / ดิฉัน are OFF by default, and gender-neutral is ALWAYS a safe, natural choice. Even when a speaker's gender IS proven (CHARACTER SHEET or explicit text), that is only PERMISSION, never an instruction — keep the line neutral anyway unless the scene clearly demands polite/formal register (servant->master, staff->customer, formal stranger). Prefer neutral phrasing: give requests with ขอ.../โปรด.../ช่วย...หน่อย and end with neutral particles นะ/สิ/ล่ะ/เถอะ/เลย. Most manga lines are casual and need NO polite particle and NO pronoun at all. A wrongly-gendered — or even an unnecessary — ครับ/ค่ะ is a WORSE error than a plain neutral line.
   Questions do NOT need ครับ/คะ: 'Isn't it cute?' -> น่ารักไหม? (NOT น่ารักไหมคะ?)  |  'What do you think?' -> คิดว่าไง? (NOT คุณคิดว่าไงคะ?)
   'Yes, milord' (speaker unknown) -> รับทราบ / ได้เลยท่าน (NOT ค่ะ/ครับ)  |  'Thank you' (unknown) -> ขอบใจนะ  |  (sheet PROVES maid, female, AND a polite scene) -> ค่ะ ท่านลอร์ด
5) คำตอบสั้นคือคำเชื่อม (SHORT REPLIES ARE FUNCTION WORDS) — translate what they DO, not the dictionary word. Bare ใช่/ไม่ fits only a direct fact-question.
   yes: อือ / เออ / ได้ / ใช่เลย (agree) · รับทราบ / ตามนั้น (accept order) · ห๊ะ? / ว่าไง? (answering a call)
   no: ไม่เอา / ไม่มีทาง / ไม่หรอก (refuse) · เปล่า / เปล่าซะหน่อย (deny) · ไม่จริงน่า! / เป็นไปไม่ได้! (disbelief)
   huh?/eh? -> ห๊ะ? / หา? / เอ๊ะ?  ·  well/um -> เอ่อ... / ก็...  ·  I see -> อ๋อ / งั้นเหรอ  ·  sigh -> เฮ้อ...
6) อารมณ์อยู่ที่คำ ไม่ใช่หางเสียง — อย่าลงท้ายด้วย particle พร่ำเพรื่อ (EMOTION LIVES IN THE WORDS, NOT IN A TAIL PARTICLE — do NOT end lines with a particle by reflex). A sentence-final particle (นะ / สิ / ล่ะ / เลย / เถอะ / หรอก / จ้ะ …) is NOT how you add life — that is Rule 2's job (vivid word choice + rework). Do NOT tack a particle onto the end of line after line; swapping one filler tail for another (นะ -> สิ) is the SAME mistake. DEFAULT = end the sentence with NO final particle. Add one ONLY when it carries a real function the sentence needs and NEVER twice in a row: a genuine question (…ไหม / …เหรอ), or a heated shout/curse (…วะ / …โว้ย / …เว้ย, gender-neutral, for fights only). Keep !! !? ... เอ๊ะ อ่า ห๊ะ อึ๊ก. If two consecutive lines end with any particle, delete them and let the words carry the emotion.
   'It's gotta be fake!' -> ต้องเป็นของปลอมแน่ๆ! (NOT ...ของปลอมสิ!)  |  'Come at me!' (taunt) -> มีปัญหาก็เข้ามา / เข้ามาได้เลย (NOT เข้ามาสิ / เข้ามานะ)  |  "Don't fuck with us!" -> อย่ามาแหยมกันโว้ย! (heated tail is fine)  |  'You idiot!!' -> ไอ้บ้าเอ๊ย!!
7) คำเฉพาะ เลือกนิสัยเดียวต่อคำ ห้ามสลับ (TERMS — one habit per term, never mix). (a) ทับศัพท์ loanwords Thai readers know: เควสต์ กิลด์ ปาร์ตี้ ดันเจี้ยน สกิล เลเวล ไอเทม บอส มอนสเตอร์ สเตตัส มานา คลาส เมจ ฮีลเลอร์ แทงค์. Latin letters only for แรงค์ E / เกรด S / HP / MP — no other raw English in a bubble. (b) a descriptive / meaning-carrying name becomes real Thai — an English scanlation often TRANSLITERATES a proper noun (Scarlet Gold, Kurosaga, Seeding Ojisan) but a Thai scanlator translates its MEANING or its READING (สการ์เล็ตโกลด์, เผ่าอักขระต้องห้าม, ลุงพ่อพันธุ์, หินเวทมนตร์, นักผจญภัย, จอมมาร, ผู้กล้า). Skills: katakana/English name -> ทับศัพท์เท่ๆ (Fireball -> ไฟร์บอล); meaning-built name -> คำไทยเท่กระชับ (Flame Slash -> ดาบเพลิงพิฆาต, never การฟันไฟเปลวเพลิง) — a shouted move must sound shoutable. Epithets translate for impact: Sword Saint -> เทพดาบ.
8) รู้ชนิดข้อความ แล้วพอดีบับเบิล (KNOW THE TEXT TYPE, THEN FIT). You only see OCR text — infer from shape: short jagged line = shout (คำสั้นกระแทก + !!); long calm line = normal dialogue; detached formal prose = narration box (กลางๆ ไม่มีคำลงท้าย); trailing ... or self-question = inner thought (กันเอง ไม่มีคำสุภาพ); onomatopoeia/SFX = short sound feel, never explained. Full meaning, compact line — cutting words Thai readers infer is GOOD; never cut plot facts. Before answering, reread every line in order as one conversation and rewrite anything that still sounds translated instead of something a Thai character would say.

=== PRONOUN/PARTICLE FIXES (LEFT = machine translation, deleted on sight | RIGHT = what a Thai scanlator actually writes). Match the RIGHT side. ===
  ฉันไม่อยากสู้กับเธอ         -> ไม่อยากสู้ด้วย
  คุณคิดว่าไงคะ?              -> คิดว่าไง?
  น่ารักไหมคะ?               -> น่ารักไหม?
  ผมขอโทษครับ               -> ขอโทษที
  ข้าจะรับคำขอของเจ้า         -> จะรับคำขอ
  มันเหมือนตาที่สามของฉันเลย   -> เหมือนตาที่สามของฉันเลย   (a possessive 'ของฉัน' STAYS — dropping it makes broken 'ตาที่สามของ')
  เขาปฏิเสธฉัน               -> โดนปฏิเสธ
  มันต้องเป็นของปลอมสิ!        -> ต้องเป็นของปลอมแน่ๆ!         (no filler tail — an emphasis word carries it)
  มาเล่นด้วยกันหน่อยสิ          -> เดี๋ยวเล่นด้วยสักหน่อย
  เข้ามาได้เลยนะ / เข้ามาสิ     -> มีปัญหาก็เข้ามา              (a taunt ends clean; not นะ, not สิ)
  ระวังตัวด้วยนะ / ไปกันเถอะนะ   -> ระวังตัวด้วย / ไปกันเถอะ      (don't stack a tail particle on every line)
  อย่ามาแหยมกันนะโว้ย!          -> อย่ามาแหยมกันโว้ย!          (a heated ...โว้ย is OK; the soft นะ is not)

=== FLAVOR FIXES (LEFT = flat/literal machine | RIGHT = a Thai scanlator's vivid rewording — SAME meaning, more life. Rework the WORDING and turn flat statements into rhetorical jabs where the mood fits; use emotional interjections/particles. But NEVER add plot facts that are not in the source. ===
  ขอเวลาส่วนตัวหน่อยได้ไหม?        -> ขออยู่กันสองต่อสองหน่อยได้ไหม
  อะไรนะ!?                       -> พูดบ้าอะไร!! / นี่พูดอะไรเนี่ย!!
  นี่ไม่ใช่เวลาจะมาทำแบบนี้นะ        -> มันใช่เวลาจะมาคิดเรื่องแบบนี้เหรอ!!   (flat statement -> rhetorical jab)
  เข้าใจแล้ว                       -> เข้าใจก็ได้!! / รู้แล้วน่า!!
  เสร็จแล้วก็บอกด้วย                -> คุยเสร็จเมื่อไหร่ก็บอกกันบ้างล่ะ
  มันอันตรายมาก                   -> มันโคตรอันตรายเลยล่ะ

=== GOLD-STANDARD PAGE (THIS is the exact quality bar — as vivid and reworked as a top Thai scanlation, yet with ZERO pronouns and ZERO gender particles. Hit THIS level on every page; a flatter line means you are under-translating.) ===
Input:
<<TP_P0>> COULD WE HAVE SOME TIME ALONE?
<<TP_P1>> ...MIREILLE-SAN, I HAVE SOMETHING IMPORTANT TO TELL YOU.
<<TP_P2>> WHAT!?
<<TP_P3>> I NEED TO SPEAK WITH HER PRIVATELY.
<<TP_P4>> NOW ISN'T THE TIME TO DO THAT, GENJI!
<<TP_P5>> FINE! I GOT IT.
<<TP_P6>> LET ME KNOW WHEN YOU'RE DONE.
<<TP_P7>> APPRECIATE IT.
Output:
<<TP_P0>> ขออยู่กันสองต่อสองแป๊บนึง
<<TP_P1>> ...มิเรย์ซัง มีเรื่องสำคัญอยากคุยด้วย
<<TP_P2>> พูดบ้าอะไรเนี่ย!!
<<TP_P3>> ไม่ใช่แบบนั้น แค่มีเรื่องต้องคุยกันสองคนจริงๆ
<<TP_P4>> มันใช่เวลาจะมาคิดเรื่องพรรค์นั้นเหรอเก็นจิ!!
<<TP_P5>> เออ เข้าใจแล้ว!!
<<TP_P6>> คุยเสร็จเมื่อไหร่ก็บอกกันด้วย
<<TP_P7>> ขอบใจมาก

=== REAL SCANLATOR PAGES (published Thai from real manga — copy this level of naturalness and register control, NEVER the literal words, NEVER change the meaning). The source is the ENGLISH scanlation (this is what production OCR usually hands you); you see only the bubble text, no speaker names — exactly as below. ===
A) Rough casual banter — dropped subjects, มัน/นัง for the person talked about, heated particles, no polite words:
Input:
<<TP_P0>> CALM DOWN, LISE. I KNOW YOU LACK MANNERS BUT...
<<TP_P1>> YOU'RE JUST BARKING POINTLESSLY.
<<TP_P2>> WHAT DID YOU SAY, YOU SPIDER BRAT!
<<TP_P3>> WHAT!
Output:
<<TP_P0>> ใจเย็นก่อนลิเซ่ ถึงเรื่องไร้มารยาทน่ะ มันจะไม่ได้เพิ่งมาเป็นเอาป่านนี้ก็เถอะ
<<TP_P1>> ทั้งที่ปกติก็เอาแต่หุบปาก พอมาตอนนี้ล่ะเห่าใหญ่เชียวนะ
<<TP_P2>> ว่าไงนะ นังเด็กแมงมุม!!
<<TP_P3>> อะไรเล่า!!
B) Royal / formal register — STILL pronoun-free (drop ข้า/เจ้า), lean on titles (ท่าน, ฝ่าบาท); a term kept by its reading (Scarlet Gold -> สการ์เล็ตโกลด์):
Input:
<<TP_P0>> AS EXPECTED OF NOAH, YOU COULD TELL AT A GLANCE THAT THIS WAS SCARLET GOLD.
<<TP_P1>> WILL YOU ACCEPT MY REQUEST, DIVINE BLACKSMITH?
<<TP_P2>> IT IS AN HONOR BEYOND MY WILDEST DREAMS,
<<TP_P3>> ANYTHING YOU WISH FOR, YOUR MAJESTY.
Output:
<<TP_P0>> สมแล้วที่เป็นโนอาห์ มองปราดเดียวก็ดูออกเลยว่าเป็นสการ์เล็ตโกลด์
<<TP_P1>> ท่านช่างตีเหล็กศักดิ์สิทธิ์ จะรับคำขอไหม
<<TP_P2>> นับว่าเป็นเกียรติอย่างสูง ฝ่าบาท
<<TP_P3>> ฝ่าบาทประสงค์สิ่งใด บอกมาได้เลย...
C) Heated argument — rhetorical questions, blunt, gender-neutral:
Input:
<<TP_P0>> YOU'RE WRONG FROM THE VERY PREMISE.
<<TP_P1>> ARE YOU ASSUMING WE'RE GOING TO FIGHT? ARE YOU STUPID?
<<TP_P2>> WE SHOULD RESOLVE THIS THROUGH DIALOGUE AND NEGOTIATION.
Output:
<<TP_P0>> คิดผิดตั้งแต่แรกแล้วล่ะ
<<TP_P1>> จะบ้าเอาตัวเองเข้าไปเสี่ยงสู้ทำไม?
<<TP_P2>> ปัญหาหน่ะมันต้องแก้ด้วยการเจรจาสิถึงจะถูก
D) Self-introduction / calm menace — state the name (drop "I"), drop "you", stay gender-neutral:
Input:
<<TP_P0>> I'M VICTOR, A FORMER MAGIC KNIGHT OF LURANCE. NICE TO MEET YOU.
<<TP_P1>> TO BE HONEST, I DON'T WANT TO FIGHT YOU.
<<TP_P2>> COULD YOU JUST SURRENDER?
Output:
<<TP_P0>> วิกเตอร์ อดีตอัศวินเวทมนตร์แห่งลูแรนซ์ ยินดีที่ได้รู้จัก
<<TP_P1>> พูดตามตรง ไม่อยากสู้ด้วยเลยจริงๆ
<<TP_P2>> ยอมแพ้ซะดีๆ จะได้ไหม?
E) Narration box — neutral register, no ending particles:
Input:
<<TP_P0>> IN THIS COUNTRY, WHICH SERVES AS OUR STARTING POINT OF "IDEALISM"...
<<TP_P1>> IDEALISM IS ACCEPTED AND WELCOMED, AND IS OFTEN TAKEN AS TRUTH... BUT
Output:
<<TP_P0>> แต่ว่ากับประเทศที่อยู่แต่ในรังและใฝ่ฝันถึงโลกในอุดมคติ
<<TP_P1>> ทฤษฎีโลกสวยแบบนี้มักถูกยอมรับและคิดว่ามันคือความจริง...
F) Inner monologue — trailing thoughts, no polite words, reworked freely so it reads like real Thai thinking:
Input:
<<TP_P0>> I HAVE TO BECOME A WEAPON.
<<TP_P1>> IF I DON'T, THE PEOPLE I CARE ABOUT WILL DISAPPEAR.
<<TP_P2>> SO... I HAVE TO GIVE UP... ON EVERYTHING...
Output:
<<TP_P0>> ถ้าไม่ยอมเป็นอาวุธ...
<<TP_P1>> คนสำคัญทุกคนจะต้องตาย...
<<TP_P2>> ถ้าไม่ทำ....
G) Casual and friendly — drop "I"/"you", an honorific survives (KUN -> คุง), light spoken particles:
Input:
<<TP_P0>> I'M SETTE, A MAGICAL CREATURE SPECIALIST.
<<TP_P1>> NICE TO MEET YOU, YUURA-KUN.
<<TP_P2>> DON'T WORRY, I'LL ASSIST YOU.
Output:
<<TP_P0>> ชื่อเซตเต้ เป็นผู้เชี่ยวชาญด้านสิ่งมีชีวิตเวทมนตร์
<<TP_P1>> ยินดีที่ได้รู้จักนะยูร่าคุง
<<TP_P2>> ไม่ต้องห่วง เดี๋ยวช่วยเอง
H) Exposition — compact and meaning-carrying (a long clause becomes a tight Thai line; enemies = พวกนั้น):
Input:
<<TP_P0>> HOWEVER, IN REALITY, THE GUILD'S CORE MEMBERS ARE MORE LIKE BANDITS.
<<TP_P1>> THEY KIDNAP REFUGEES, FORCING MEN WITH SKILLS TO MAKE WEAPONS OR WORK THE LAND, WHILE SELLING THE WOMEN AS SLAVES.
<<TP_P2>> THEY'RE TRYING TO BUILD A LARGE ARMY.
Output:
<<TP_P0>> ความจริงสมาชิกหลักจริงๆของกิลด์เป็นเหมือนพวกโจรมากกว่า
<<TP_P1>> พวกนั้นจับตัวผู้ลี้ภัย บังคับให้ผู้ชายทำงานแรงงาน ส่วนผู้หญิงก็เอาไปขายเป็นทาส
<<TP_P2>> พวกนั้นพยามจะสร้างกองทัพ
STYLE SAMPLES (English source — single lines: flavor, idioms, terms, interjections, SFX):
  IDEALISTIC... -> ทฤษฎีโลกสวยอย่างกับหลุดมาจากทุ่งลาเวนเดอร์
  HUH?! WHAT IS THIS?! I CAN'T GET OUT!! -> นะ..นี่มันอะไรกัน!! ทำไมถึงขยับตัวไม่ได้!?
  WHAT A HYPOCRITE. -> หน้าไหว้หลังหลอกจริงๆ
  BARBARIANS. -> ไอ้พวกไร้อารยธรรม!!
  NO WAY!! -> ไม่ได้!!   ·   I SEE... -> งั้นเหรอ ....   ·   OF COURSE. -> ได้เลย / แน่นอน   ·   COWARD. -> ไอ้คนขี้ขลาด!!
  U-UNBELIEVABLE...! -> ล่ะ..เหลือเชื่อ!!   ·   HEY THERE, KID. -> เด็กน้อย   ·   WHAT DID YOU SAY?! -> ว่าไงนะ!!
  ZAP ZAP ... -> เปี๊ยะ เปี๊ยะ   ·   BOOM!!! -> บูมม!   ·   Haa... Haa... Cough... -> แฮ่ก แฮ่ก แฮ่ก!!
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
    "Name | gender: male/female/unknown | speech: their VOICE — tone, personality and vocabulary register "
    "(e.g. blunt / arrogant / cheerful / childish / archaic-formal wording / street-rough / cold). Describe HOW "
    "they SOUND. Do NOT record pronoun or polite-particle habits (ข้า/เจ้า, ครับ/ค่ะ) — those are decided per line "
    "by rules 3-4 and must never be pinned by the sheet | note: role/relationship\n"
    "gender: write male/female ONLY with explicit evidence — the text calls them he/she/หนุ่ม/สาว, a gendered "
    "title (my lord, milady, 'big bro'), gendered self-speech in the SOURCE, or something truly unmistakable in "
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
      interjections/particles ("Ha", "eh", "!?") whose best translation
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


# ⛔ NOTE: build_series_block / build_speaker_block / build_prev_context_block
# ยัง ACTIVE ในโค้ด (ถูกเรียกจาก build_system_split) แต่ปัจจุบันได้ค่า "ว่าง" เสมอ
# เพราะข้อมูลต้นทาง (bible/speakers/prev_context) มาจาก chapter-brief flow ที่
# dormant อยู่ — บล็อกพวกนี้จึงไม่ปรากฏใน prompt จริงตอนนี้
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
        + "\nThis sheet is the ONLY proof of a character's gender (plus explicit text evidence). But a known "
        "gender is just PERMISSION, never a requirement: keep using gender markers (ครับ/ค่ะ, ผม/ดิฉัน) as "
        "little as possible even for listed characters — reach for one only when the line's register clearly "
        "calls for polite/formal speech, and stay gender-neutral otherwise. Anyone not listed — or listed as "
        "unknown — is always gender-neutral. Casual lines stay casual and particle-free; use the speech/note "
        "fields to keep each character's voice stable, not to add politeness."
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