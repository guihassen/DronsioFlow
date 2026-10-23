// Text post-processing that does not need an LLM: dictionary fixes and snippets.

const WORD_EDGE_START = "(?<![\\p{L}\\p{N}])";
const WORD_EDGE_END = "(?![\\p{L}\\p{N}])";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[-'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// "palavra falada" -> regex tolerant to case, accents being kept, and punctuation between words
function phraseRegex(phrase) {
  // "email" also matches "e-mail": allow an optional hyphen between letters
  const words = phrase
    .replace(/-/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w].map(escapeRegex).join("-?"));
  if (!words.length) return null;
  return new RegExp(WORD_EDGE_START + words.join("[\\s,.;:!?-]+") + WORD_EDGE_END, "giu");
}

/** Dictionary entries: { term, heardAs } where heardAs is a comma-separated list of misrecognitions. */
function applyDictionary(text, entries) {
  let out = text;
  for (const { term, heardAs } of entries || []) {
    if (!term || !heardAs) continue;
    for (const variant of heardAs.split(",").map((v) => v.trim()).filter(Boolean)) {
      const re = phraseRegex(variant);
      if (re) out = out.replace(re, term);
    }
  }
  return out;
}

/** Whole utterance equal to a snippet trigger -> the snippet text. */
function exactSnippet(text, snippets) {
  const n = normalize(text);
  return (snippets || []).find((s) => s.trigger && normalize(s.trigger) === n)?.text ?? null;
}

/** Replaces snippet trigger phrases said in the middle of a dictation. */
function expandSnippets(text, snippets) {
  let out = text;
  for (const s of snippets || []) {
    const re = s.trigger && phraseRegex(s.trigger);
    if (re) out = out.replace(re, () => s.text);
  }
  return out;
}

function dictionaryTerms(entries) {
  return (entries || []).map((e) => e.term).filter(Boolean);
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// Hesitation sounds Whisper writes out ("hum", "ahn", "uhm", "é..."); never real words.
// Note: a single "um" is NOT a filler, it is the Portuguese article ("um app").
const FILLER = /(^|[\s,;])(h+u+m+|h+m+|u+h+m+|u+m{2,}|a+h+n+|h+ã+|é+h+|é(?=\.{2,}|…))(\.{2,}|…|,)?(?=[\s,.!?;]|$)/giu;

/** Removes hesitation sounds without an LLM and tidies the spacing they leave behind. */
function removeFillers(text) {
  let out = text.replace(FILLER, "$1");
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/(^|[.!?]\s+)[,;]\s*/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .trim();
  return out.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

// Very common words that (almost) only exist in one of the two languages.
const MARKERS = {
  pt: new Set("que não para uma com você está mas isso então eu os as do da no na dos das pra também muito ele ela são foi tem vai quando porque meu minha".split(" ")),
  en: new Set("the and you is are to of it that this but for with what so my i'm don't was have will can just when because about they there".split(" ")),
};

/** "pt", "en", or null when the text is too short or mixed to tell. */
function guessLanguage(text) {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) || [];
  const score = (lang) => words.filter((w) => MARKERS[lang].has(w)).length;
  const pt = score("pt");
  const en = score("en");
  if (pt + en < 3) return null;
  if (pt >= 2 * en) return "pt";
  if (en >= 2 * pt) return "en";
  return null;
}

module.exports = { normalize, applyDictionary, exactSnippet, expandSnippets, dictionaryTerms, countWords, removeFillers, guessLanguage };
