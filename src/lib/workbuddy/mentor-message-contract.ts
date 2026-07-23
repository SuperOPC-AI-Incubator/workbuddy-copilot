// Keep this value in sync with timeline_items_mentor_text_length_check.
export const MENTOR_MESSAGE_MAX_CHARACTERS = 8_000;
// Let the first invalid all-surrogate value reach JS instead of truncating it.
// HTML maxlength counts UTF-16 code units; one code point can occupy two.
export const MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS = (MENTOR_MESSAGE_MAX_CHARACTERS + 1) * 2;

export function countUnicodeCharacters(value: string): number {
  return Array.from(value).length;
}

export function isMentorMessageWithinLimit(value: string): boolean {
  const characterCount = countUnicodeCharacters(value);
  return characterCount >= 1 && characterCount <= MENTOR_MESSAGE_MAX_CHARACTERS;
}
