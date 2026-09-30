import Foundation
import CoreGraphics
import Carbon
import Darwin

struct InputRoute: Equatable {
    let window: String
    let applicationPID: pid_t
    let pid: pid_t?
    let number: CGWindowID?
    let bounds: CGRect
}
private final class InputContext {
    let route: InputRoute
    let source = CGEventSource(stateID: .privateState)!
    let tag = Int64.random(in: 1...Int64.max)
    var keys: [CGKeyCode] = []
    var buttons: [CGMouseButton] = []
    var cursor: CGPoint
    var eventNumber = 0
    init(_ route: InputRoute) {
        self.route = route; cursor = CGPoint(x: route.bounds.midX, y: route.bounds.midY)
        source.userData = tag; source.localEventsSuppressionInterval = 0
    }
    var held: Bool { !keys.isEmpty || !buttons.isEmpty }
}
final class Input {
    static let modifiers: [String: (CGKeyCode, CGEventFlags)] = [
        "command": (55, .maskCommand), "shift": (56, .maskShift),
        "option": (58, .maskAlternate), "control": (59, .maskControl)
    ]
    static let namedKeys: [String: CGKeyCode] = [
        "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115,
        "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
    ]
    private let lockPath: String
    private let lockFD: Int32
    private var leased = false
    private var pidLocks: [pid_t: Int32] = [:]
    private var contexts: [String: InputContext] = [:]
    private var current: InputContext?
    private var foregroundWindow: String?
    private let sender: ((CGEvent, InputRoute) throws -> Void)?
    init(lockPath: String, sender: ((CGEvent, InputRoute) throws -> Void)? = nil) {
        self.lockPath = lockPath; self.sender = sender
        lockFD = Darwin.open(lockPath, O_CREAT | O_RDWR, 0o600)
    }
    deinit {
        releaseAll()
        for fd in pidLocks.values { Darwin.close(fd) }
        if lockFD >= 0 { Darwin.close(lockFD) }
    }
    var hasHeldInput: Bool { contexts.values.contains { $0.held } }
    func acquire() throws {
        if leased { return }
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            throw RuntimeError(code: "INPUT_BUSY", message: "Another CU session owns shared foreground input. No action was dispatched.")
        }
        leased = true
    }
    private func bind(_ route: InputRoute) throws {
        guard !contexts.values.contains(where: { $0.held && $0.route != route }) else {
            throw RuntimeError(code: "INPUT_SCOPE", message: "Held input cannot change its PID, window, geometry or delivery route.")
        }
        let key = "\(route.pid ?? 0):\(route.window)"
        if let c = contexts[key], c.route == route { current = c }
        else { let c = InputContext(route); contexts[key] = c; current = c }
    }
    func prepare(_ window: String, pid: pid_t, focused: () -> Bool, activate: () throws -> Void) throws {
        try acquireApplication(pid)
        try acquire()
        if foregroundWindow == window {
            guard focused() else { throw RuntimeError(code: "FOCUS_CHANGED", message: "Foreground focus changed. No further input was dispatched.") }
        } else {
            guard !hasHeldInput else { throw RuntimeError(code: "INPUT_SCOPE", message: "Cannot switch windows while input is held.") }
            try activate(); foregroundWindow = window
        }
        try bind(InputRoute(window: window, applicationPID: pid, pid: nil, number: nil, bounds: .zero))
    }
    func prepareBackground(_ window: String, pid: pid_t, number: CGWindowID, bounds: CGRect) throws {
        let route = InputRoute(window: window, applicationPID: pid, pid: pid, number: number, bounds: bounds)
        guard !contexts.values.contains(where: { $0.held && $0.route != route }) else {
            throw RuntimeError(code: "INPUT_SCOPE", message: "Held input cannot change its target or route.")
        }
        try acquireApplication(pid)
        try bind(route)
    }
    func acquireApplication(_ pid: pid_t) throws {
        if pidLocks[pid] == nil {
            let fd = Darwin.open("\(lockPath).pid-\(pid)", O_CREAT | O_RDWR, 0o600)
            guard fd >= 0 else { throw RuntimeError(code: "INPUT_BUSY", message: "Could not acquire target application's input lease.") }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                Darwin.close(fd)
                throw RuntimeError(code: "INPUT_BUSY", message: "Another CU session owns this application's directed input.")
            }
            pidLocks[pid] = fd
        }
    }
    func requireBackground() throws {
        guard !contexts.values.contains(where: { $0.route.pid == nil && $0.held }) else {
            throw RuntimeError(code: "INPUT_SCOPE", message: "Directed input cannot run inside a foreground scope.")
        }
    }
    func resumeOwned(_ window: String, directed: Bool) throws {
        guard let c = contexts.values.first(where: { $0.route.window == window && ($0.route.pid != nil) == directed && $0.held }) else {
            throw RuntimeError(code: "INPUT_SCOPE", message: "This window/route owns no held input to release.")
        }
        current = c
    }
    static func keyCode(_ name: String) throws -> CGKeyCode {
        if let m = modifiers[name] { return m.0 }
        if let code = namedKeys[name] { return code }
        if name.count == 1, let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
           let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) {
            let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
            let layout = UnsafeRawPointer(CFDataGetBytePtr(data)).assumingMemoryBound(to: UCKeyboardLayout.self)
            for code in UInt16(0)..<128 {
                var dead: UInt32 = 0, count = 0
                var chars = [UniChar](repeating: 0, count: 8)
                if UCKeyTranslate(layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &count, &chars) == noErr,
                   String(utf16CodeUnits: chars, count: count).lowercased() == name { return code }
            }
        }
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "Unsupported key \(name). Use lowercase named/layout keys or typeText for Unicode.")
    }
    private func context() throws -> InputContext {
        guard let current else { throw RuntimeError(code: "INPUT_SCOPE", message: "Input has no bound target.") }
        return current
    }
    private func flags(_ c: InputContext) -> CGEventFlags {
        Self.modifiers.values.reduce(CGEventFlags()) { value, m in c.keys.contains(m.0) ? value.union(m.1) : value }
    }
    private func post(_ event: CGEvent?, _ c: InputContext) throws {
        guard let event else { throw RuntimeError(code: "INPUT", message: "Could not create input event.") }
        if let sender { try sender(event, c.route); return }
        guard CGPreflightPostEventAccess() else { throw RuntimeError(code: "PERMISSION", message: "Enable Event Synthesizing/Accessibility for Agent Enhance Computer, then observe again.") }
        if let pid = c.route.pid { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
    }
    func keyDown(_ name: String) throws {
        let c = try context(), code = try Self.keyCode(name)
        guard !c.keys.contains(code) else { throw RuntimeError(code: "INPUT_SCOPE", message: "Key is already held: \(name).") }
        c.keys.append(code)
        let e = CGEvent(keyboardEventSource: c.source, virtualKey: code, keyDown: true); e?.flags = flags(c)
        do { try post(e, c) } catch { c.keys.removeAll { $0 == code }; throw error }
    }
    func keyUp(_ name: String) throws {
        let c = try context(), code = try Self.keyCode(name)
        guard c.keys.contains(code) else { throw RuntimeError(code: "INPUT_SCOPE", message: "Key is not held: \(name).") }
        let before = c.keys; c.keys.removeAll { $0 == code }
        let e = CGEvent(keyboardEventSource: c.source, virtualKey: code, keyDown: false); e?.flags = flags(c)
        do { try post(e, c) } catch { c.keys = before; throw error }
    }
    func press(_ names: [String]) throws {
        let c = try context(), codes = try names.map(Self.keyCode)
        guard !codes.isEmpty, codes.count <= 16, Set(codes).count == codes.count,
              !codes.contains(where: { c.keys.contains($0) }) else {
            throw RuntimeError(code: "INVALID_ARGUMENT", message: "Chord requires 1..16 unique keys that are not already held.")
        }
        var acquired: [String] = []
        defer { for name in acquired.reversed() { try? keyUp(name) } }
        for name in names { try keyDown(name); acquired.append(name) }
    }
    func type(_ text: String, validate: () throws -> Void = {}) async throws {
        let c = try context()
        guard text.utf8.count <= 32000 else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Text exceeds 32000 bytes.") }
        for (index, scalar) in text.unicodeScalars.enumerated() {
            try Task.checkCancellation()
            if index % 16 == 0 { try validate() }
            let units = Array(String(scalar).utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: c.source, virtualKey: 0, keyDown: down)
                units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                e?.flags = flags(c); try post(e, c)
            }
            if index % 16 == 15 { await Task.yield() }
        }
    }
    static func button(_ name: String) throws -> CGMouseButton {
        switch name { case "left": return .left; case "right": return .right; case "middle": return .center
        default: throw RuntimeError(code: "INVALID_ARGUMENT", message: "button must be left, right or middle.") }
    }
    private func mouseEvent(_ c: InputContext, _ type: CGEventType, _ b: CGMouseButton, _ p: CGPoint, _ count: Int) throws -> CGEvent {
        if let window = c.route.number, c.route.pid != nil {
            c.eventNumber += 1
            return try PointerEvents.mouse(type, button: b, point: p, window: window,
                bounds: c.route.bounds, flags: flags(c), count: count, number: c.eventNumber, tag: c.tag, source: c.source)
        }
        guard let e = CGEvent(mouseEventSource: c.source, mouseType: type, mouseCursorPosition: p, mouseButton: b) else {
            throw RuntimeError(code: "INPUT", message: "Could not create mouse event.")
        }
        e.flags = flags(c); e.setIntegerValueField(.mouseEventClickState, value: Int64(count)); return e
    }
    func move(_ p: CGPoint) throws {
        let c = try context(), b = c.buttons.last ?? .left
        let type: CGEventType = c.buttons.isEmpty ? .mouseMoved : b == .left ? .leftMouseDragged : b == .right ? .rightMouseDragged : .otherMouseDragged
        try post(mouseEvent(c, type, b, p, 0), c); c.cursor = p
    }
    func mouse(_ name: String, down: Bool, at p: CGPoint, count: Int = 1) throws {
        let c = try context(), b = try Self.button(name)
        guard down ? !c.buttons.contains(b) : c.buttons.contains(b) else { throw RuntimeError(code: "INPUT_SCOPE", message: "Mouse button hold state does not match this operation.") }
        let type: CGEventType = b == .left ? (down ? .leftMouseDown : .leftMouseUp) : b == .right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        try post(mouseEvent(c, type, b, p, count), c); c.cursor = p
        if down { c.buttons.append(b) } else { c.buttons.removeAll { $0 == b } }
    }
    func releaseMouse(_ name: String) throws { let c = try context(); try mouse(name, down: false, at: c.cursor) }
    func scroll(x: Int32, y: Int32, at p: CGPoint) throws {
        let c = try context(); try move(p)
        guard let e = CGEvent(scrollWheelEvent2Source: c.source, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0) else { throw RuntimeError(code: "INPUT", message: "Could not create scroll event.") }
        e.flags = flags(c)
        if let number = c.route.number, c.route.pid != nil {
            try PointerEvents.stamp(e, window: number, bounds: c.route.bounds, point: p, tag: c.tag)
        }
        try post(e, c)
    }
    func metadata(keyboard: Bool = false) -> [String: Any] {
        guard let c = current else { return [:] }
        return ["delivery": c.route.pid == nil ? "hid" : keyboard ? "pid-keyboard" : "pid-window", "target": ["window": c.route.window, "pid": c.route.applicationPID],
                "modifiers": Self.modifiers.filter { c.keys.contains($0.value.0) }.keys.sorted(),
                "logicalCursor": ["x": c.cursor.x, "y": c.cursor.y]]
    }
    @discardableResult func releaseAll() -> [String: Any] {
        var keys = 0, buttons = 0, errors: [String] = [], targets: [[String: Any]] = []
        for c in contexts.values {
            let keyCount = c.keys.count, buttonCount = c.buttons.count
            current = c
            for b in c.buttons.reversed() {
                do { try releaseMouse(b == .left ? "left" : b == .right ? "right" : "middle"); buttons += 1 }
                catch { errors.append(String(describing: error)) }
            }
            for code in c.keys.reversed() {
                let before = c.keys; c.keys.removeAll { $0 == code }
                let e = CGEvent(keyboardEventSource: c.source, virtualKey: code, keyDown: false); e?.flags = flags(c)
                do { try post(e, c); keys += 1 } catch { c.keys = before; errors.append(String(describing: error)) }
            }
            if keyCount + buttonCount > 0 {
                targets.append(["pid": c.route.applicationPID, "window": c.route.window, "keyDelivery": c.route.pid == nil ? "hid" : "pid-keyboard",
                    "pointerDelivery": c.route.pid == nil ? "hid" : "pid-window", "remainingKeys": c.keys.count, "remainingButtons": c.buttons.count])
            }
        }
        current = nil; foregroundWindow = nil
        if leased && !contexts.values.contains(where: { $0.held && $0.route.pid == nil }) {
            flock(lockFD, LOCK_UN); leased = false
        }
        let remaining = Set(contexts.values.filter { $0.held }.map { $0.route.applicationPID })
        for (pid, fd) in pidLocks where !remaining.contains(pid) { flock(fd, LOCK_UN); Darwin.close(fd) }
        pidLocks = pidLocks.filter { remaining.contains($0.key) }
        return ["releasedKeys": keys, "releasedButtons": buttons, "releaseErrors": errors, "targets": targets]
    }
}
