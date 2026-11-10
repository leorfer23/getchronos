// Which ggml model file each whisper engine runs. Pure — install-launchd.mjs installs things when
// imported, so the choices live here where a test can reach them.

/** Multilingual before English-only; small (the latency pick) first; an explicit name wins when it exists. */
export function pickWhisperModel(models, pinned) {
  if (pinned && models.includes(pinned)) return pinned;
  const rank = (f) => {
    if (/\.en\b|\.en\.bin$/.test(f)) return 100; // English-only: last resort
    const order = ["small", "large-v3-turbo", "large-v3", "large-v2", "large", "medium", "base", "tiny"];
    const i = order.findIndex((o) => f.includes(o));
    return i < 0 ? 50 : i;
  };
  return [...models].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

/**
 * The model for the second engine — the one that transcribes finished sentences (sh.chronos.whisper-final).
 * The most accurate multilingual model present that is NOT the one the fast engine already runs: two
 * servers on the same file would be the same engine twice. null → no second engine, finals stay on
 * the fast one.
 */
export function pickFinalModel(models, fastModel, pinned) {
  if (pinned) return models.includes(pinned) && pinned !== fastModel ? pinned : null;
  const order = ["large-v3-turbo", "large-v3", "large-v2", "large", "medium"];
  const multi = models.filter((f) => f !== fastModel && !/\.en\b|\.en\.bin$/.test(f));
  for (const o of order) {
    const hit = multi.filter((f) => f.includes(o)).sort()[0];
    if (hit) return hit;
  }
  return null;
}
