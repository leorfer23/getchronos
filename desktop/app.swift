// Mission UI window — the overlay's big sibling: a normal, resizable app window over the daemon's
// /app page (Chat / Tickets / Board / Fleet). Unlike the always-on-top ventanita this behaves like
// a real app: Dock icon, ⌘-tab, Edit menu so the chat composer gets copy/paste.
//
// Build & run:
//   swiftc -O desktop/app.swift -o ~/.mc/bin/mc-app && mc-app &
//
// Token: same rule as the retired overlay — this process runs unsandboxed as the operator, reads
// the checkout's .admin-token itself and injects window.__MC_TOKEN__; the daemon never templates the
// token into HTML (sandboxed job agents keep loopback network and could read it back out).

import Cocoa
import WebKit
import UserNotifications

// Which checkout and port this app belongs to. scripts/build-app.sh stamps both into Info.plist
// (ChronosHome, ChronosURL) from the checkout that built it, so a clone outside ~/chronos, or a daemon
// on another port, opens signed in however the app is started — Dock, Spotlight or the LaunchAgent,
// none of which can pass arguments. CHRONOS_HOME / CHRONOS_ADMIN_TOKEN in the env and a URL argument
// still win; with nothing stamped (an older build) it is ~/chronos on 7777, as it always was.
func chronosConfig(env: [String: String], info: [String: Any], args: [String], home: URL) -> (tokenFile: URL, target: String) {
  let stamped = (info["ChronosHome"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  let root = env["CHRONOS_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? stamped
  let tokenFile = root.map { URL(fileURLWithPath: $0).appendingPathComponent(".admin-token") } ?? home.appendingPathComponent("chronos/.admin-token")
  let base = (info["ChronosURL"] as? String).flatMap { $0.hasPrefix("http") ? $0 : nil } ?? "http://localhost:7777"
  // `mc-app /app` (a path on this daemon) or `mc-app http://localhost:7788/desk` (a dev daemon).
  let arg = args.dropFirst().first(where: { $0.hasPrefix("/") || $0.hasPrefix("http") })
  return (tokenFile, arg.map { $0.hasPrefix("http") ? $0 : base + $0 } ?? base + "/desk")
}
let chronos = chronosConfig(env: ProcessInfo.processInfo.environment, info: Bundle.main.infoDictionary ?? [:], args: CommandLine.arguments, home: FileManager.default.homeDirectoryForCurrentUser)
// What a test (and a puzzled operator) can ask without a window opening: where the token is read
// from — never the token — and which page loads.
if CommandLine.arguments.contains("--print-config") {
  print("token_file=\(chronos.tokenFile.path)\ntarget=\(chronos.target)")
  exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular) // Dock icon + ⌘-tab: this is the main surface, not a satellite

// Minimal menu bar: without it a .regular app has no ⌘Q and — worse — no ⌘C/⌘V in the composer.
let mainMenu = NSMenu()
let appItem = NSMenuItem(); mainMenu.addItem(appItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "Hide Chronos", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(withTitle: "Quit Chronos", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu
let editItem = NSMenuItem(); mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
editMenu.addItem(NSMenuItem.separator())
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu

// Workspace: the Desk's client lock (static/desk-scope.js) — show ONE workspace on the whole Desk
// while the screen is shared. It lives up here and not in the page on purpose: a picker listing
// every client is the one thing that must never be inside the shared window. The page reports its
// workspaces and the current lock (`workspaces` on the bridge below); a pick calls its deskLock().
let wsItem = NSMenuItem(); mainMenu.addItem(wsItem)
let wsMenu = NSMenu(title: "Workspace")
wsMenu.autoenablesItems = false
wsItem.submenu = wsMenu
class WorkspaceMenu: NSObject {
  func fill(_ list: [[String: Any]], lock: String?) {
    wsMenu.removeAllItems()
    add("All Workspaces", id: nil, on: lock == nil)
    if !list.isEmpty { wsMenu.addItem(NSMenuItem.separator()) }
    for w in list {
      guard let id = w["id"] as? String, let name = w["name"] as? String else { continue }
      add(name, id: id, on: id == lock)
    }
  }
  func add(_ title: String, id: String?, on: Bool) {
    let mi = NSMenuItem(title: title, action: #selector(pick(_:)), keyEquivalent: "")
    mi.target = self
    mi.representedObject = id
    mi.state = on ? .on : .off
    wsMenu.addItem(mi)
  }
  @objc func pick(_ sender: NSMenuItem) {
    let arg = (sender.representedObject as? String).map(jsString) ?? "null"
    web.evaluateJavaScript("window.deskLock && window.deskLock(\(arg)); void 0;") { _, _ in }
  }
}
let workspaceMenu = WorkspaceMenu()
workspaceMenu.fill([], lock: nil)
app.mainMenu = mainMenu

class Delegate: NSObject, NSApplicationDelegate {
  // NOT `true`. At login this window can come up on the "Waiting for the Chronos daemon" page
  // (the daemon needs several seconds after launchd spawns us), and that page looks broken — so
  // it gets closed. With terminate-on-last-window-closed that ✕ ended the whole app, launchd has
  // no KeepAlive for it, and the Desk was then gone until the next login. Closing now just hides
  // the window; ⌘Q still quits for real, which is the behaviour the plist's comment is about.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // …and the way back in: clicking the Dock icon (or ⌘-tab to it) re-shows the hidden window.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window.makeKeyAndOrderFront(nil) }
    return true
  }
}
let delegate = Delegate()
app.delegate = delegate

let window = NSWindow(
  contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
  styleMask: [.titled, .closable, .miniaturizable, .resizable],
  backing: .buffered, defer: false
)
window.title = "Chronos"
window.center()
window.isReleasedWhenClosed = false
window.setFrameAutosaveName("mc-mission-ui")
window.minSize = NSSize(width: 760, height: 480)

// target=_blank links (PR / tracker URLs) → default browser; WKWebView drops them otherwise.
class UI: NSObject, WKUIDelegate {
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    // Only a real web URL. A bare `window.open()` (no argument) arrives here as about:blank, and
    // handing THAT to NSWorkspace pops a native "The application can't be opened" — an error about a
    // link the user never clicked, on top of the link they did click never opening.
    if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(),
       scheme == "http" || scheme == "https" {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  // Same class of hole, and quieter: `alert()`, `confirm()` and `prompt()` are INERT in a WKWebView
  // until the host runs the panel — confirm() returns false immediately, so a page that guards a
  // destructive action behind it does NOTHING when you click, with no error anywhere. That was the
  // Desk wall's ✕ (the wall no longer needs it, but every other page here does).
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.beginSheetModal(for: webView.window ?? window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: webView.window ?? window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 22))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.beginSheetModal(for: webView.window ?? window) {
      completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil)
    }
  }

  // <input type="file"> is INERT in a WKWebView until the host app opens the panel itself — no
  // error, no console line, the click just does nothing. That was the chat's 📎 button: the picker
  // never existed, so paste and drag-drop were the only ways to attach anything.
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // The Desk's voice call with Robert. WebKit leaves navigator.mediaDevices undefined unless the
  // bundle declares NSMicrophoneUsageDescription (scripts/build-app.sh), and then asks this delegate
  // on every call; with no answer here it falls back to a WebKit sheet each time. Grant the
  // microphone to the page this window was opened on, nothing else. macOS still asks once (TCC).
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let own = origin.host == targetURL.host && origin.port == (targetURL.port ?? 0)
    decisionHandler(own && type == .microphone ? .grant : .deny)
  }
}
let ui = UI()

// The page's hand on the OS. A WKWebView has no Notification API and no Dock — so the Desk posts
// `window.webkit.messageHandlers.mc.postMessage({type, ...})` and this answers:
//   · badge  {label}            — the count of terminals waiting on you, on the Dock tile
//   · notify {title, body, url} — a system notification; clicking it brings the window up and
//                                 walks the page to `url` (/desk#reopen=<id> lands on the card)
//   · workspaces {list, lock}   — what the Workspace menu offers, and which one the Desk is locked to
// UNUserNotificationCenter needs a bundle identifier, which build-app.sh's Info.plist provides;
// a bare binary (swiftc -o) has none, so that path falls back to osascript, which has no click.
class Bridge: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
  var armed = false
  var pending: [String: String] = [:]

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any], let type = d["type"] as? String else { return }
    switch type {
    case "badge":
      let label = (d["label"] as? String) ?? ""
      NSApp.dockTile.badgeLabel = label.isEmpty ? nil : label
    case "notify":
      notify(title: (d["title"] as? String) ?? "Desk", body: (d["body"] as? String) ?? "", url: d["url"] as? String)
    case "workspaces":
      workspaceMenu.fill((d["list"] as? [[String: Any]]) ?? [], lock: d["lock"] as? String)
    default: break
    }
  }

  func notify(title: String, body: String, url: String?) {
    guard Bundle.main.bundleIdentifier != nil else {
      let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
      let p = Process(); p.launchPath = "/usr/bin/osascript"
      p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""]
      try? p.run()
      return
    }
    let center = UNUserNotificationCenter.current()
    if !armed {
      armed = true
      center.delegate = self
      center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    if let url = url { content.userInfo = ["url": url] }
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  // Show it even when this app is frontmost: the page only asks when the window is not in front,
  // but "in front" and "focused" differ when the wall sits on a second display.
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                              withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
    h([.banner, .list, .sound])
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                              withCompletionHandler h: @escaping () -> Void) {
    if let u = r.notification.request.content.userInfo["url"] as? String, URL(string: u) != nil {
      // A hash-only change on the loaded page (#reopen=…) must fire hashchange, not a reload.
      DispatchQueue.main.async { web.evaluateJavaScript("location.href = \(jsString(u)); void 0;") { _, _ in } }
    }
    DispatchQueue.main.async {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    h()
  }
}
func jsString(_ s: String) -> String {
  guard let d = try? JSONSerialization.data(withJSONObject: [s]), let lit = String(data: d, encoding: .utf8) else { return "\"\"" }
  return lit + "[0]"
}
let bridge = Bridge()

// Same token read: env override, else the checkout's .admin-token (chronosConfig above), once at launch.
func adminToken() -> String? {
  if let env = ProcessInfo.processInfo.environment["CHRONOS_ADMIN_TOKEN"], !env.isEmpty { return env }
  guard let raw = try? String(contentsOf: chronos.tokenFile, encoding: .utf8) else { return nil }
  let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  return token.isEmpty ? nil : token
}

let config = WKWebViewConfiguration()
// JSON-encode rather than interpolate — a token with a quote would break out of the JS literal.
if let token = adminToken(),
   let json = try? JSONSerialization.data(withJSONObject: [token]),
   let literal = String(data: json, encoding: .utf8) {
  config.userContentController.addUserScript(WKUserScript(
    source: "window.__MC_TOKEN__ = \(literal)[0];",
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true))
}

config.userContentController.add(bridge, name: "mc")
let web = WKWebView(frame: window.contentView!.bounds, configuration: config)
web.autoresizingMask = [.width, .height]
web.uiDelegate = ui
// Which page this window hosts: default /desk (the terminal wall), a path (`mc-app /app`), or a full
// URL (`mc-app http://localhost:7788/desk` → a dev daemon on another port) — chronosConfig above.
// Token injection is the same either way, which is what lets /desk attach to /term at all.
let target = chronos.target
let targetURL = URL(string: target)!

// At login launchd spawns this window and the daemon in the same second, and the daemon takes
// several more seconds to listen (secrets, connectors, PTY revive). A WKWebView that fails its
// first load shows nothing and never tries again — so the Desk came up as an empty white window
// every boot, and closing it quit the app until next login. Retry the load until the daemon
// answers, and say so on the window meanwhile.
class Nav: NSObject, WKNavigationDelegate {
  var attempt = 0
  var timer: Timer?
  // Our own in-flight bookkeeping rather than WKWebView.isLoading: after we cancel a response
  // ourselves (the 5xx path below) `isLoading` stays true, so a retry loop that trusted it stalled
  // until the hung-load deadline every single time.
  var inFlight = false
  var startedAt = Date.distantPast
  func log(_ s: String) { FileHandle.standardError.write(("[mc-app] " + s + "\n").data(using: .utf8)!) }

  // One repeating timer rather than a chain of one-shot retries. The chain had a hole big enough
  // to lose the window in: every next attempt was scheduled from `didFailProvisionalNavigation`,
  // and that method returns early on NSURLErrorCancelled — which is exactly what a load gets when
  // it is replaced (the retry landing on top of the waiting page) or when WebKit's network process
  // restarts. One cancelled navigation and nothing was left to try again; the window then sat on
  // "Waiting for the Chronos daemon" forever with the daemon already up.
  func arm(_ w: WKWebView) {
    guard timer == nil else { return }
    let t = Timer(timeInterval: 1.0, repeats: true) { [weak w] _ in
      guard let w = w else { return }
      // Don't cancel an attempt that is genuinely in flight — unless it has hung, in which case
      // replacing it is the only way out.
      if self.inFlight && Date().timeIntervalSince(self.startedAt) < 10 { return }
      w.load(URLRequest(url: targetURL))
    }
    // .common, not the default mode: a menu tracking or a window resize would otherwise stall the
    // retries for as long as the mouse is down.
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }
  func disarm() { timer?.invalidate(); timer = nil }

  func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) {
    inFlight = true
    startedAt = Date()
  }

  func begin(_ w: WKWebView, _ why: String) {
    inFlight = false
    attempt += 1
    if attempt == 1 {
      log("\(targetURL) \(why) — retrying until it does")
      w.loadHTMLString(waitingHTML(targetURL), baseURL: nil)
    }
    arm(w)
  }

  // Our own `.cancel` of a 5xx response comes back here as WebKitErrorDomain 102 ("frame load
  // interrupted"); counting it would double every retry number in the log for the same one attempt.
  func ours(_ err: NSError) -> Bool {
    (err.domain == NSURLErrorDomain && err.code == NSURLErrorCancelled)
      || (err.domain == "WebKitErrorDomain" && err.code == 102)
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    let err = e as NSError
    if ours(err) { inFlight = false; return }
    begin(w, "not answering (\(err.localizedDescription))")
  }

  // A load that fails after it committed (the daemon dying mid-page) is the same situation.
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) {
    let err = e as NSError
    if ours(err) { inFlight = false; return }
    begin(w, "load failed (\(err.localizedDescription))")
  }

  // The daemon can be *listening* before it serves /desk — Express binds the port early and the
  // subsystems register their routes as they come up. To WKWebView a 5xx is a perfectly successful
  // navigation, so didFinish would fire, disarm the retries, and leave the window showing the
  // daemon's error page until someone reloaded it by hand. Treat it as not-up-yet instead.
  func webView(_ w: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 500 {
      decisionHandler(.cancel)
      begin(w, "answered \(http.statusCode)")
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    inFlight = false
    guard w.url?.scheme?.hasPrefix("http") == true else { return } // the waiting page, not the daemon
    disarm()
    if attempt > 0 { log("\(targetURL) up after \(attempt) retr\(attempt == 1 ? "y" : "ies")") }
    attempt = 0
  }

  // WebKit's content process can die outright (memory pressure at login is a good way to see it),
  // and a WKWebView whose process is gone renders nothing and reports nothing. Reload it.
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    log("web content process died — reloading")
    begin(w, "web content process died")
  }
}
func waitingHTML(_ u: URL) -> String {
  let host = (u.host ?? "localhost") + (u.port.map { ":\($0)" } ?? "")
  return """
  <!doctype html><meta charset=utf-8><title>Chronos</title>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#8b949e;\
  font:15px -apple-system,system-ui,sans-serif"><div style="text-align:center">
  <div style="font-size:15px;color:#c9d1d9;margin-bottom:6px">Waiting for the Chronos daemon</div>
  <div>\(host) is not answering yet — this window loads on its own once it is.</div></div>
  """
}
let nav = Nav()
web.navigationDelegate = nav
web.load(URLRequest(url: targetURL))
window.contentView!.addSubview(web)

// The window can freeze with nothing crashing. 2026-10-29: the Desk sat frozen for minutes while the
// daemon and every terminal were fine. `sample` on mc-app put the main thread in WebKit's
// RemoteScrollingCoordinatorProxyMac::displayDidRefresh, parked on a semaphore for the scrolling
// thread — and the scrolling thread in RemoteLayerTreeEventDispatcher::mainThreadDisplayDidRefresh,
// waiting on the main thread (1542 of 1543 samples, both). That cycle is inside WebKit, and it gives
// no crash, no log line and no way back short of killing the app. So a thread that is not the main
// one keeps pinging the main queue; when a ping has gone unanswered for `limit`, it samples the hang
// for next time and exits non-zero, and the plist's KeepAlive (SuccessfulExit=false) brings a fresh
// window up. The terminals live in the daemon — a relaunch loses only the page's in-memory state.
final class Watchdog {
  let limit: UInt64 = 15 * 1_000_000_000
  let keep = 20 // hang samples kept in ~/Library/Logs/Chronos
  let queue = DispatchQueue(label: "sh.chronos.app.watchdog", qos: .userInteractive)
  let lock = NSLock()
  // When the unanswered ping went out, not when the last one came back: App Nap may stretch this
  // timer's own period, and that is not the main thread being stuck. DispatchTime is
  // mach_absolute_time, which stands still while the Mac sleeps — a closed lid is not silence.
  var sentAt: UInt64?
  var timer: DispatchSourceTimer?

  func start() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + 1, repeating: 1)
    t.setEventHandler { [self] in
      let now = DispatchTime.now().uptimeNanoseconds
      lock.lock(); let pending = sentAt; if pending == nil { sentAt = now }; lock.unlock()
      if let p = pending {
        if now &- p >= limit { bail(seconds: (now &- p) / 1_000_000_000) }
        return
      }
      DispatchQueue.main.async { self.lock.lock(); self.sentAt = nil; self.lock.unlock() }
    }
    t.resume()
    timer = t
  }

  func bail(seconds: UInt64) {
    let fm = FileManager.default
    let dir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Chronos")
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    if let old = try? fm.contentsOfDirectory(atPath: dir.path).filter({ $0.hasPrefix("mc-app-hang-") }).sorted(),
       old.count >= keep {
      for f in old.prefix(old.count - keep + 1) { try? fm.removeItem(at: dir.appendingPathComponent(f)) }
    }
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
    let out = dir.appendingPathComponent("mc-app-hang-\(stamp).txt").path
    FileHandle.standardError.write(
      "[mc-app] main thread silent \(seconds)s — sample in \(out), exiting so launchd relaunches\n".data(using: .utf8)!)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
    p.arguments = [String(ProcessInfo.processInfo.processIdentifier), "2", "-file", out]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    if (try? p.run()) != nil {
      let deadline = Date().addingTimeInterval(15)
      while p.isRunning && Date() < deadline { usleep(100_000) }
      if p.isRunning { p.terminate() }
    }
    _exit(75) // not exit(): an atexit handler can need a lock the stuck main thread is holding
  }
}
let watchdog = Watchdog()
watchdog.start()

// Proves the watchdog end to end: `MC_APP_TEST_WEDGE=3 mc-app http://127.0.0.1:9/` wedges the main
// thread three seconds in, and the process should exit 75 about `limit` after that.
if let s = ProcessInfo.processInfo.environment["MC_APP_TEST_WEDGE"], let secs = Double(s) {
  DispatchQueue.main.asyncAfter(deadline: .now() + secs) { while true { sleep(60) } }
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────────
// A Spotlight-style panel over whatever app is in front (static/bar.html): ask Robert, or send what
// is on screen to a new terminal in the workspace it belongs to (src/capture.ts). Three ways in, one
// panel:
//   · the trigger — a tap of the right ⌘ on its own, or ⌥⇧Space (`defaults write sh.chronos.app
//     barHotkey "rcmd, ctrl+opt+space"`; "off" = none) — carries what was copied in the last two
//     minutes; pressed again while the panel is up, it talks;
//   · Services → "Send to Chronos" on selected text or a file, in any app that offers Services;
//   · chronos://capture?text=…&url=…&file=… — Shot's "Send to Chronos", or anything else on this Mac.
// It is a non-activating panel: the app in front stays in front (and stays what the capture names),
// and closing the panel leaves you exactly where you were. Nothing is sent until ↵ — the URL scheme
// and the clipboard only fill the panel in.
import Carbon.HIToolbox
import ApplicationServices

func showDesk() {
  window.makeKeyAndOrderFront(nil)
  NSApp.activate(ignoringOtherApps: true)
}

final class BarPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class Bar: NSObject, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
  let width: CGFloat = 680
  let panel: BarPanel
  let view: WKWebView
  let pageURL: URL
  var loaded = false
  var pending: [String: Any]?
  var height: CGFloat = 120

  // The clipboard counts as part of a capture only when it changed recently and was not already
  // used: a link copied a minute ago is what he means; whatever sat there since this morning is not.
  var clipCount = NSPasteboard.general.changeCount
  var clipAt = Date.distantPast
  var usedCount = NSPasteboard.general.changeCount
  var shownCount = -1
  static let freshFor: TimeInterval = 120

  init(token: String?) {
    pageURL = URL(string: "/bar", relativeTo: targetURL)!.absoluteURL
    panel = BarPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                     styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                     backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    let cfg = WKWebViewConfiguration()
    if let t = token, let json = try? JSONSerialization.data(withJSONObject: [t]), let lit = String(data: json, encoding: .utf8) {
      cfg.userContentController.addUserScript(WKUserScript(source: "window.__MC_TOKEN__ = \(lit)[0];", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
    super.init()
    cfg.userContentController.add(self, name: "mcbar")
    view.setValue(false, forKey: "drawsBackground")
    view.autoresizingMask = [.width, .height]
    view.uiDelegate = ui
    view.navigationDelegate = self
    panel.contentView = view
    // Every Accessibility read below happens while he waits for the panel: a hung app answers in a
    // quarter second or not at all, instead of the default six.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
    panel.delegate = self
    load()
    let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      let c = NSPasteboard.general.changeCount
      if c != self.clipCount { self.clipCount = c; self.clipAt = Date() }
    }
    RunLoop.main.add(t, forMode: .common)
  }

  func load() { view.load(URLRequest(url: pageURL)) }
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    loaded = true
    if let p = pending { pending = nil; deliver(p) }
  }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { loaded = false }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { loaded = false }

  // The page's hand on the panel.
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any], let type = d["type"] as? String else { return }
    switch type {
    case "close": hide()
    case "size":
      if let h = d["height"] as? Double { height = max(56, min(640, CGFloat(h))); place(keepTop: true) }
    case "used": usedCount = shownCount
    case "openDesk":
      if let u = d["url"] as? String, let url = URL(string: u, relativeTo: targetURL)?.absoluteURL {
        web.evaluateJavaScript("location.href = \(jsString(url.absoluteString)); void 0;") { _, _ in }
      }
      showDesk()
    default: break
    }
  }

  func windowDidResignKey(_ n: Notification) { hide() }

  func hide() {
    guard panel.isVisible else { return }
    view.evaluateJavaScript("window.barHidden && window.barHidden(); void 0;") { _, _ in }
    panel.orderOut(nil)
  }

  // Top-centre of the screen the mouse is on, like Spotlight; grows downward as the answer streams.
  func place(keepTop: Bool) {
    let mouse = NSEvent.mouseLocation
    let screen = (keepTop && panel.isVisible ? panel.screen : nil)
      ?? NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main
    guard let vf = screen?.visibleFrame else { return }
    let top = keepTop && panel.isVisible ? panel.frame.maxY : vf.maxY - vf.height * 0.2
    panel.setFrame(NSRect(x: vf.midX - width / 2, y: top - height, width: width, height: height), display: true)
  }

  // The hotkey: up → talk; down → open with what is in front and what was just copied.
  func hotkey() {
    if panel.isVisible { view.evaluateJavaScript("window.barVoice && window.barVoice(); void 0;") { _, _ in }; return }
    var payload: [String: Any] = ["ctx": frontContext()]
    if let clip = freshClipboard() { merge(&payload, clip) }
    show(payload)
  }

  func show(_ payload: [String: Any]) {
    place(keepTop: false)
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(view)
    if loaded { deliver(payload) } else { pending = payload; load() }
  }

  // A page that loaded while the daemon was still booting can be its error page, with no barOpen in
  // it: load the real one and hand the payload over once it is up.
  func deliver(_ payload: [String: Any]) {
    guard let json = try? JSONSerialization.data(withJSONObject: payload),
          let lit = String(data: json, encoding: .utf8) else { return }
    view.evaluateJavaScript("typeof window.barOpen === 'function' ? (window.barOpen(\(lit)), 'ok') : 'missing'") { [weak self] r, _ in
      guard let self = self, (r as? String) != "ok" else { return }
      self.loaded = false
      self.pending = payload
      self.load()
    }
  }

  // What is in front: the app, its window's title, a browser's address. The title and the address
  // come through Accessibility; without that grant the capture still works, it just routes by its
  // own link (or asks). macOS asks for the grant once, the first time the hotkey is used.
  func frontContext() -> [String: Any] {
    var ctx: [String: Any] = [:]
    guard let front = NSWorkspace.shared.frontmostApplication,
          front.bundleIdentifier != Bundle.main.bundleIdentifier else { return ctx }
    ctx["app"] = front.localizedName ?? ""
    ctx["bundle"] = front.bundleIdentifier ?? ""
    guard axTrusted() else { return ctx }
    let el = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 0.25)
    guard let win = axAttr(el, kAXFocusedWindowAttribute) else { return ctx }
    let w = win as! AXUIElement
    if let t = axAttr(w, kAXTitleAttribute) as? String, !t.isEmpty { ctx["title"] = String(t.prefix(1000)) }
    if Bar.browsers.contains(front.bundleIdentifier ?? ""), let u = addressBar(w) { ctx["browser_url"] = u }
    return ctx
  }

  static let browsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "app.zen-browser.zen",
    "org.mozilla.firefox", "com.apple.Safari", "com.brave.Browser", "company.thebrowser.Browser", "com.microsoft.edgemac",
  ]

  // Never asks from here: a permission dialog over the panel takes its focus and the panel closes on
  // the spot — which is exactly how the first ⌘⇧Space ever pressed looked like "nothing happens".
  // The ask happens once at launch instead (see the triggers at the bottom of this file).
  func axTrusted() -> Bool { AXIsProcessTrusted() }

  func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success ? out : nil
  }

  // The browser's own address field, found in its window chrome — never inside the page (an
  // AXWebArea is skipped: walking a page's tree is slow and can wake the browser's accessibility mode).
  func addressBar(_ win: AXUIElement) -> String? {
    var queue: [(AXUIElement, Int)] = [(win, 0)]
    var seen = 0
    let looksLikeURL = try! NSRegularExpression(pattern: "^(https?://)?[\\w-]+(\\.[\\w-]+)+(:\\d+)?(/\\S*)?$", options: [.caseInsensitive])
    while !queue.isEmpty && seen < 200 {
      let (el, depth) = queue.removeFirst()
      seen += 1
      let role = axAttr(el, kAXRoleAttribute) as? String ?? ""
      if role == "AXWebArea" { continue }
      if role == kAXTextFieldRole || role == kAXComboBoxRole,
         let v = axAttr(el, kAXValueAttribute) as? String {
        let s = v.trimmingCharacters(in: .whitespaces)
        if !s.isEmpty, s.count < 4000, looksLikeURL.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil { return s }
      }
      if depth < 7, let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for k in kids { queue.append((k, depth + 1)) }
      }
    }
    return nil
  }

  // A recent copy: text (a link is also the capture's url), else an image or a file. Password
  // managers mark what they copy (nspasteboard.org's Concealed/Transient types): never that.
  func freshClipboard() -> [String: Any]? {
    let pb = NSPasteboard.general
    // Copied a moment ago, before the poll saw it: that is the freshest copy there is.
    if pb.changeCount != clipCount { clipCount = pb.changeCount; clipAt = Date() }
    guard clipCount != usedCount,
          Date().timeIntervalSince(clipAt) < Bar.freshFor else { return nil }
    let types = (pb.types ?? []).map { $0.rawValue }
    if types.contains("org.nspasteboard.ConcealedType") || types.contains("org.nspasteboard.TransientType") { return nil }
    shownCount = clipCount
    if let s = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
      var ctx: [String: Any] = ["text": String(s.prefix(100_000))]
      if !s.contains(where: { $0.isWhitespace }), let u = URL(string: s), u.scheme == "https" || u.scheme == "http" { ctx["url"] = s }
      return ["ctx": ctx]
    }
    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
       let f = urls.first, let file = Bar.fileBlob(f) { return ["file": file] }
    if let data = pb.data(forType: .png) ?? pb.data(forType: .tiff).flatMap({ NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }) {
      return ["file": ["name": "clipboard.png", "mime": "image/png", "b64": data.base64EncodedString()]]
    }
    return nil
  }

  func merge(_ payload: inout [String: Any], _ extra: [String: Any]) {
    var ctx = payload["ctx"] as? [String: Any] ?? [:]
    for (k, v) in extra["ctx"] as? [String: Any] ?? [:] { ctx[k] = v }
    payload["ctx"] = ctx
    if let f = extra["file"] { payload["file"] = f }
  }

  // A file handed to the panel (Services, Shot): images, PDFs and text only, 25MB at most.
  static let fileTypes: [String: String] = [
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "heic": "image/heic", "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "csv": "text/csv",
  ]
  static func fileBlob(_ url: URL) -> [String: Any]? {
    let f = url.resolvingSymlinksInPath()
    guard let mime = fileTypes[f.pathExtension.lowercased()],
          let size = (try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > 0, size <= 25 * 1024 * 1024,
          let data = try? Data(contentsOf: f) else { return nil }
    return ["name": f.lastPathComponent, "mime": mime, "b64": data.base64EncodedString()]
  }

  // Services → Send to Chronos: the selection itself, from the app that is in front.
  func service(_ pb: NSPasteboard) {
    var payload: [String: Any] = ["ctx": frontContext()]
    if let s = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
      var ctx: [String: Any] = ["text": String(s.prefix(100_000))]
      if !s.contains(where: { $0.isWhitespace }), let u = URL(string: s), u.scheme == "https" || u.scheme == "http" { ctx["url"] = s }
      merge(&payload, ["ctx": ctx])
    } else if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], let u = urls.first {
      if u.isFileURL, let f = Bar.fileBlob(u) { payload["file"] = f } else if !u.isFileURL { merge(&payload, ["ctx": ["url": u.absoluteString, "text": u.absoluteString]]) }
    }
    show(payload)
  }

  // chronos://capture?text=…&url=…&file=… — any app on this Mac (and any web page, which is why it
  // only fills the panel in). A file must be an image/PDF/text under Pictures, Desktop or Downloads.
  func open(url: URL) {
    guard url.scheme == "chronos", url.host == "capture" else { return }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let get = { (n: String) in items.first(where: { $0.name == n })?.value }
    var payload: [String: Any] = ["ctx": frontContext()]
    var ctx: [String: Any] = [:]
    if let t = get("text"), !t.isEmpty { ctx["text"] = String(t.prefix(100_000)) }
    if let u = get("url"), !u.isEmpty { ctx["url"] = String(u.prefix(4000)) }
    if let a = get("app"), !a.isEmpty { ctx["app"] = String(a.prefix(120)) }
    merge(&payload, ["ctx": ctx])
    if let p = get("file") {
      let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
      let f = URL(fileURLWithPath: p).resolvingSymlinksInPath()
      let ok = ["Pictures", "Desktop", "Downloads"].contains { f.path.hasPrefix(home + "/" + $0 + "/") }
      if ok, let blob = Bar.fileBlob(f) { payload["file"] = blob }
    }
    show(payload)
  }
}
let bar = Bar(token: adminToken())

final class Services: NSObject {
  // Read the services pasteboard inside the call: it is only promised for its duration.
  @objc func sendToChronos(_ pb: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
    bar.service(pb)
  }
}
let services = Services()
app.servicesProvider = services
NSUpdateDynamicServices()

final class URLHandler: NSObject {
  @objc func handle(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let u = URL(string: s) else { return }
    DispatchQueue.main.async { bar.open(url: u) }
  }
}
let urlHandler = URLHandler()
NSAppleEventManager.shared().setEventHandler(urlHandler, andSelector: #selector(URLHandler.handle(_:reply:)),
                                             forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))

// What opens the bar: a comma-separated list in `barHotkey` (or MC_BAR_HOTKEY), default
// "rcmd, opt+shift+space":
//   · a combination — "opt+shift+space", "ctrl+opt+k" — is a Carbon RegisterEventHotKey: no permission
//     needed, but the first app to register a combination owns it, silently (⌘⇧Space is 1Password's);
//   · "rcmd" / "ropt" — a TAP of the right ⌘ / ⌥ on its own: pressed and released within 350ms with no
//     other key, click or modifier in between, so ⌘C typed with the right hand never opens anything.
//     It is read from a global event monitor, which macOS only feeds once Chronos has Accessibility.
func parseHotkey(_ spec: String) -> (UInt32, UInt32)? {
  let parts = spec.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
  guard let key = parts.last, parts.count >= 2 else { return nil }
  var mods: UInt32 = 0
  for m in parts.dropLast() {
    switch m {
    case "cmd", "command": mods |= UInt32(cmdKey)
    case "shift": mods |= UInt32(shiftKey)
    case "opt", "option", "alt": mods |= UInt32(optionKey)
    case "ctrl", "control": mods |= UInt32(controlKey)
    default: return nil
    }
  }
  let named: [String: Int] = ["space": kVK_Space, "return": kVK_Return, "slash": kVK_ANSI_Slash, "period": kVK_ANSI_Period]
  let letters: [Character: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
    "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
    "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
    "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
    "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
    "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
  ]
  let code = named[key] ?? (key.count == 1 ? letters[key.first!] : nil)
  guard let c = code, mods != 0 else { return nil }
  return (UInt32(c), mods)
}

/// A tap of one modifier key on its own. Fed every flagsChanged / keyDown / mouse-down this app sees.
final class ModifierTap {
  let keyCode: UInt16
  let flag: NSEvent.ModifierFlags
  let fire: () -> Void
  var downAt: TimeInterval?
  var clean = false
  init(keyCode: Int, flag: NSEvent.ModifierFlags, fire: @escaping () -> Void) {
    self.keyCode = UInt16(keyCode); self.flag = flag; self.fire = fire
  }
  func handle(_ e: NSEvent) {
    guard e.type == .flagsChanged else { clean = false; return }
    let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function, .help])
    guard e.keyCode == keyCode else { clean = false; return }
    if mods.contains(flag) {
      clean = mods == flag // the only modifier down
      downAt = e.timestamp
    } else if let d = downAt {
      if clean && e.timestamp - d < 0.35 { fire() }
      downAt = nil
      clean = false
    }
  }
}

var barHotKeyRef: EventHotKeyRef?
var barTaps: [ModifierTap] = []
var barMonitors: [Any] = []
let hotkeySpec = ProcessInfo.processInfo.environment["MC_BAR_HOTKEY"]
  ?? UserDefaults.standard.string(forKey: "barHotkey") ?? "rcmd, opt+shift+space"
func barLog(_ s: String) { FileHandle.standardError.write(("[mc-app] " + s + "\n").data(using: .utf8)!) }

for item in hotkeySpec.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) where !item.isEmpty && item != "off" {
  switch item {
  case "rcmd": barTaps.append(ModifierTap(keyCode: kVK_RightCommand, flag: .command) { bar.hotkey() })
  case "ropt": barTaps.append(ModifierTap(keyCode: kVK_RightOption, flag: .option) { bar.hotkey() })
  default:
    guard barHotKeyRef == nil else { barLog("bar hotkey \"\(item)\" ignored — one combination at a time"); continue }
    guard let (code, mods) = parseHotkey(item) else { barLog("bar hotkey \"\(item)\" not understood — e.g. rcmd, opt+shift+space"); continue }
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      DispatchQueue.main.async { bar.hotkey() }
      return noErr
    }, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x4D434252), id: 1) // 'MCBR'
    let st = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &barHotKeyRef)
    if st != noErr { barLog("bar hotkey \(item) not registered (\(st))") }
  }
}

// A tap is read from event monitors: the global one sees every other app (only with Accessibility),
// the local one this app's own windows — the Desk and the panel itself, where the tap means "talk".
if !barTaps.isEmpty {
  let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]
  let feed = { (e: NSEvent) in for t in barTaps { t.handle(e) } }
  if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: feed) { barMonitors.append(g) }
  if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { feed($0); return $0 }) { barMonitors.append(l) }
  // Without Accessibility the global monitor gets nothing: ask once per launch — here, never over the
  // panel — and say so in the log. A grant given later reaches the running monitor; if it does not,
  // `launchctl kickstart -k gui/$(id -u)/sh.chronos.app` re-arms it.
  if !AXIsProcessTrusted() {
    barLog("the right-⌘ tap needs Accessibility for Chronos (System Settings → Privacy & Security → Accessibility)")
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(opts)
    }
  }
}

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
