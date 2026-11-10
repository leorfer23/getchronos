/**
 * Which language one spoken sentence is in, and which words inside it belong to the other one — so
 * Robert's voice reads Spanish with Spanish phonemes and English with English ones, sentence by
 * sentence, whatever language the page's toggle says. Local, no model, microseconds: the call speaks
 * each sentence as soon as it streams, so this runs once per sentence on the hot path.
 *
 * How it decides (pickLang):
 *   - function words are the signal: "que", "el", "está", "decile" vs "the", "is", "what", "I'm" —
 *     the short words every sentence has and no topic changes. Words both languages share ("a", "no",
 *     "me", "he", "has", "come", "son") count for neither;
 *   - Spanish spelling counts too: ñ, an accented vowel, ¿ or ¡;
 *   - English contractions ("it's", "don't") count for English;
 *   - a clear margin wins; a tie or a sentence with no signal at all ("OK.", "PR 42.") keeps the hint —
 *     the language of the sentence before it, or the page's toggle — so a stray "OK" never flips voice.
 *
 * Code-switching (islands): a sentence picked Spanish can still carry English words the operator
 * uses as they are ("mergeá la feature branch y hacé el deploy"). Read with Spanish phonemes they come
 * out as "featu-re bran-ch"; `islands()` marks runs of words that are English and not Spanish, so the
 * neural voice can read just those with English phonemes while keeping the sentence's own voice.
 * Acronyms ("PR", "CI") stay with the sentence: "pe erre" is how a Spanish speaker says it.
 */

export type Lang = "en" | "es";

// Words that only tell one language apart. Kept small and common on purpose — the margin rule does
// the rest. Accents are stripped before lookup (norm), so "está" and "esta" are one entry.
const ES = new Set(
  (
    "el la los las lo un una unos unas del al de en y que se por con para es son esta estan estoy estas este estos esa ese eso esto " +
    "pero porque como cuando donde quien quienes cual cuales muy mas menos tambien ya ahora despues antes hoy ayer manana aca ahi alla " +
    "hay fue ser estar tiene tengo tenes hacer hace hizo hice voy vas va vamos van puede podes puedo quiero queres decile decime dale " +
    "che listo bueno nada algo todo todos toda todas otro otra otros mi mis tu tus su sus nos les le yo vos usted ustedes ellos ellas " +
    "nosotros sin sobre entre hasta desde contra tanto poco mucho mucha muchos si ni o u e pasa paso quedo queda falta necesito gracias " +
    "hola chau perdon esperá espera mira mirá fijate contame avisame cuanto cuantos cuantas cual tambien aun todavia nunca siempre " +
    "terminal terminales tablero pantalla capturas prueba pruebas cambios error errores arreglar arregla arregla mandar mandalo"
  ).split(/\s+/),
);
const EN = new Set(
  (
    "the of and to in is it you that was for on are with as i his they be at one have this from or had by not but what all were we " +
    "when your can said there an each which she do how their if will up other about out many then them these so some her would make " +
    "like him into time has look two more go see way could people my than first been who its now find down did get got made may part " +
    "im its dont doesnt didnt isnt wasnt cant wont youre were theyre thats whats lets ive ill youll should shall just only also very " +
    "here where why yes yeah okay please thanks hey hi hello right sure done ready waiting merged going after before today tomorrow " +
    "morning tonight still already something nothing anything everything does doing being am our us"
  ).split(/\s+/),
);
// Shared spellings vote for neither: "a", "no", "me", "he", "has", "come", "son" are words in both.
const BOTH = new Set(["a", "no", "me", "he", "has", "come", "son", "e", "o", "u", "ok", "okay", "real", "once", "solo", "red", "pan", "dice", "sure"]);

// English words the operator drops into Spanish as they are — the islands. Not function words: these
// are the ones whose Spanish reading is wrong. Any EN function word counts as well.
const EN_LOAN = new Set(
  (
    "feature features branch branches deploy deploys deployed deployment merge merged staging production prod pull request requests " +
    "push pushed commit commits review reviews reviewed build builds test tests testing dashboard dashboards bug bugs fix fixed fixes " +
    "issue issues worktree worktrees checkout check checks login logout update updates release releases ready rollback hotfix backlog " +
    "sprint standup meeting deadline ticket tickets draft drafts email emails slack thread threads job jobs query queries endpoint " +
    "frontend backend database schema migration migrations screenshot screenshots link links page pages app apps team feedback " +
    "workspace workspaces approve approved pipeline cache cluster server servers token tokens main master tag tags"
  ).split(/\s+/),
);

/** Lower case, accents off, letters and digits only — the lookup key. */
export function norm(w: string): string {
  return String(w || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

const words = (text: string) => String(text || "").split(/[\s,.;:!?¿¡"“”()…\-—]+/).filter(Boolean);

export type LangScore = { es: number; en: number };

export function scoreLang(text: string): LangScore {
  const s = { es: 0, en: 0 };
  const raw = String(text || "");
  if (/[ñÑ]/.test(raw)) s.es += 2;
  if (/[¿¡]/.test(raw)) s.es += 2;
  // An accented vowel in a word (not a lone symbol): Spanish spelling.
  const acc = raw.match(/[a-zñ]*[áéíóúÁÉÍÓÚ][a-zñ]*/g);
  if (acc) s.es += Math.min(3, acc.length);
  for (const w of words(raw)) {
    if (/^[A-Z0-9]{2,6}s?$/.test(w)) continue; // an acronym or a number says nothing
    if (/['’](s|m|t|re|ve|ll|d)$/i.test(w)) { s.en += 2; continue; }
    const k = norm(w);
    if (!k || BOTH.has(k)) continue;
    if (ES.has(k)) s.es += 1;
    else if (EN.has(k)) s.en += 1;
  }
  return s;
}

/**
 * The language to speak this sentence in. `hint` is what to keep when the sentence does not say —
 * the previous sentence's language, else the page's.
 */
export function pickLang(text: string, hint: Lang = "es"): Lang {
  const s = scoreLang(text);
  if (s.es === s.en) return hint;
  // One stray word against nothing ("Dale." / "Thanks.") is enough; otherwise ask for a margin, so a
  // Spanish sentence with two English words in it stays Spanish.
  const total = s.es + s.en;
  if (total <= 1) return s.es > s.en ? "es" : "en";
  if (s.es >= s.en * 1.5) return "es";
  if (s.en >= s.es * 1.5) return "en";
  return hint;
}

export type Segment = { text: string; lang: Lang };

/**
 * A sentence cut into runs to be read with each run's phonemes: one segment for a sentence in one
 * language; inside a Spanish sentence, every run of English words (loanwords and English function
 * words, not Spanish ones) becomes its own "en" segment. Punctuation stays with the run before it.
 * English sentences are not split: Spanish islands in English are rare and short.
 */
export function islands(text: string, lang: Lang): Segment[] {
  const t = String(text || "").trim();
  if (!t) return [];
  if (lang !== "es") return [{ text: t, lang }];
  const toks = t.split(/(\s+)/); // keep the spaces so the text comes back exactly
  const isEn = (tok: string) => {
    if (/^[A-Z0-9]{2,6}s?[.,;:!?]*$/.test(tok)) return false; // acronyms stay Spanish ("pe erre")
    const k = norm(tok);
    if (!k || ES.has(k) || BOTH.has(k)) return false;
    return EN_LOAN.has(k) || EN.has(k) || /['’](s|m|t|re|ve|ll|d)$/i.test(tok.replace(/[.,;:!?]+$/, ""));
  };
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const tok of toks) {
    if (/^\s+$/.test(tok)) { if (cur) cur.text += tok; continue; }
    // A word both languages spell the same ("a", "no") joins the run it sits in rather than cutting it.
    const k = norm(tok);
    const l: Lang = cur && BOTH.has(k) ? cur.lang : isEn(tok) ? "en" : "es";
    if (cur && cur.lang === l) cur.text += tok;
    else { if (cur) out.push(cur); cur = { text: tok, lang: l }; }
  }
  if (cur) out.push(cur);
  const segs = out.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
  // Nothing English in it: one segment, as before.
  return segs.some((s) => s.lang === "en") ? segs : [{ text: t, lang }];
}
