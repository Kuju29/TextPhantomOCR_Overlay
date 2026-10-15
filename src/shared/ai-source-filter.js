// A source unit must contain language and more than one visible character.
// Normalize only for eligibility: keep the original OCR text and IDs intact.
// NFC treats a composed Latin accent as one character while preserving short
// Thai words whose vowels/tones are separate code points (ดี, มี, ที่).
const INVISIBLE = /[\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const LETTER = /\p{L}/u;
export function hasMeaningfulAiSource(value) {
  const text = String(value ?? '');
  const original = text.replace(INVISIBLE, '');
  // Every original singleton skips, even if NFC expands it into two points.
  if (Array.from(original).length < 2) return false;
  const visible = text.normalize('NFC').replace(INVISIBLE, '');
  return LETTER.test(visible) && Array.from(visible).length >= 2;
}

// Canonical gN IDs retain their paragraph ordinal when filtered units are
// omitted from a Conversation turn. Legacy arbitrary IDs use their old order.
export function sourceUnitOrdinal(unit, fallback) {
  const match = /^g([0-9]{1,6})$/.exec(String(unit?.id || ''));
  return match ? Number(match[1]) : fallback;
}
