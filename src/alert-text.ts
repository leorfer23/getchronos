/**
 * What a stuck-work alert says (src/stuck-alerts.ts) — built from the terminal's own words, never by a
 * model: the alert is on the hot path between "stuck" and "told", and a model call there would add
 * seconds to every one. Inputs are the work's goal, the term-status line and the open question.
 *
 * The voice rules (agents/_blocks/voice.md) hold: the project and the work in plain words, what
 * happened, what he must decide — at most two sentences, no ids, none of the internal words (no
 * "stall", "wake", "blocked", "ask"). Whatever an agent wrote (a goal, a question) is clipped and
 * flattened so it can never add a sentence of its own or carry a link or an id into his ear.
 */
export type AlertLang = "en" | "es";

export type TextInput =
  | { kind: "decide"; ws: string | null; work: string; question: string; options: string[]; permission?: { tool: string; input: string | null } | null }
  | { kind: "blocked"; ws: string | null; work: string; why: string | null; reason: string | null }
  | { kind: "stalled"; ws: string | null; work: string; minutes: number | null; job?: boolean }
  | { kind: "wall"; ws: string | null; work: string; wall: "credit" | "limit"; resets: string | null }
  | { kind: "host"; host: string; works: string[]; minutes: number | null; moved: boolean }
  | { kind: "job_failed"; ws: string | null; job: string; why: string | null; auth: boolean; timeout?: boolean; backend: string | null }
  | { kind: "summary"; items: string[] };

// An 8+ hex run (a session/run id or its prefix), a UUID, a URL, a PR/issue number with its repo.
const ID_RE = /\b[0-9a-f]{8}(?:-?[0-9a-f]{4}){0,3}(?:-?[0-9a-f]{12})?\b/gi;
const URL_RE = /https?:\/\/\S+/gi;

/** One line of agent-written text made safe to read aloud inside our sentence. */
export function flat(s: string | null | undefined, max = 120): string {
  let t = String(s ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(URL_RE, "")
    .replace(ID_RE, "")
    // What a removed link or id leaves behind: "(see )", "()".
    .replace(/\(\s*(?:see|ver|cf\.?)?\s*\)/gi, "")
    .replace(/[`*_#>|~]+/g, " ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // A sentence break inside it would make it two of ours: fold them into commas.
  t = t.replace(/([.!?…]+)\s+(?=\S)/g, ", ").replace(/[\s,;:.!?…]+$/, "");
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "") + "…";
  }
  // A parenthesis the cut (or a removed link) left open reads as a stray word.
  return t.replace(/\s*\((?:[^)]*)$/, (m) => (/[)]/.test(m) ? m : "")).trim();
}

/** The work, named the way he thinks of it: its goal in quotes, or a plain fallback. */
function work(w: string, lang: AlertLang): string {
  const g = flat(w, 70);
  if (!g) return lang === "es" ? "una terminal" : "a terminal";
  return lang === "es" ? `la tarea “${g}”` : `the task “${g}”`;
}
const where = (ws: string | null, lang: AlertLang) => {
  const w = flat(ws, 40);
  return w ? (lang === "es" ? `En ${w}, ` : `In ${w}, `) : "";
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** A question as the end of our sentence: its own words, one question mark. */
function question(q: string, lang: AlertLang): string {
  const t = flat(q, 140);
  if (!t) return lang === "es" ? "¿cómo sigue?" : "how should it go on?";
  return /[?]$/.test(t) ? t : t + "?";
}
const list = (xs: string[], lang: AlertLang, n = 4) => {
  const items = xs.map((x) => flat(x, 60)).filter(Boolean);
  const head = items.slice(0, n);
  const more = items.length - head.length;
  return head.join("; ") + (more > 0 ? (lang === "es" ? ` y ${more} más` : ` and ${more} more`) : "");
};
const minutes = (m: number | null | undefined, lang: AlertLang) =>
  m && m > 0 ? (lang === "es" ? ` hace ${Math.round(m)} minutos` : ` ${Math.round(m)} minutes ago`) : "";

/** "claude-code" → "Claude", "cursor-agent" → "Cursor": the tool as he names it. */
function toolName(backend: string | null | undefined): string {
  const b = flat(backend, 20).replace(/-(?:code|agent|cli)$/i, "");
  return b ? b[0].toUpperCase() + b.slice(1) : "";
}

/** At most two sentences: what happened, and what he has to decide. */
export function alertText(inp: TextInput, lang: AlertLang = "en"): string {
  const es = lang === "es";
  switch (inp.kind) {
    case "decide": {
      const opts = inp.options.map((o) => flat(o, 40)).filter(Boolean).slice(0, 4);
      // A tool it wants to run (claude's permission menu): name the tool and what it would do.
      const p = inp.permission;
      const q = p
        ? (() => {
            const tool = flat(p.tool, 30) || (es ? "una herramienta" : "a tool");
            const what = flat(p.input, 60);
            return es ? `¿puede usar ${tool}${what ? ` (${what})` : ""}?` : `may it use ${tool}${what ? ` (${what})` : ""}?`;
          })()
        : question(inp.question, lang);
      const head = `${where(inp.ws, lang)}${work(inp.work, lang)} ${es ? "se frenó con una pregunta para vos" : "stopped with a question for you"}: ${q}`;
      const tail = opts.length ? `${es ? "Opciones" : "Options"}: ${opts.join(", ")}.` : es ? "Espera tu respuesta para seguir." : "It waits for your answer to go on.";
      return `${cap(head)} ${tail}`;
    }
    case "blocked": {
      const w = `${where(inp.ws, lang)}${work(inp.work, lang)}`;
      if (inp.reason === "auth")
        return cap(es ? `${w} necesita que inicies sesión para seguir. Iniciá sesión y continúa sola.` : `${w} needs a login before it can go on. Log in and it continues on its own.`);
      if (inp.reason === "budget")
        return cap(es ? `${w} se quedó sin presupuesto. Subí el presupuesto o frenala.` : `${w} ran out of budget. Raise the budget or stop it.`);
      const why = flat(inp.why, 100);
      return cap(es
        ? `${w} está trabada${why ? `: ${why}` : ""}. Necesita que la destrabes para seguir.`
        : `${w} is stuck${why ? `: ${why}` : ""}. It needs you to get it moving again.`);
    }
    case "stalled": {
      if (inp.job) {
        const j = flat(inp.work, 60);
        return cap(es
          ? `${where(inp.ws, lang)}la tarea programada “${j}” no da señales de vida${minutes(inp.minutes, lang)}. Decidí si la freno o la dejo correr.`
          : `${where(inp.ws, lang)}the scheduled job “${j}” has shown no sign of life${inp.minutes ? ` for ${Math.round(inp.minutes)} minutes` : ""}. Decide whether to stop it or let it run.`);
      }
      return cap(es
        ? `${where(inp.ws, lang)}${work(inp.work, lang)} dejó de responder a mitad del trabajo${minutes(inp.minutes, lang)}. Decidí si la reinicio o la dejo.`
        : `${where(inp.ws, lang)}${work(inp.work, lang)} stopped responding in the middle of its work${minutes(inp.minutes, lang)}. Decide whether to restart it or leave it.`);
    }
    case "wall": {
      const w = `${where(inp.ws, lang)}${work(inp.work, lang)}`;
      const resets = flat(inp.resets, 30);
      const what = inp.wall === "credit" ? (es ? "se quedó sin créditos" : "ran out of credits") : es ? "llegó a su límite de uso" : "hit its usage limit";
      return cap(es
        ? `${w} ${what} y no pudo pasar a otra cuenta${resets ? ` (se renueva ${resets})` : ""}. Esperá la renovación, cargá crédito o decime qué cuenta usar.`
        : `${w} ${what} and could not move to another account${resets ? ` (it resets ${resets})` : ""}. Wait for the reset, top up, or tell me which account to use.`);
    }
    case "host": {
      const h = flat(inp.host, 40) || (es ? "una computadora" : "a computer");
      const n = inp.works.length;
      const items = list(inp.works, lang, 3);
      // No cap(): a computer's name is its own ("m2"), not the start of a word.
      if (inp.moved)
        return (es
          ? `${h} se desconectó y ${n === 1 ? "su trabajo no pudo" : `${n} trabajos no pudieron`} pasar a otra computadora: ${items}. Volvé a conectar ${h} o decime que ${n === 1 ? "lo" : "los"} reinicie acá.`
          : `${h} went offline and ${n === 1 ? "its work" : `${n} pieces of work`} could not move to another computer: ${items}. Bring ${h} back or tell me to restart ${n === 1 ? "it" : "them"} here.`);
      return (es
        ? `${h} está desconectada${minutes(inp.minutes, lang)} con ${n === 1 ? "un trabajo" : `${n} trabajos`} adentro: ${items}. Volvé a conectarla o decime que ${n === 1 ? "lo" : "los"} reinicie acá.`
        : `${h} has been offline${inp.minutes ? ` for ${Math.round(inp.minutes)} minutes` : ""} with ${n === 1 ? "work" : `${n} pieces of work`} on it: ${items}. Bring it back or tell me to restart ${n === 1 ? "it" : "them"} here.`);
    }
    case "job_failed": {
      const j = flat(inp.job, 60);
      const w = where(inp.ws, lang);
      if (inp.auth) {
        const tool = toolName(inp.backend);
        return cap(es
          ? `${w}la tarea programada “${j}” falló porque ${tool ? `${tool} no tiene` : "su cuenta no tiene"} la sesión iniciada. Iniciá sesión y la corro de nuevo.`
          : `${w}the scheduled job “${j}” failed because ${tool || "its account"} is logged out. Log in and I will run it again.`);
      }
      const why = inp.timeout ? (es ? "se quedó sin tiempo" : "it ran out of time") : flat(inp.why, 90);
      return cap(es
        ? `${w}la tarea programada “${j}” falló${why ? `: ${why}` : ""}. Decidí si la corro de nuevo.`
        : `${w}the scheduled job “${j}” failed${why ? `: ${why}` : ""}. Decide whether to run it again.`);
    }
    case "summary": {
      const n = inp.items.length;
      return es
        ? `Hay ${n} ${n === 1 ? "cosa trabada más" : "cosas trabadas más"} esperándote: ${list(inp.items, lang)}. Junto los próximos avisos en uno por hora; el Desk las tiene todas.`
        : `${n} more ${n === 1 ? "thing is" : "things are"} stuck and waiting on you: ${list(inp.items, lang)}. I am folding further alerts into one an hour; the Desk has them all.`;
    }
  }
}

/** The notification's title: where, and the shape of the problem, in a few words. */
export function alertTitle(inp: TextInput, lang: AlertLang = "en"): string {
  const es = lang === "es";
  const ws = "ws" in inp ? flat(inp.ws, 30) : "";
  const pre = ws ? `${ws} · ` : "";
  switch (inp.kind) {
    case "decide": return pre + (es ? "espera tu respuesta" : "waiting on your answer");
    case "blocked": return pre + (inp.reason === "auth" ? (es ? "necesita una sesión" : "needs a login") : es ? "trabada" : "stuck");
    case "stalled": return pre + (es ? "dejó de responder" : "stopped responding");
    case "wall": return pre + (inp.wall === "credit" ? (es ? "sin créditos" : "out of credits") : es ? "límite de uso" : "usage limit");
    case "host": return `${flat(inp.host, 30) || (es ? "Una computadora" : "A computer")} ${es ? "desconectada" : "offline"}`;
    case "job_failed": return pre + (es ? "falló una tarea programada" : "a scheduled job failed");
    case "summary": return es ? `${inp.items.length} trabadas más` : `${inp.items.length} more stuck`;
  }
}

/** "resets 3pm" / "resets Nov 12" out of a CLI's wall line, for the sentence. */
export function resetsOf(line: string | null | undefined): string | null {
  const m = /\bresets?\s+(?:at\s+)?([^·|()]{2,24}?)(?=\s*(?:[·|()]|$))/i.exec(String(line ?? ""));
  return m ? m[1].trim() : null;
}
