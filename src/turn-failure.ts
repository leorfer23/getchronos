/**
 * A Robert turn that failed, said in one plain sentence he can act on — spoken on a call and shown in
 * the chat — instead of a raw CLI error behind a spinner.
 *
 * Two failures are worth naming, because waiting or retrying never fixes them and he has to do
 * something: the Claude login is dead (expired, revoked, never logged in) and the model provider
 * cannot be reached at all. Everything else stays the error it was ("other").
 *
 * The other half of "fail fast" lives where the CLI runs (telegram/agent.ts WarmManager): its
 * `system/api_retry` stream event names the error category on the FIRST retry, so an
 * authentication_failed or a no-response is cut there instead of after the CLI's own ten retries.
 */
import { isAuthError, isUnreachableError } from "./manager-fallback.js";
import { nameIt } from "./settings.js";

export type FailureKind = "auth" | "unreachable" | "other";

const LINES: Record<Exclude<FailureKind, "other">, { es: string; en: string }> = {
  auth: {
    es: "El login de Claude de Robert venció; hay que renovarlo en la Mac.",
    en: "Robert's Claude login expired; it has to be renewed on the Mac.",
  },
  unreachable: {
    es: "No llego al proveedor del modelo; revisá la conexión de la Mac.",
    en: "I can't reach the model provider; check the Mac's connection.",
  },
};

/** Spanish when his words look Spanish. */
export function saidInSpanish(text: string): boolean {
  return /[ñáéíóú¿¡]|\b(que|el|la|los|de|dale|che|como|esta|hola|vos|qué|cómo|está)\b/i.test(String(text ?? ""));
}

export function failureKind(err: unknown): FailureKind {
  if (isAuthError(err)) return "auth";
  if (isUnreachableError(err)) return "unreachable";
  return "other";
}

/**
 * The reply a failed turn leaves: one plain sentence for auth/unreachable (no ⚠️ — the call speaks
 * it), the raw error behind ⚠️ for anything else (as before).
 */
export function plainFailure(err: unknown, said = ""): { kind: FailureKind; reply: string } {
  const kind = failureKind(err);
  if (kind === "other") return { kind, reply: "⚠️ " + String((err as any)?.message ?? err) };
  return { kind, reply: nameIt(LINES[kind][saidInSpanish(said) ? "es" : "en"]) };
}

/** The line put ahead of a fallback engine's answer when the primary's login was the reason. */
export function authNotice(said = ""): string {
  return nameIt(LINES.auth[saidInSpanish(said) ? "es" : "en"]);
}
