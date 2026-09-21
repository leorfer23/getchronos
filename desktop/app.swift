// Mission UI window — the overlay's big sibling: a normal, resizable app window over the daemon's
// /app page (Chat / Tickets / Board / Fleet). Unlike the always-on-top ventanita this behaves like
// a real app: Dock icon, ⌘-tab, Edit menu so the chat composer gets copy/paste.
//
// Build & run:
//   swiftc -O desktop/app.swift -o ~/.mc/bin/mc-app && mc-app &
//
// Token: same rule as overlay.swift — this process runs unsandboxed as the operator, reads
// ~/chronos/.admin-token itself and injects window.__MC_TOKEN__; the daemon never templates the
// token into HTML (sandboxed job agents keep loopback network and could read it back out).

import Cocoa
import WebKit
import UserNotifications

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

// Same read as overlay.swift: env override, else ~/chronos/.admin-token, once at launch.
func adminToken() -> String? {
  if let env = ProcessInfo.processInfo.environment["CHRONOS_ADMIN_TOKEN"], !env.isEmpty { return env }
  let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("chronos/.admin-token")
  guard let raw = try? String(contentsOf: file, encoding: .utf8) else { return nil }
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
// Which page this window hosts: default /app, a path (`mc-app /desk` → the terminal wall), or a full
// URL (`mc-app http://localhost:7788/desk` → a dev daemon on another port). Token injection is the
// same either way, which is what lets /desk attach to /term at all.
let arg = CommandLine.arguments.dropFirst().first(where: { $0.hasPrefix("/") || $0.hasPrefix("http") })
let target = arg.map { $0.hasPrefix("http") ? $0 : "http://localhost:7777" + $0 } ?? "http://localhost:7777/app"
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

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
