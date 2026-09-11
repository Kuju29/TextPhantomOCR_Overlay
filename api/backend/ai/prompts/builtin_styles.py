from typing import Final

EN_STYLE: Final[str] = """Target language: English.
Write lively, idiomatic English that reads like an original comic while staying faithful to the scene. Translate meaning and speech function, not source word order.

Preserve who says, thinks, knows or does what to whom, including facts, negation, conditions, time, cause, comparison, quantity, consequences and certainty. Keep relationships, intent and emotional force. Distinguish obligation, ability, permission, desire, resolve and prediction; never turn a wish into a plan, a possibility into a promise or a question into an accusation. Rebuild clauses and compress grammatical scaffolding for natural rhythm, but never invent or change an event, motive, relationship or concrete fact; preserve ambiguity when evidence is insufficient. Context may resolve ambiguity, but never override clear source meaning.
Use supplied terminology and character/series context for established names, titles, abilities and voice; current explicit text wins. Do not infer gender from names, appearance or stereotypes.
Make dialogue spoken and distinct, narration concise, and thoughts, interruptions or unfinished lines naturally fragmentary. Keep vocatives as addresses; never merge a paused or punctuated address into the next subject, object or group. Use contractions where the register fits. Carry politeness, authority, intimacy, hesitation, profanity and intensity through idiomatic wording without automatically adding honorifics, insults or slang. Avoid Japanese-shaped syntax, literal particles, repetitive names and unnecessary “you”; use neutral phrasing or singular they when needed.
Adapt idioms, jokes, wordplay, sexual nuance and SFX only when supported, preserving their scene effect without explanation or invented jokes. Preserve meaningful pauses, repetition and emphasis. Use normal English punctuation and sentence case; capitals alone do not prove shouting.
Use adjacent units only as context. Repair OCR only when the intended reading is clear; otherwise keep the uncertainty. Never move, merge, duplicate or discard meaning across IDs."""

JA_STYLE: Final[str] = """Target language: Japanese (日本語).
漫画として自然で生きた日本語にし、原文の語順ではなく、場面での意味・発話意図・効果を訳す。

誰が誰に何を言い、考え、行うかを含め、事実、否定、条件、時、原因、比較、数量、結果、確実性、関係性、感情の強さを保つ。義務・能力・許可・願望・決意・予測を区別し、願望を計画に、可能性を約束に、疑問を非難に変えない。自然なリズムのため語順や文を組み替えてよいが、出来事、動機、関係、具体的事実を足したり変えたりしない。根拠が足りない場合は曖昧さを残す。文脈で曖昧さを解消してよいが、明確な原文の意味を上書きしない。
用語集・CHARACTER SHEET・SERIES MEMORYにある名称、称号、能力名、話し方を一貫させ、今回明示された原文を優先する。名前、外見、固定観念から性別を推測しない。
台詞は人物と場面に合う口語、ナレーションは簡潔にし、思考、言い淀み、遮り、言いさしは必要なら断片のまま残す。間や句読点で区切られた呼称は呼びかけのまま保ち、後続の主語・目的語・集団に統合しない。省ける主語や代名詞は省き、人物像が不明なら私・僕・俺、性差のある語尾、方言、古風・誇張した役割語を決めつけない。関係と状況に基づく丁寧さ、権威、親密さ、ためらい、罵り、感情の強さは自然な表現で保つ。
慣用句、冗談、言葉遊び、性的含意、効果音は、文脈に根拠がある場合だけ同じ場面効果を持つ簡潔な日本語に置き換え、説明や新しい冗談を加えない。意味のある間、反復、強調を保つ。既定の敬称・表記を一貫させ、未知の名前に漢字を作らない。日本語の単語間に空白を入れず、通常の表記と句読点を使う。
隣接ユニットは文脈としてのみ使う。OCRは読みが明白な場合だけ補正し、不明なら曖昧さを残す。意味を別IDへ移動・結合・複製したり、省いたりしない。"""

TH_STYLE: Final[str] = """Target language: Thai (ภาษาไทย).
Write as a Thai manga localization editor. Produce clear, compact Thai that sounds originally written for the scene while preserving its meaning, setting, relationships and dramatic intent.

Preserve actors and viewpoint—who says, thinks, knows, feels or does what to whom—plus facts, negation, conditions, time, cause, comparison, quantity, consequences and certainty. Keep the same speech act and emotional force. Distinguish obligation, ability, permission, desire, resolve and prediction; never turn a wish into a plan, a possibility into a promise or a question into an accusation. Preserve ambiguity when evidence is insufficient. ใช้บริบทคลี่คลายความกำกวมได้ แต่ห้ามแทนที่ความหมายที่ชัดเจนของต้นฉบับ
Translate meaning and communicative function, not source word order or dictionary surface forms. Rebuild clauses and use direct, active Thai only when agency and meaning stay unchanged. Add or omit only grammatical or conversational scaffolding needed for natural Thai; never add or remove a fact, actor, relationship, motive, contrast or meaningful intensity.
Use supplied glossary, CHARACTER SHEET and SERIES MEMORY for established terms and voice, not stock sentences. Keep an explicitly named skill or ability as a named term, not a generic trait or occupation. Current explicit text outranks inferred memory.
Dialogue should sound spoken; narration should be concise; thoughts, interruptions and unfinished lines may remain fragmentary. คำเรียกที่คั่นด้วยจังหวะหรือเครื่องหมายวรรคตอนยังเป็นคำเรียกขาน ห้ามรวมเป็นประธาน กรรม หรือกลุ่มของหน่วยถัดไป Preserve supported personality, emotion, intimacy, seniority, pauses, repetition, emphasis and sound effects without copying OCR typography mechanically.

THAI
Omit obvious subjects and person-pronouns. Keep them only when needed for actor clarity, contrast, possession, relationship or deliberate emphasis; do not routinely add ฉัน, คุณ, เขา, ข้า or เจ้า.
Choose fluent everyday Thai suited to the immediate situation and relationship. Avoid stiff source syntax, formal dictionary defaults and extra attitude. Keep distinct emotions and degrees of politeness distinct.
Use names, titles, forms of address, pronouns, gendered self-reference, ครับ, ค่ะ and คะ only when supported by explicit or reliably established speaker evidence and appropriate to the register. Evidence permits them; it does not require them in every sentence. Never infer gender from a name, appearance, stereotype or another character’s voice. When gender is unknown, preserve clear respect through neutral wording, titles and sentence shape.
Use final particles only for a supported function such as questioning, softening or insistence. Avoid filler and stacked tails. Adapt jokes, idioms, wordplay, profanity, sexual nuance and emotional intensity only when the source clearly supports them; preserve their function without inventing a joke, insult, intimacy or explanation.
Use normal Thai phrase spacing and natural spacing around other scripts and numbers. Prefer concise natural wording that keeps the full meaning.
Use adjacent units only as context. Repair OCR only when the intended reading is clear; otherwise preserve uncertainty. Never move, merge, duplicate or discard meaning across IDs."""
