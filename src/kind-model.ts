/**
 * The model a fresh claude terminal gets from the shape of its work, when nobody named one.
 *
 * Every workspace defaults to opus, so a terminal opened to read, check and report ran on opus too. In
 * the 7 days to 2026-11-17, investigation terminals on opus averaged $2.10 list each (46 of them, lead
 * workers included) against $0.78 for the 26 the operator had opened on sonnet — and on the two client
 * accounts that ran out that day, lead workers on investigation goals were the biggest single share.
 * A model named at spawn (the dialog, `mc session new --model`, a Lead's choice) always wins.
 */
import { defineSetting, resolveSetting } from "./settings.js";

defineSetting({
  key: "desk.investigation_model", group: "Limits", level: "both", type: "enum", env: "CHRONOS_INVESTIGATION_MODEL",
  label: "Model for investigation terminals",
  help: "A new terminal whose work is an investigation (read, check, report back) starts on this model unless one was picked when it was opened. Empty: the workspace's default model.",
  options: () => ["", "sonnet", "haiku", "opus", "fable"],
  default: () => process.env.CHRONOS_INVESTIGATION_MODEL ?? "sonnet",
});

/** The model for this kind of work in this workspace, or null to keep the usual default. */
export function modelForKind(kind: string | null | undefined, workspaceId: string | null | undefined): string | null {
  if (kind !== "investigation") return null;
  const v = String(resolveSetting("desk.investigation_model", workspaceId ?? null).value ?? "").trim();
  return v || null;
}
