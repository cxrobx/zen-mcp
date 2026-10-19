// zen-mcp-input: posts ONE real (OS-level, isTrusted) mouse click into Zen.
//
// The opt-in `trusted: true` path of click / click_by_uid / select_option runs this. Every
// other zen-mcp input is synthetic; see docs/limitations.md § Trusted input.
//
//   zen-mcp-input front
//       -> {"bundleId":..., "pid":...} of the frontmost app
//   zen-mcp-input click --x <css px> --y <css px> --dpr <devicePixelRatio>
//                       --expect-bundle <bundle id> [--restore-pid <pid>]
//       -> {"ok":true,...} or {"ok":false,"reason":...}; exit 0 either way, 2 on bad usage
//
// x/y are the page's screen coordinates in CSS px (mozInnerScreenX + clientX). macOS events
// are in points: points = css * dpr / backingScale of the screen the point is on.
//
// Safety, checked immediately before posting, refusing on any miss:
//   - the frontmost app is --expect-bundle
//   - the topmost on-screen window under the point belongs to that app
// The cursor is put back where it was afterwards, and --restore-pid re-activates the app
// that was in front before zen-mcp brought Zen forward.
//
// Accessibility: TCC attributes an event poster to its "responsible" process, which for a
// child of node would be node (or the terminal). The helper re-spawns itself with
// responsibility disclaimed, so the grant is to THIS binary and nothing broader.

import AppKit
import ApplicationServices
import Foundation

func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func refuse(_ reason: String, _ extra: [String: Any] = [:]) -> Never {
    var o: [String: Any] = ["ok": false, "reason": reason]
    for (k, v) in extra { o[k] = v }
    emit(o)
    exit(0)
}

// MARK: responsibility disclaim (posix_spawnattr private SPI, exported by libsystem)

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

func respawnDisclaimed() -> Never {
    var attr: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attr)
    _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
    let path = CommandLine.arguments[0]
    var env = ProcessInfo.processInfo.environment
    env["ZEN_MCP_INPUT_DISCLAIMED"] = "1"
    let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, path, nil, &attr, argv, envp)
    if rc != 0 { refuse("spawn failed: \(rc)") }
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status >> 8) & 0xff)
}

// MARK: args

var args: [String: String] = [:]
let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
    FileHandle.standardError.write("usage: zen-mcp-input front | click --x --y --dpr --expect-bundle [--restore-pid]\n".data(using: .utf8)!)
    exit(2)
}
var i = 1
while i < argv.count {
    let k = argv[i]
    if k.hasPrefix("--"), i + 1 < argv.count { args[String(k.dropFirst(2))] = argv[i + 1]; i += 2 } else { i += 1 }
}

func frontmost() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

if command == "front" {
    let app = frontmost()
    emit(["bundleId": app?.bundleIdentifier ?? "", "pid": Int(app?.processIdentifier ?? 0)])
    exit(0)
}

guard command == "click" else { FileHandle.standardError.write("unknown command\n".data(using: .utf8)!); exit(2) }
guard let xs = args["x"], let ys = args["y"], let x = Double(xs), let y = Double(ys),
      let dpr = Double(args["dpr"] ?? ""), dpr > 0, let expect = args["expect-bundle"] else {
    FileHandle.standardError.write("click needs --x --y --dpr --expect-bundle\n".data(using: .utf8)!)
    exit(2)
}

if ProcessInfo.processInfo.environment["ZEN_MCP_INPUT_DISCLAIMED"] != "1" { respawnDisclaimed() }

if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
    refuse("accessibility_not_granted", [
        "hint": "Grant Accessibility to \(CommandLine.arguments[0]) in System Settings > Privacy & Security > Accessibility, then retry.",
    ])
}

// CSS px -> points. Pick the screen whose (points) frame contains the converted point.
// Screen frames are bottom-left origin; CG event space is top-left of the primary screen.
let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
var point: CGPoint? = nil
for screen in NSScreen.screens {
    let s = Double(screen.backingScaleFactor)
    let p = CGPoint(x: x * dpr / s, y: y * dpr / s)
    let f = screen.frame
    let topLeft = CGRect(x: f.minX, y: primaryHeight - f.maxY, width: f.width, height: f.height)
    if topLeft.contains(p) { point = p; break }
}
guard let target = point else { refuse("point_offscreen", ["x": x, "y": y]) }

guard let front = frontmost(), front.bundleIdentifier == expect else {
    refuse("wrong_frontmost_app", ["frontmost": frontmost()?.bundleIdentifier ?? ""])
}

// Topmost window under the point must be the expected app's. Windows are listed front to back.
// Re-checked for up to ~1s: a Zen space switch or app activation briefly puts transient
// system windows (seen: a Dock window) over the screen, and they are gone a moment later.
func ownerAtPoint() -> (pid: Int, name: String, detail: String)? {
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in windows {
        guard let b = w[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: b as CFDictionary), rect.contains(target) else { continue }
        if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
        let name = w[kCGWindowOwnerName as String] as? String ?? ""
        if name == "Window Server" { continue }
        // The Dock keeps an invisible screen-sized window (layer 20) over a frontmost app;
        // clicks pass through it. The visible Dock is a strip, never a whole screen.
        if name == "Dock", NSScreen.screens.contains(where: {
            abs($0.frame.width - rect.width) < 1 && abs($0.frame.height - rect.height) < 1
        }) { continue }
        let layer = w[kCGWindowLayer as String] as? Int ?? 0
        return (w[kCGWindowOwnerPID as String] as? Int ?? -1, name,
                "layer \(layer), \(Int(rect.width))x\(Int(rect.height)) at \(Int(rect.minX)),\(Int(rect.minY))")
    }
    return nil
}
var owner = ownerAtPoint()
for _ in 0..<6 where owner?.pid != Int(front.processIdentifier) {
    usleep(200_000)
    owner = ownerAtPoint()
}
guard let o = owner, o.pid == Int(front.processIdentifier) else {
    refuse("point_covered", ["coveredBy": owner.map { "\($0.name) (\($0.detail))" } ?? "nothing"])
}
_ = o
let restore = CGEvent(source: nil)?.location
let src = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType) {
    let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: target, mouseButton: .left)!
    if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: 1) }
    e.post(tap: .cghidEventTap)
}
post(.mouseMoved)
usleep(40_000)
post(.leftMouseDown)
usleep(60_000)
post(.leftMouseUp)
usleep(60_000)
if let r = restore { CGWarpMouseCursorPosition(r) }

var restored = false
if let rp = args["restore-pid"], let pid = Int32(rp), pid > 0, pid != front.processIdentifier,
   let app = NSRunningApplication(processIdentifier: pid) {
    usleep(150_000)
    restored = app.activate()
}
emit(["ok": true, "points": ["x": target.x, "y": target.y], "restoredFocus": restored])
