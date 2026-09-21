// wapp — stage and send WhatsApp messages through the real macOS client.
//
// Why a compiled binary and not a shell script: TCC attributes Accessibility to the *process*, and a
// script's process is whatever shell ran it — on this machine that is Claude Code, whose path carries
// its version (…/versions/2.1.220) and so loses the grant on every update. A binary at a fixed path
// holds the grant itself. Same reasoning as mc-overlay.
//
// No linked device, no reverse-engineered protocol: WhatsApp only ever sees its own official client,
// so ban exposure stays behavioral (volume, reply-ratio) rather than fingerprint-based.
//
//   ./scripts/build-wapp.sh   (bundle + stable signing identity — see desktop/README.md)
//
// Verbs: doctor · probe · draft · send · schedule · schedules · unschedule · fire · cancel

import AppKit
import ApplicationServices

let WHATSAPP_BUNDLE = "net.whatsapp.WhatsApp"
let STAGE_TTL: TimeInterval = 10 * 60
let stagePath = ("~/.mc/state/wapp-staged.json" as NSString).expandingTildeInPath

func die(_ msg: String) -> Never {
    FileHandle.standardError.write(("wapp: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

// MARK: - AX helpers

func axAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &out) == .success ? out : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    axAttr(el, attr) as? String
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// Depth-first walk, capped — WhatsApp's tree is wide and we only ever want the compose area.
func axFind(_ el: AXUIElement, depth: Int = 0, max: Int = 14, _ match: (AXUIElement) -> Bool) -> AXUIElement? {
    if depth > max { return nil }
    if match(el) { return el }
    for child in axChildren(el) {
        if let hit = axFind(child, depth: depth + 1, max: max, match) { return hit }
    }
    return nil
}

func whatsappApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: WHATSAPP_BUNDLE).first
}

func axRoot() -> AXUIElement {
    guard let app = whatsappApp() else { die("WhatsApp is not running — open it first.") }
    return AXUIElementCreateApplication(app.processIdentifier)
}

/// The message compose box. Prefers the focused text element (right after the chat opens, focus lands
/// there); falls back to the last text area in the window, which is where the composer sits.
func composeBox() -> AXUIElement? {
    let root = axRoot()
    if let focused = axAttr(root, kAXFocusedUIElementAttribute) {
        let el = focused as! AXUIElement
        let role = axString(el, kAXRoleAttribute) ?? ""
        if role == kAXTextAreaRole || role == kAXTextFieldRole { return el }
    }
    var last: AXUIElement?
    _ = axFind(root) { el in
        let role = axString(el, kAXRoleAttribute) ?? ""
        if role == kAXTextAreaRole || role == kAXTextFieldRole { last = el }
        return false  // keep walking; we want the last one, not the first
    }
    return last
}

func composeText() -> String {
    guard let box = composeBox() else { return "" }
    return axString(box, kAXValueAttribute) ?? ""
}

/// AX descriptions carry a leading LTR mark ("‎Enviar"), which breaks naive comparisons.
func cleanDesc(_ s: String) -> String {
    s.replacingOccurrences(of: "\u{200E}", with: "")
        .replacingOccurrences(of: "\u{200F}", with: "")
        .trimmingCharacters(in: .whitespaces)
        .lowercased()
}

/// The send button. Pressing it beats posting a Return: no focus stealing, so it cannot race whatever
/// The operator is typing elsewhere, and it does not depend on activating the app (which a background process is
/// not allowed to do anyway).
///
/// Matched by LABEL across the whole compose row, never by position. The button moves: it has been seen
/// both after the composer and before it ([attach][send][composer][emoji]), and keying off "the next
/// button after the composer" silently selected the emoji picker instead, which failed a scheduled send.
/// Scoped to the composer's siblings so the Enviar* menu items cannot match — those are AXMenuItem, but
/// staying local keeps it true even if that changes.
func sendButton() -> AXUIElement? {
    guard let box = composeBox(),
          let parent = axAttr(box, kAXParentAttribute) else { return nil }
    return axChildren(parent as! AXUIElement).first { el in
        guard axString(el, kAXRoleAttribute) == kAXButtonRole else { return false }
        let desc = cleanDesc(axString(el, kAXDescriptionAttribute) ?? "")
        return desc == "enviar" || desc == "send"
    }
}

/// Trailing whitespace and newline flavor differ between what we send and what the box reports.
func normalize(_ s: String) -> String {
    s.replacingOccurrences(of: "\r\n", with: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - Permission

func requireAX(prompt: Bool) {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    if !AXIsProcessTrustedWithOptions(opts) {
        die("""
            no Accessibility permission.
            Grant it to ~/.mc/wapp.app in System Settings → Privacy & Security → Accessibility.
            If a shell says this is granted but a launchd job says it is not, the grant went to the
            terminal rather than to wapp.app — the terminal lends its own, and an agent has no terminal.
            """)
    }
}

// MARK: - Staged state

struct Stage: Codable {
    let to: String
    let text: String
    let token: String
    let at: TimeInterval
}

func writeStage(_ s: Stage) {
    let dir = (stagePath as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(s) else { die("could not encode stage") }
    try? data.write(to: URL(fileURLWithPath: stagePath))
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stagePath)
}

func readStage() -> Stage? {
    guard let data = FileManager.default.contents(atPath: stagePath) else { return nil }
    return try? JSONDecoder().decode(Stage.self, from: data)
}

func clearStage() {
    try? FileManager.default.removeItem(atPath: stagePath)
}

func makeToken() -> String {
    String((0..<8).map { _ in "abcdefghijkmnpqrstuvwxyz23456789".randomElement()! })
}

// MARK: - Args

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--" + name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func hasFlag(_ name: String) -> Bool { CommandLine.arguments.contains("--" + name) }

// MARK: - Verbs

func cmdDoctor() {
    let app = whatsappApp()
    print("WhatsApp running:  \(app != nil ? "yes (pid \(app!.processIdentifier))" : "NO — open it")")
    let trusted = AXIsProcessTrustedWithOptions(nil)
    print("Accessibility:     \(trusted ? "granted" : "NOT granted — see System Settings → Privacy & Security → Accessibility")")
    if trusted, app != nil {
        print("Compose box found: \(composeBox() != nil ? "yes" : "no (open a chat first)")")
    }
    if let s = readStage() {
        let age = Int(Date().timeIntervalSince1970 - s.at)
        let fresh = TimeInterval(age) < STAGE_TTL
        print("Staged:            \(s.to) · token \(s.token) · \(age)s old \(fresh ? "(valid)" : "(EXPIRED)")")
        print("  text: \(s.text.prefix(120))")
    } else {
        print("Staged:            nothing")
    }
}

/// Dump the AX tree so the compose-box and send-button selectors can be tuned against a real window.
func cmdProbe() {
    requireAX(prompt: true)
    let maxDepth = Int(argValue("depth") ?? "10") ?? 10
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > maxDepth { return }
        let role = axString(el, kAXRoleAttribute) ?? "?"
        let sub = axString(el, kAXSubroleAttribute).map { " [\($0)]" } ?? ""
        let title = axString(el, kAXTitleAttribute).map { " title=\"\($0)\"" } ?? ""
        let desc = axString(el, kAXDescriptionAttribute).map { " desc=\"\($0)\"" } ?? ""
        let value = (axAttr(el, kAXValueAttribute) as? String).map { " value=\"\($0.prefix(60))\"" } ?? ""
        print(String(repeating: "  ", count: depth) + role + sub + title + desc + value)
        for child in axChildren(el) { walk(child, depth + 1) }
    }
    walk(axRoot(), 0)
}

/// Overwrite the composer directly. Used only to drop a leftover draft that `?text=` appended to.
func setComposer(_ box: AXUIElement, _ text: String) -> Bool {
    AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, text as CFTypeRef)
    Thread.sleep(forTimeInterval: 0.3)
    return normalize(composeText()) == normalize(text)
}

enum LoadResult {
    case ok
    /// The chat is open and our text landed, but a draft the operator had already typed sits in front of it.
    case conflict(existing: String)
    case failed
}

/// Open `to`'s chat and get `text` into the composer, confirming via AX that it actually landed.
/// Shared by draft (the operator is watching) and fire (nobody is) — both must refuse to proceed on doubt.
///
/// `whatsapp://send?text=` APPENDS to whatever draft the target chat already holds, it does not
/// replace it. That is also the one reliable proof the right chat is open — our text showing up in the
/// box is what confirms the switch happened — so the append is kept rather than worked around, and a
/// leftover prefix is reported as a conflict instead of being silently overwritten. Blowing away
/// something the operator typed is worse than not sending.
func loadIntoComposer(to: String, text: String, force: Bool = false) -> LoadResult {
    let digits = to.filter(\.isNumber)
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let encoded = text.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    guard let url = URL(string: "whatsapp://send?phone=\(digits)&text=\(encoded)") else { return .failed }

    // Cold start (a scheduled fire may be the thing that launches WhatsApp) needs a longer grace period
    // than switching chats in an app that is already up.
    let wasRunning = whatsappApp() != nil
    let want = normalize(text)
    NSWorkspace.shared.open(url)

    // Equality means the chat's composer was empty; a suffix match means it already held a draft.
    var settled = ""
    for _ in 0..<(wasRunning ? 40 : 120) {
        Thread.sleep(forTimeInterval: 0.2)
        let now = normalize(composeText())
        guard now == want || now.hasSuffix(want) else { continue }
        // The client re-applies ?text= a beat after the chat opens. Let that settle before the caller
        // presses Send, otherwise the box refills moments after a real send and looks like a failure.
        Thread.sleep(forTimeInterval: 1.0)
        settled = normalize(composeText())
        break
    }

    if settled == want { return .ok }
    if !settled.isEmpty, settled.hasSuffix(want) {
        let existing = String(settled.dropLast(want.count))
        guard force, let box = composeBox() else { return .conflict(existing: existing) }
        return setComposer(box, text) ? .ok : .conflict(existing: existing)
    }

    // ?text= never landed. Anything sitting in the box is the operator's, so report it rather than pasting on
    // top — Cmd+V appends just like ?text= does, which would mangle a draft instead of replacing it.
    // Only an empty composer earns the clipboard fallback.
    let current = normalize(composeText())
    if !current.isEmpty {
        guard force, let box = composeBox() else { return .conflict(existing: current) }
        return setComposer(box, text) ? .ok : .conflict(existing: current)
    }

    let pb = NSPasteboard.general
    let saved = pb.string(forType: .string)
    pb.clearContents()
    pb.setString(text, forType: .string)
    whatsappApp()?.activate()
    Thread.sleep(forTimeInterval: 0.4)
    keystroke(9, command: true)  // Cmd+V
    Thread.sleep(forTimeInterval: 0.5)
    if let saved { pb.clearContents(); pb.setString(saved, forType: .string) }
    return normalize(composeText()) == want ? .ok : .failed
}

func cmdDraft() {
    requireAX(prompt: true)
    guard let to = argValue("to") else { die("draft needs --to <phone in E.164>") }
    guard let text = argValue("text") else { die("draft needs --text \"...\"") }
    if normalize(text).isEmpty { die("refusing to stage an empty message") }
    if to.filter(\.isNumber).count < 8 { die("--to must be a full international number, e.g. +5491122334455") }

    switch loadIntoComposer(to: to, text: text, force: hasFlag("force")) {
    case .ok: break
    case .conflict(let existing):
        die("""
            that chat already has an unsent draft — nothing staged, and it was left untouched:
              "\(existing.prefix(120))"
            Send or clear it in WhatsApp, or re-run with --force to replace it (`wapp clear` empties it).
            """)
    case .failed:
        die("""
            chat opened but the composer does not hold the message — nothing staged.
            Check the window, then retry. Never assume this one went out.
            """)
    }

    let token = makeToken()
    writeStage(Stage(to: to, text: text, token: token, at: Date().timeIntervalSince1970))
    print("staged for \(to) — loaded in the composer, NOT sent.")
    print("text: \(text)")
    print("Press Return in WhatsApp, or once the operator approves: wapp send --token \(token)")
}

func cmdSend() {
    requireAX(prompt: true)
    guard let token = argValue("token") else {
        die("send needs --token from a prior `wapp draft` (this is the approval gate; there is no direct send)")
    }
    guard let stage = readStage() else { die("nothing staged — run `wapp draft` first") }
    if stage.token != token { die("token does not match what is staged — refusing to send") }
    if Date().timeIntervalSince1970 - stage.at > STAGE_TTL {
        clearStage()
        die("staged message is older than \(Int(STAGE_TTL / 60))m — re-draft it so the operator sees the current text")
    }

    // The real guard: whatever is in the box right now is what will go out. If it drifted from the
    // approved text — he edited it, the chat switched, the composer lost it — abort rather than guess.
    let current = composeText()
    if normalize(current) != normalize(stage.text) {
        die("""
            composer no longer holds the approved message — refusing to send.
              approved: \(stage.text.prefix(100))
              in box:   \(current.prefix(100))
            """)
    }

    if hasFlag("dry-run") {
        print("dry-run: would send to \(stage.to) via \(sendButton() != nil ? "the Send button" : "a Return keystroke") — composer verified, nothing pressed.")
        return
    }

    let cleared = performSend(verifying: stage.text)
    clearStage()
    print(cleared
        ? "sent to \(stage.to)."
        : "pressed Send but the composer never cleared — check the window before re-sending.")
}

/// How many transcript rows quote `text`. The composer is an AXTextArea and static text is not, so the
/// pending message never inflates this — which is what makes it usable as "did it actually go out".
/// Matches on a prefix because both the chat-list preview and long rows get truncated.
func transcriptMentions(_ text: String) -> Int {
    let needle = String(normalize(text).prefix(40))
    if needle.isEmpty { return 0 }
    var n = 0
    _ = axFind(axRoot()) { el in
        if axString(el, kAXRoleAttribute) == kAXStaticTextRole,
           let v = axString(el, kAXValueAttribute), v.contains(needle) { n += 1 }
        return false  // count every match, never stop early
    }
    return n
}

/// Press Send and confirm it landed. Primary evidence is a new transcript row; an emptied composer is
/// only a fallback signal, because `whatsapp://send` re-applies its ?text= a beat after the chat opens
/// and can refill the box moments after a genuine send — which reported a false failure the first time
/// a scheduled fire ran, and left a --once schedule armed to send again the next day.
func performSend(verifying text: String) -> Bool {
    let before = transcriptMentions(text)
    if let button = sendButton() {
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
            die("pressing Send failed — nothing sent")
        }
    } else {
        // No button in the tree (older layout, or a locale we do not match): fall back to Return, which
        // needs the app focused. Refuse rather than fire a keystroke at whatever happens to be in front.
        guard let wa = whatsappApp() else { die("WhatsApp is not running") }
        let previous = NSWorkspace.shared.frontmostApplication
        wa.activate()
        for _ in 0..<20 {
            Thread.sleep(forTimeInterval: 0.1)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == wa.processIdentifier { break }
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == wa.processIdentifier else {
            die("no Send button found and WhatsApp will not come to the front — refusing to send a Return blind")
        }
        keystroke(36)  // Return
        if let previous, previous.processIdentifier != wa.processIdentifier {
            Thread.sleep(forTimeInterval: 0.3)
            previous.activate()
        }
    }
    for _ in 0..<20 {
        Thread.sleep(forTimeInterval: 0.25)
        if transcriptMentions(text) > before { return true }
        if normalize(composeText()).isEmpty { return true }
    }
    return false
}

// MARK: - Schedules
//
// A scheduled send has no human at the other end, so the approval has to be frozen at schedule time:
// `schedule` consumes a token from `draft`, meaning the operator saw this exact text sitting in their own window
// before it was stored. Fire time re-loads that stored text verbatim — no model, no regeneration, no
// tokens burned. StartCalendarInterval also gives the wake behaviour we want for free: asleep at the
// scheduled minute means launchd runs the job when the machine wakes, rather than skipping the day.

struct Schedule: Codable {
    let id: String
    let to: String
    let text: String
    let at: String       // "HH:MM"
    let days: [Int]?     // launchd Weekday, 0=Sunday … 6=Saturday. nil = every day.
    let once: Bool
}

let scheduleDir = ("~/.mc/state/wapp-schedules" as NSString).expandingTildeInPath
let wappLog = ("~/.mc/state/wapp.log" as NSString).expandingTildeInPath
func plistPath(_ id: String) -> String {
    ("~/Library/LaunchAgents/sh.chronos.wapp-\(id).plist" as NSString).expandingTildeInPath
}

func logLine(_ s: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(s)\n"
    if let fh = FileHandle(forWritingAtPath: wappLog) {
        fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); fh.closeFile()
    } else {
        try? FileManager.default.createDirectory(atPath: (wappLog as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true)
        try? line.write(toFile: wappLog, atomically: true, encoding: .utf8)
    }
}

/// Desktop notification, same mechanism src/notify.ts uses. Best-effort: a failed notice must never
/// change whether the message went out.
func notifyDesktop(_ title: String, _ body: String) {
    let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""]
    try? p.run()
    p.waitUntilExit()
}

func readSchedule(_ id: String) -> Schedule? {
    guard let data = FileManager.default.contents(atPath: "\(scheduleDir)/\(id).json") else { return nil }
    return try? JSONDecoder().decode(Schedule.self, from: data)
}

func allSchedules() -> [Schedule] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: scheduleDir)) ?? []
    return names.filter { $0.hasSuffix(".json") }
        .compactMap { readSchedule(String($0.dropLast(5))) }
        .sorted { $0.at < $1.at }
}

let DAY_NAMES = ["sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6]

func launchctl(_ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
}

func writeAgent(_ s: Schedule) {
    let parts = s.at.split(separator: ":")
    let hour = Int(parts.first ?? "") ?? 0
    let minute = parts.count > 1 ? (Int(parts[1]) ?? 0) : 0
    let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]

    func interval(_ weekday: Int?) -> String {
        var d = "      <dict>\n        <key>Hour</key><integer>\(hour)</integer>\n"
        d += "        <key>Minute</key><integer>\(minute)</integer>\n"
        if let weekday { d += "        <key>Weekday</key><integer>\(weekday)</integer>\n" }
        return d + "      </dict>\n"
    }
    let intervals = (s.days?.map { interval($0) } ?? [interval(nil)]).joined()

    let plist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>Label</key><string>sh.chronos.wapp-\(s.id)</string>
      <key>ProgramArguments</key>
      <array><string>\(exe)</string><string>fire</string><string>\(s.id)</string></array>
      <key>StartCalendarInterval</key>
      <array>
    \(intervals)  </array>
      <key>StandardErrorPath</key><string>\(wappLog)</string>
    </dict></plist>
    """
    try? plist.write(toFile: plistPath(s.id), atomically: true, encoding: .utf8)
    launchctl(["bootout", "gui/\(getuid())/sh.chronos.wapp-\(s.id)"])
    launchctl(["bootstrap", "gui/\(getuid())", plistPath(s.id)])
}

/// Files first, bootout last. A --once schedule is retired by `fire` itself, so the bootout targets the
/// very job this process is running under and can kill it mid-call — doing it last means the state is
/// already clean when that happens. Otherwise the schedule survived and would have fired again the
/// next day.
func removeAgent(_ id: String) {
    try? FileManager.default.removeItem(atPath: "\(scheduleDir)/\(id).json")
    try? FileManager.default.removeItem(atPath: plistPath(id))
    launchctl(["bootout", "gui/\(getuid())/sh.chronos.wapp-\(id)"])
}

func cmdSchedule() {
    requireAX(prompt: true)
    guard let token = argValue("token") else {
        die("schedule needs --token from a prior `wapp draft` — the staged text is what gets frozen")
    }
    guard let at = argValue("at"), at.contains(":") else { die("schedule needs --at HH:MM (24h)") }
    guard let stage = readStage() else { die("nothing staged — run `wapp draft` first") }
    if stage.token != token { die("token does not match what is staged — refusing to schedule") }
    if Date().timeIntervalSince1970 - stage.at > STAGE_TTL {
        clearStage()
        die("staged message is older than \(Int(STAGE_TTL / 60))m — re-draft it so the operator sees the current text")
    }
    // Same guard as send: what gets stored must be what he actually saw, not what we hope he saw.
    if normalize(composeText()) != normalize(stage.text) {
        die("composer no longer holds the approved message — refusing to schedule it")
    }

    var days: [Int]? = nil
    if let raw = argValue("days") {
        let parsed = raw.lowercased().split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
        let mapped = parsed.compactMap { DAY_NAMES[$0] }
        if mapped.count != parsed.count { die("--days takes mon,tue,wed,thu,fri,sat,sun") }
        days = mapped.sorted()
    }

    let sched = Schedule(id: makeToken(), to: stage.to, text: stage.text, at: at, days: days, once: hasFlag("once"))
    try? FileManager.default.createDirectory(atPath: scheduleDir, withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(sched) else { die("could not encode schedule") }
    try? data.write(to: URL(fileURLWithPath: "\(scheduleDir)/\(sched.id).json"))
    writeAgent(sched)
    clearStage()

    let when = days.map { d in d.map { day in DAY_NAMES.first { $0.value == day }!.key }.joined(separator: ",") } ?? "every day"
    print("scheduled \(sched.id) — \(at) \(when)\(sched.once ? " (once)" : "") → \(sched.to)")
    print("text: \(sched.text)")
    print("Asleep at that minute means it fires on wake, not that it is skipped.")
}

func cmdSchedules() {
    let all = allSchedules()
    if all.isEmpty { return print("no schedules") }
    for s in all {
        let when = s.days.map { d in d.map { day in DAY_NAMES.first { $0.value == day }!.key }.joined(separator: ",") } ?? "daily"
        print("\(s.id)  \(s.at) \(when)\(s.once ? " (once)" : "")  → \(s.to)")
        print("    \(s.text.prefix(100))")
    }
}

func cmdUnschedule() {
    guard CommandLine.arguments.count > 2 else { die("unschedule needs an id — see `wapp schedules`") }
    let id = CommandLine.arguments[2]
    guard readSchedule(id) != nil else { die("no schedule \(id)") }
    removeAgent(id)
    print("removed \(id)")
}

/// Invoked by launchd only. Nobody is watching, so every failure path logs and notifies rather than
/// dying quietly — a scheduled message that silently never went out is the worst outcome here.
func cmdFire() {
    guard CommandLine.arguments.count > 2, let s = readSchedule(CommandLine.arguments[2]) else {
        logLine("fire: unknown schedule id")
        exit(1)
    }
    func fail(_ why: String) -> Never {
        logLine("fire \(s.id): FAILED — \(why)")
        notifyDesktop("WhatsApp not sent", "\(s.to): \(why)")
        exit(1)
    }
    guard AXIsProcessTrustedWithOptions(nil) else { fail("no Accessibility permission") }
    // Never --force here: unattended is exactly when destroying something the operator typed is unrecoverable.
    switch loadIntoComposer(to: s.to, text: s.text) {
    case .ok: break
    case .conflict(let existing): fail("that chat has an unsent draft (\"\(existing.prefix(40))\") — left it alone")
    case .failed: fail("could not load the message into the composer")
    }
    guard normalize(composeText()) == normalize(s.text) else { fail("composer does not hold the scheduled text") }

    if performSend(verifying: s.text) {
        logLine("fire \(s.id): sent to \(s.to)")
        notifyDesktop("WhatsApp sent", "\(s.to): \(s.text.prefix(80))")
        if s.once { removeAgent(s.id) }
    } else {
        fail("pressed Send but the composer never cleared")
    }
}

func keystroke(_ keyCode: CGKeyCode, command: Bool = false) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
    if command {
        down?.flags = .maskCommand
        up?.flags = .maskCommand
    }
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
}

// MARK: - Main

let verb = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "doctor"
switch verb {
case "doctor": cmdDoctor()
case "probe": cmdProbe()
case "draft": cmdDraft()
case "send": cmdSend()
case "schedule": cmdSchedule()
case "schedules": cmdSchedules()
case "unschedule": cmdUnschedule()
case "fire": cmdFire()
case "cancel": clearStage(); print("staged message cleared (the text stays in the composer).")
case "clear":
    requireAX(prompt: true)
    guard let box = composeBox() else { die("no composer — open a chat first") }
    let had = composeText()
    if normalize(had).isEmpty { print("composer is already empty."); break }
    print(setComposer(box, "") ? "cleared: \"\(had.prefix(80))\"" : "could not clear the composer")
default:
    print("""
        wapp — WhatsApp through the real macOS client.

          wapp doctor                                 health + what is staged
          wapp draft --to +5491122334455 --text "…"   open chat, load text, DO NOT send
          wapp send --token <tok> [--dry-run]         press Send, only if the box still matches
          wapp cancel                                 drop the staged token
          wapp probe [--depth N]                      dump the AX tree

          wapp schedule --token <tok> --at 07:00 [--days mon,tue] [--once]
          wapp schedules                              list them
          wapp unschedule <id>                        remove one

        draft never sends. send and schedule both need a token from draft and re-verify the
        composer first, so nothing is ever sent or stored that the operator has not seen in their own window.
        A schedule freezes that exact text — fire time re-sends it verbatim, with no model involved.
        """)
}
