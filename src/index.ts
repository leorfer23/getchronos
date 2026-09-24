import "./env.js";
import { CONFIG } from "./config.js";
import { startServer } from "./api.js";
import { reloadSchedules } from "./scheduler.js";
import { startTelegram } from "./telegram.js";
import { startRelay } from "./relay-client.js";
import { startNotify } from "./notify.js";
import { startPush } from "./push.js";
import { sessionActivity, sessionPrompt } from "./terminal.js";
import { startCalendar } from "./calendar.js";
import { startReminders } from "./reminders.js";
import { startTerminals } from "./terminal.js";
import { startConnectorSync } from "./connectors/index.js";
import { startRepoScan } from "./repo-scan.js";
import { startMonitor } from "./monitor.js";
import { startAutoPlan } from "./autoplan.js";
import { startBurnGuard } from "./burn-guard.js";
import { startIdeas } from "./ideas.js";
import { startWriteback } from "./writeback.js";
import { startIntake } from "./intake.js";
import { installAllSlackMcp } from "./slack.js";
import { installAllFffMcp, installRtkRewriteScript } from "./efficiency-tools.js";
import { startEgress } from "./egress.js";
import { startActivity } from "./activity.js";
import { startMachineGovernor } from "./machine.js";
import { startAwake } from "./awake.js";
import { startWatches } from "./watches.js";
import { startDayHeartbeat, startStandup } from "./heartbeat.js";
import { startMergeGate } from "./merge-gate.js";
import { startSelfDeploy } from "./self-deploy.js";
import { startAgentLifecycleBridge } from "./agent-lifecycle.js";
import { startDeskTitles } from "./desk-title.js";
import { startUsageTicker } from "./session-usage.js";
import { startTermStatus, statusOf } from "./term-status.js";
import { startBoardWatcher } from "./board.js";
import { startRobertWake } from "./robert-wake.js";
import { startWakeQueue } from "./wake-queue.js";
import { startDeskWatch } from "./desk-watch.js";
import { startTerminalPrompts } from "./terminal-prompts.js";
import { startRobertDrive } from "./robert-drive.js";
import { startTerminalFailover } from "./terminal-failover.js";
import { startWorklog } from "./worklog.js";
import { startCloudReconcile } from "./cloud-reconcile.js";
import { searchIndex } from "./store.js";
import { startHostLink } from "./hostlink/brain-link.js";

// Defense-in-depth: every route handler and background async path is expected to catch its own
// errors (see api.ts) — this is the backstop for whatever still slips through. Without it, Node's
// default is to crash the whole daemon (every live terminal, WS client, scheduled job) on a single
// unhandled rejection from anywhere in the process.
process.on("unhandledRejection", (reason) => {
  console.error("[chronos] unhandled rejection (daemon stays up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[chronos] uncaught exception (daemon stays up):", err);
});

console.log(`[chronos] starting — db=${CONFIG.dbPath}`);
// Project dirs have no portable default (checkout locations differ per machine), so an
// unconfigured Mac silently runs guard-mode jobs with NO sibling-project isolation. Say so.
if (CONFIG.sandbox.defaultMode !== "off" && CONFIG.sandbox.projectDirs.length === 0) {
  console.warn(
    "[sandbox] CHRONOS_PROTECTED_DIRS_EXTRA is unset — guard/strict jobs can read sibling " +
      "project dirs. Set it in .secrets (see .secrets.example) to your checkout root.",
  );
}
searchIndex.backfill();
startActivity();
startMachineGovernor();
reloadSchedules();
startServer();
// Hosts (HOSTS.md): the LAN listener for `chronos host` links — a no-op unless CHRONOS_HOST_LISTEN is set.
void startHostLink(CONFIG.hostListen);
void startEgress();
startTelegram();
startRelay();
startNotify();
startPush({ activity: sessionActivity, prompt: sessionPrompt, phase: (id) => statusOf(id)?.phase ?? null });
startTermStatus();
startMergeGate();
startSelfDeploy();
startAgentLifecycleBridge();
startDeskTitles();
startWorklog();
startUsageTicker();
startBoardWatcher();
startRobertWake();
// Durable wake queue: every decision event is a row before it is a turn, replayed on boot.
startWakeQueue();
// A terminal that stops on a question wakes him too, not just an API ask.
startTerminalPrompts();
startRobertDrive();
startTerminalFailover();
// Standing watches on single terminals + the deadlines that stop a question sitting with Robert forever.
startDeskWatch();
startCalendar();
startReminders();
void startTerminals();
startConnectorSync();
startRepoScan();
startMonitor();
startBurnGuard();
// A cloud run's process lives on the provider's VM, not here — this is the other half of
// "launch, sleep, reconcile" (runner.ts executeCloud/finalizeCloudRun): pick back up whatever was
// still 'running' when this daemon last stopped.
startCloudReconcile();
startAutoPlan();
startIdeas();
startWriteback();
startIntake();
startAwake();
startWatches();
startDayHeartbeat();
startStandup();
installAllSlackMcp();
installRtkRewriteScript();
installAllFffMcp();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
