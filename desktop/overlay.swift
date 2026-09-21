// Floating ticket overlay — a small always-on-top panel over the daemon's /overlay.html page.
//
// Build & run:
//   swiftc -O desktop/overlay.swift -o ~/.mc/bin/mc-overlay && mc-overlay &
//
// Drag by the title bar strip; close button hides it. Position/size persist across launches.

import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar takeover

let panel = NSPanel(
  contentRect: NSRect(x: 0, y: 0, width: 380, height: 520),
  styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel, .utilityWindow],
  backing: .buffered, defer: false
)
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.titleVisibility = .hidden
panel.titlebarAppearsTransparent = true
panel.isMovableByWindowBackground = true
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hidesOnDeactivate = false
panel.isReleasedWhenClosed = false
panel.setFrameAutosaveName("mc-ticket-overlay")

// target=_blank links (PR / external ticket URLs) → default browser; WKWebView drops them otherwise.
class UI: NSObject, WKUIDelegate {
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }
}
let ui = UI()

// Admin token: the OVERLAY reads it, not the daemon.
//
// The daemon used to template the token into /overlay.html for any loopback caller, but sandboxed
// job agents keep loopback network (they need it for `mc` and the egress proxy), so any of them
// could `curl localhost:7777/overlay.html` and read the token straight back out — defeating the
// sandbox deny on ~/chronos/.admin-token that is supposed to keep it from them. This process runs
// UNSANDBOXED as the operator and can just read the file, so it hands the token to the page itself.
//
// Read once at launch, same as the daemon's own CONFIG.adminToken: a rotated token needs both
// restarted, which is already true today.
func adminToken() -> String? {
  if let env = ProcessInfo.processInfo.environment["CHRONOS_ADMIN_TOKEN"], !env.isEmpty { return env }
  let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("chronos/.admin-token")
  guard let raw = try? String(contentsOf: file, encoding: .utf8) else { return nil }
  let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  return token.isEmpty ? nil : token
}

let config = WKWebViewConfiguration()
// JSON-encode the token rather than interpolating it into JS — a token with a quote in it would
// otherwise break out of the string literal. JSONSerialization needs a container at the top level,
// hence the one-element array + [0].
if let token = adminToken(),
   let json = try? JSONSerialization.data(withJSONObject: [token]),
   let literal = String(data: json, encoding: .utf8) {
  config.userContentController.addUserScript(WKUserScript(
    source: "window.__MC_TOKEN__ = \(literal)[0];",
    injectionTime: .atDocumentStart,   // before the page's own script reads it
    forMainFrameOnly: true))           // never hand it to an embedded frame
}

let web = WKWebView(frame: panel.contentView!.bounds, configuration: config)
web.autoresizingMask = [.width, .height]
web.uiDelegate = ui
web.setValue(false, forKey: "drawsBackground") // let the page's rounded rgba background show
web.load(URLRequest(url: URL(string: "http://localhost:7777/overlay.html")!))
panel.contentView!.addSubview(web)

panel.makeKeyAndOrderFront(nil)
app.run()
