// Chronos host menu bar item — "is this Mac working, and on what?" at a glance (HOSTS.md → Menu bar).
//
// Build & install (what `getchronos host menubar install` does):
//   xcrun swiftc -O desktop/hostbar.swift -o ~/.chronos-host/bin/chronos-hostbar
//   + a LaunchAgent (launchd/sh.chronos.hostbar.plist.template) so it starts at login.
//
// It reads ONE thing: the host process's own loopback status, GET http://127.0.0.1:<port>/__host/status,
// every 3 seconds. No token, no brain, no network beyond loopback — if the host is down the item says
// so and keeps polling. The status holds no workspace names by design (status.ts); neither does this.
//
// The title is the Chronos mark — the hourglass from site/assets/favicon.svg, drawn natively (no SVG at
// runtime) — plus the number of agents producing output right now:
//   working      slate glass, sand in both bulbs and running, in amber (#E8A33D, the brand's only
//                accent) — a colour image — plus the count;
//   idle         a monochrome template hourglass, its sand settled in the bottom bulb, no number;
//   link down    the idle hourglass with a small warning badge; the count stays (agents keep running
//                while the link is down), the reason in the tooltip;
//   host down    an empty outline hourglass, dimmed, and "–".
// Everything else is in the menu. Two flags check the build without a menu bar: `--render <dir>` writes
// each look as PNG (1x and 2x, light and dark), `--print` polls once and prints what it would show.

import Cocoa

let POLL_SECONDS = 3.0

// ───────────── the status the host serves (a subset; unknown keys are ignored) ─────────────

struct Work: Decodable {
  let kind: String
  let id: String
  let repo: String?
  let backend: String
  let started_at: Double
  let last_output_at: Double
  let active: Bool
}

struct Status: Decodable {
  let host_id: String
  let name: String?
  let link: String?
  let reason: String?
  let since: Double?
  let work: [Work]?
  let active: Int?
  // A host from before the menu bar only sends `state`; map it the way status.ts linkView does.
  let state: String?

  var linkView: String {
    if let l = link { return l }
    switch state ?? "" {
    case "online": return "online"
    case "connecting", "offline": return "reconnecting"
    default: return "offline"
    }
  }
}

// ───────────── where the host is (mirror of status.ts mcPortCandidates / secretsPort) ─────────────

let hostHome: String = {
  if let h = ProcessInfo.processInfo.environment["CHRONOS_HOST_HOME"], !h.isEmpty { return h }
  return (NSHomeDirectory() as NSString).appendingPathComponent(".chronos-host")
}()

/// An explicit CHRONOS_HOST_MC_PORT in the host's .secrets is the only port; else 7777, then 7787–7796.
/// Only that one key is read from the file — the rest of it is the host's credential and stays unread.
func candidatePorts() -> [Int] {
  let file = (hostHome as NSString).appendingPathComponent(".secrets")
  if let text = try? String(contentsOfFile: file, encoding: .utf8) {
    for raw in text.split(separator: "\n") {
      var line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("export ") { line = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
      guard line.hasPrefix("CHRONOS_HOST_MC_PORT") else { continue }
      let value = line.split(separator: "=", maxSplits: 1).dropFirst().first ?? ""
      let digits = value.trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
      if let p = Int(digits), p > 0, p < 65536 { return [p] }
    }
  }
  return [7777] + Array(7787...7796)
}

// ───────────── polling ─────────────

final class Poller {
  private let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 1.5
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.connectionProxyDictionary = [:] // loopback, never through a system proxy
    return URLSession(configuration: c)
  }()
  private var port: Int?
  private var busy = false
  /// nil = the host process is not answering on any candidate port.
  private(set) var status: Status?
  var onChange: () -> Void = {}

  func tick() {
    if busy { return }
    busy = true
    let ports = port.map { [$0] } ?? candidatePorts()
    probe(ports, 0) { [weak self] found, s in
      guard let self = self else { return }
      if found == nil && self.port != nil {
        // The port we knew stopped answering (a host restart may have bound another): rescan now.
        self.port = nil
        self.probe(candidatePorts(), 0) { p, s2 in self.finish(p, s2) }
      } else {
        self.finish(found, s)
      }
    }
  }

  private func finish(_ p: Int?, _ s: Status?) {
    port = p
    status = s
    busy = false
    onChange()
  }

  /// First port whose /__host/status decodes AND names a host: a Chronos daemon on 7777 answers too.
  private func probe(_ ports: [Int], _ i: Int, _ done: @escaping (Int?, Status?) -> Void) {
    guard i < ports.count, let url = URL(string: "http://127.0.0.1:\(ports[i])/__host/status") else {
      return DispatchQueue.main.async { done(nil, nil) }
    }
    session.dataTask(with: url) { data, resp, _ in
      if let data = data, (resp as? HTTPURLResponse)?.statusCode == 200,
         let s = try? JSONDecoder().decode(Status.self, from: data), !s.host_id.isEmpty {
        return DispatchQueue.main.async { done(ports[i], s) }
      }
      self.probe(ports, i + 1, done)
    }.resume()
  }
}

// ───────────── the mark ─────────────

/// Brand inks (site/mascot/README.md). Slate reads on both light and dark menu bars; amber is only sand.
let SLATE = NSColor(srgbRed: 0x8D / 255.0, green: 0x97 / 255.0, blue: 0xAC / 255.0, alpha: 1)
let AMBER = NSColor(srgbRed: 0xE8 / 255.0, green: 0xA3 / 255.0, blue: 0x3D / 255.0, alpha: 1)

enum Look { case working, idle, alert, down }

/// The favicon's hourglass (64-unit grid, content x 6…58, y 7…68) scaled to the menu bar. Strokes are
/// set in points, not scaled: 2.4 units would be 0.6pt here and vanish at 1x.
func hourglass(_ look: Look, height h: CGFloat = 16) -> NSImage {
  let s = h / 61.0
  let markW = (52 * s).rounded(.up)
  let size = NSSize(width: markW + (look == .alert ? 4 : 0), height: h)
  let img = NSImage(size: size, flipped: true) { _ in
    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: (x - 6) * s, y: (y - 7) * s) }
    let top = NSBezierPath()
    top.move(to: p(11, 15))
    top.curve(to: p(32, 37), controlPoint1: p(10, 27), controlPoint2: p(27, 31))
    top.curve(to: p(53, 15), controlPoint1: p(37, 31), controlPoint2: p(54, 27))
    top.close()
    let bottom = NSBezierPath()
    bottom.move(to: p(32, 39))
    bottom.curve(to: p(11, 61), controlPoint1: p(27, 45), controlPoint2: p(10, 49))
    bottom.line(to: p(53, 61))
    bottom.curve(to: p(32, 39), controlPoint1: p(54, 49), controlPoint2: p(37, 45))
    bottom.close()
    let ink: NSColor = look == .working ? SLATE : .black // black = the template's ink
    let sand: NSColor = look == .working ? AMBER : .black
    // Sand first, clipped to each bulb (the favicon's #sand group), then the glass over it. Working: sand
    // in both bulbs, running. Idle / link down: all of it settled in the bottom bulb — nothing is flowing.
    // Host down: no sand at all (the 404 pose: both bulbs empty).
    let piles: [(NSBezierPath, Double, Double)] = look == .working ? [(top, 22, 40), (bottom, 50, 68)] : look == .down ? [] : [(bottom, 45, 68)]
    for (bulb, y0, y1) in piles {
      NSGraphicsContext.saveGraphicsState()
      bulb.addClip()
      sand.setFill()
      NSRect(x: 0, y: p(0, CGFloat(y0)).y, width: markW, height: CGFloat(y1 - y0) * s).fill()
      NSGraphicsContext.restoreGraphicsState()
    }
    if look == .working {
      // The stream: sand is running. Only while something is actually working.
      sand.setFill()
      let c = p(32, 0).x
      NSRect(x: c - 0.4, y: p(0, 36).y, width: 0.8, height: 14 * s).fill()
    }
    ink.setStroke()
    for bulb in [top, bottom] { bulb.lineWidth = 1.1; bulb.stroke() }
    ink.setFill()
    for y in [7.0, 59.0] {
      NSBezierPath(roundedRect: NSRect(origin: p(6, CGFloat(y)), size: NSSize(width: 52 * s, height: 9 * s)), xRadius: 4.5 * s, yRadius: 4.5 * s).fill()
    }
    if look == .alert {
      // Warning badge, bottom right: a triangle with a knocked-out "!", cut clear of the glass by a halo.
      let bw: CGFloat = 8.5, bh: CGFloat = 7.5
      let x0 = size.width - bw, y0 = h - bh
      let tri = NSBezierPath()
      tri.move(to: NSPoint(x: x0 + bw / 2, y: y0))
      tri.line(to: NSPoint(x: x0 + bw, y: y0 + bh))
      tri.line(to: NSPoint(x: x0, y: y0 + bh))
      tri.close()
      tri.lineJoinStyle = .round
      let ctx = NSGraphicsContext.current
      ctx?.compositingOperation = .clear
      tri.lineWidth = 2.4
      tri.stroke()
      tri.fill()
      ctx?.compositingOperation = .sourceOver
      NSColor.black.setFill()
      tri.fill()
      ctx?.compositingOperation = .clear
      let cx = x0 + bw / 2
      NSRect(x: cx - 0.55, y: y0 + 2.3, width: 1.1, height: 2.6).fill()
      NSRect(x: cx - 0.55, y: y0 + 5.6, width: 1.1, height: 1.1).fill()
      ctx?.compositingOperation = .sourceOver
    }
    return true
  }
  // Template everywhere but "working": macOS then inks it for light/dark bars and highlight itself.
  img.isTemplate = look != .working
  img.accessibilityDescription = "Chronos host"
  return img
}

// ───────────── the item ─────────────

func ago(_ ms: Double) -> String {
  let s = max(0, Int(Date().timeIntervalSince1970 - ms / 1000))
  if s < 60 { return "<1m" }
  if s < 3600 { return "\(s / 60)m" }
  if s < 86400 { return s % 3600 >= 60 ? "\(s / 3600)h \(s % 3600 / 60)m" : "\(s / 3600)h" }
  return "\(s / 86400)d"
}

func linkWord(_ l: String) -> String {
  switch l {
  case "online": return "connected"
  case "reconnecting": return "reconnecting"
  default: return "offline"
  }
}

/// What the title shows for a status (nil = the host process is not answering). Pure: `--print` uses it too.
func titleView(_ s: Status?) -> (look: Look, title: String, tooltip: String, dim: Bool) {
  guard let s = s else { return (.down, " –", "Chronos host is not running on this Mac", true) }
  let active = s.active ?? (s.work ?? []).filter { $0.active }.count
  let running = (s.work ?? []).count
  let name = s.name ?? "host"
  let count = active > 0 ? " \(active)" : ""
  if s.linkView != "online" {
    return (.alert, count, "\(name) · \(linkWord(s.linkView))" + (s.reason.map { " — \($0)" } ?? ""), false)
  }
  let tip = running == 0 ? "\(name) · connected · nothing running" : "\(name) · connected · \(active) working of \(running)"
  return (active > 0 ? .working : .idle, count, tip, false)
}

enum Row { case header(String), note(String), separator, work(String, String) }

/// The menu's rows above "Open host log" / "Quit". Pure, like titleView.
func menuRows(_ s: Status?) -> [Row] {
  guard let s = s else {
    let ports = candidatePorts()
    let where_ = ports.count == 1 ? "127.0.0.1:\(ports[0])" : "127.0.0.1:7777 or 7787–7796"
    return [.header("Chronos host · not running"), .note("Nothing answers on \(where_)")]
  }
  var header = "\(s.name ?? "host") · \(linkWord(s.linkView))"
  if s.linkView != "online", let since = s.since { header += " · \(ago(since))" }
  var rows: [Row] = [.header(header)]
  if s.linkView != "online", let r = s.reason { rows.append(.note(r)) }
  rows.append(.separator)
  let work = s.work ?? []
  if work.isEmpty { rows.append(.header("Nothing running")) }
  for w in work {
    // "● app — claude-code · 12m": filled = producing output right now, hollow = idle.
    rows.append(.work("\(w.active ? "●" : "○")  \(w.repo ?? "~") — \(w.backend) · \(ago(w.started_at))",
                      "\(w.kind) \(w.id) · last output \(ago(w.last_output_at)) ago"))
  }
  return rows
}

final class Bar: NSObject, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let poller = Poller()
  let menu = NSMenu()

  override init() {
    super.init()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    if let b = item.button {
      b.imagePosition = .imageLeading
      // Fixed-width digits: the item must not shift the menu bar as the count changes.
      b.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    }
    poller.onChange = { [weak self] in self?.render() }
    render()
    poller.tick()
    let t = Timer(timeInterval: POLL_SECONDS, repeats: true) { [weak self] _ in self?.poller.tick() }
    t.tolerance = 0.5
    RunLoop.main.add(t, forMode: .common) // keep updating while the menu is open
  }

  func render() {
    guard let b = item.button else { return }
    let v = titleView(poller.status)
    b.image = hourglass(v.look)
    b.title = v.title
    b.appearsDisabled = v.dim
    b.toolTip = v.tooltip
  }

  // Rebuilt every time it opens, from the last poll (at most 3s old).
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    for r in menuRows(poller.status) {
      switch r {
      case .header(let t): menu.addItem(label(t))
      case .note(let t): menu.addItem(label(t, small: true))
      case .separator: menu.addItem(.separator())
      case .work(let t, let tip):
        // Enabled with no action: reads at full contrast (a disabled row is greyed), does nothing.
        let mi = NSMenuItem(title: t, action: nil, keyEquivalent: "")
        mi.toolTip = tip
        menu.addItem(mi)
      }
    }
    tail(menu)
  }

  func label(_ text: String, small: Bool = false) -> NSMenuItem {
    let mi = NSMenuItem(title: text, action: nil, keyEquivalent: "")
    mi.isEnabled = false
    if small {
      mi.attributedTitle = NSAttributedString(string: text, attributes: [
        .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
        .foregroundColor: NSColor.secondaryLabelColor,
      ])
    }
    return mi
  }

  func tail(_ menu: NSMenu) {
    menu.addItem(.separator())
    let log = NSMenuItem(title: "Open host log", action: #selector(openLog), keyEquivalent: "")
    log.target = self
    menu.addItem(log)
    let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
  }

  @objc func openLog() {
    let path = (hostHome as NSString).appendingPathComponent("host.out.log")
    // Console follows the file as it grows; TextEdit is the fallback when Console is not there.
    for args in [["-a", "Console", path], ["-e", path]] {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      p.arguments = args
      if (try? p.run()) != nil {
        p.waitUntilExit()
        if p.terminationStatus == 0 { return }
      }
    }
  }

  // Exit 0: the LaunchAgent restarts the item only after a crash, so Quit means quit until next login.
  @objc func quit() { NSApp.terminate(nil) }
}

/// `--render <dir>`: every look as PNG at 1x and 2x, on a light and a dark menu bar. A template image is
/// inked the way the menu bar does it (black on light, white on dark), so the files show what a person sees.
func renderPreviews(to dir: String) -> Int32 {
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  let looks: [(String, Look)] = [("working", .working), ("idle", .idle), ("alert", .alert), ("down", .down)]
  for (name, look) in looks {
    for (bar, bg, fg) in [("light", NSColor(white: 0.93, alpha: 1), NSColor.black), ("dark", NSColor(white: 0.16, alpha: 1), NSColor.white)] {
      for scale in [1, 2] {
        let img = hourglass(look)
        let px = NSSize(width: (img.size.width + 8) * CGFloat(scale), height: 22 * CGFloat(scale))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(px.width), pixelsHigh: Int(px.height), bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return 1 }
        rep.size = NSSize(width: px.width / CGFloat(scale), height: 22)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        bg.setFill()
        NSRect(origin: .zero, size: rep.size).fill()
        let r = NSRect(x: 4, y: 3, width: img.size.width, height: img.size.height)
        if img.isTemplate {
          // What the menu bar does with a template: its alpha, filled with the bar's ink.
          let tinted = NSImage(size: img.size, flipped: false) { rect in
            img.draw(in: rect)
            fg.set()
            rect.fill(using: .sourceIn)
            return true
          }
          tinted.draw(in: r, from: .zero, operation: .sourceOver, fraction: look == .down ? 0.45 : 1)
        } else {
          img.draw(in: r)
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return 1 }
        let file = (dir as NSString).appendingPathComponent("\(name)-\(bar)@\(scale)x.png")
        do { try png.write(to: URL(fileURLWithPath: file)) } catch { return 1 }
      }
    }
  }
  return 0
}

/// `--print`: one poll, then what the item would show, as text — the title, its tooltip, the menu rows.
/// How tests check the Swift side reads the status the TypeScript side serves.
func printOnce() -> Int32 {
  let poller = Poller()
  var done = false
  poller.onChange = { done = true }
  poller.tick()
  let deadline = Date().addingTimeInterval(20)
  while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
  let v = titleView(poller.status)
  print("title: \(v.look)\(v.title)\(v.dim ? " (dimmed)" : "")")
  print("tooltip: \(v.tooltip)")
  for r in menuRows(poller.status) {
    switch r {
    case .header(let t): print(t)
    case .note(let t): print("  \(t)")
    case .separator: print("---")
    case .work(let t, _): print(t)
    }
  }
  return 0
}

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "--render" { exit(renderPreviews(to: args[2])) }
if args.count >= 2 && args[1] == "--print" { exit(printOnce()) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no app menu
let bar = Bar()
app.run()
