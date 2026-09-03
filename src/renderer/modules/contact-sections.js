/**
 * A–Z sectioning for a contact list, the way an address book is expected to
 * work: 李知遥 belongs under L, not under a "#" bucket or at the end.
 *
 * No pinyin table is bundled. Chromium's ICU ships the pinyin collation, so a
 * character's section is found by comparing it against the first character of
 * each letter's range with `zh-Hans-u-co-pinyin`. That keeps this correct for
 * characters no hand-written table would have covered, and it is why the
 * boundary list below is data rather than code.
 *
 * `I`, `U` and `V` are absent on purpose: no Mandarin syllable begins with
 * them, so a section for them could never be non-empty.
 */

const PINYIN_BOUNDARIES = Object.freeze([
  ["A", "阿"], ["B", "八"], ["C", "擦"], ["D", "搭"], ["E", "蛾"], ["F", "发"], // i18n-exempt: pinyin collation boundary characters, never displayed
  ["G", "噶"], ["H", "哈"], ["J", "击"], ["K", "喀"], ["L", "垃"], ["M", "妈"], // i18n-exempt: pinyin collation boundary characters, never displayed
  ["N", "拿"], ["O", "哦"], ["P", "啪"], ["Q", "期"], ["R", "然"], ["S", "撒"], // i18n-exempt: pinyin collation boundary characters, never displayed
  ["T", "塌"], ["W", "挖"], ["X", "昔"], ["Y", "压"], ["Z", "匝"], // i18n-exempt: pinyin collation boundary characters, never displayed
]);

/** Anything with no letter section — digits, symbols, emoji — sorts last. */
const OTHER = "#";

function pinyinCollator() {
  try {
    return new Intl.Collator("zh-Hans-u-co-pinyin", { sensitivity: "base", numeric: true });
  } catch {
    // A build without the pinyin collation still gets a usable list: Latin
    // names section correctly and CJK names land in "#" together, which is
    // worse than sectioned but never wrong or empty.
    try { return new Intl.Collator(undefined, { sensitivity: "base", numeric: true }); } catch { return null; }
  }
}

const collator = pinyinCollator();
const compare = collator ? (a, b) => collator.compare(a, b) : (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The section a display name belongs to: "A".."Z" or "#". */
export function sectionLetter(name) {
  const first = [...String(name ?? "").trim()][0] || "";
  if (!first) return OTHER;
  if (/[A-Za-z]/.test(first)) return first.toUpperCase();
  // Only Han characters get a pinyin section. Kana, Cyrillic, digits and
  // symbols have no meaningful letter and must not be forced into one.
  if (!/[㐀-䶿一-鿿豈-﫿]/.test(first)) return OTHER;
  let letter = OTHER;
  for (const [candidate, boundary] of PINYIN_BOUNDARIES) {
    if (compare(first, boundary) >= 0) letter = candidate;
  }
  return letter;
}

/**
 * Group people into ordered sections.
 *
 * Sorting is by (letter, then name) rather than by the collator alone: a raw
 * pinyin sort puts every Latin name after every Han name, which would leave
 * "Alice" at the bottom instead of in the A section next to 阿.
 *
 * @param people array of items
 * @param nameOf reads the display name from an item
 * @returns [{ letter, people }] with "#" last and empty sections omitted
 */
export function groupByLetter(people, nameOf = (person) => person?.displayName) {
  const rows = Array.isArray(people) ? people : [];
  const buckets = new Map();
  for (const person of rows) {
    const letter = sectionLetter(nameOf(person));
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push(person);
  }
  const letters = [...buckets.keys()].sort((a, b) => {
    if (a === OTHER) return 1;
    if (b === OTHER) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return letters.map((letter) => ({
    letter,
    people: buckets.get(letter).sort((a, b) => compare(String(nameOf(a) ?? ""), String(nameOf(b) ?? ""))),
  }));
}

export { OTHER as OTHER_SECTION, PINYIN_BOUNDARIES };
