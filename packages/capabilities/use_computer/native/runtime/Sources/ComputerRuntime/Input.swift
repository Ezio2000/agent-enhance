import Foundation
import CoreGraphics
import Carbon
import Darwin

/// A foreground input lease lasts until endCall, including JS waits between input units.
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
    private let source = CGEventSource(stateID: .privateState)
    private let lockFD: Int32
    private var leased = false
    private var heldKeys: [CGKeyCode] = []
    private var heldButtons: [CGMouseButton] = []
    private var cursor = CGPoint.zero
    private var foregroundWindow: String?
    init(lockPath: String) {
        lockFD = Darwin.open(lockPath, O_CREAT | O_RDWR, 0o600)
    }
    deinit { releaseAll(); if lockFD >= 0 { Darwin.close(lockFD) } }
    func acquire() throws {
        if leased { return }
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            throw RuntimeError(code: "INPUT_BUSY", message: "Another computer session owns foreground input. No action was dispatched.")
        }
        leased = true
    }
    func prepare(_ window: String, focused: () -> Bool, activate: () throws -> Void) throws {
        try acquire()
        if foregroundWindow == window {
            guard focused() else { throw RuntimeError(code: "FOCUS_CHANGED", message: "Foreground focus changed during this call. Stop and observe; input was not dispatched.") }
            return
        }
        // Focus changes while a button/key is held would send the release to a different target.
        guard heldKeys.isEmpty, heldButtons.isEmpty else {
            throw RuntimeError(code: "INPUT_SCOPE", message: "Cannot switch windows while input is held.")
        }
        try activate()
        foregroundWindow = window
    }
    static func keyCode(_ name: String) throws -> CGKeyCode {
        if let m = modifiers[name] { return m.0 }
        if let code = namedKeys[name] { return code }
        if name.count == 1, let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
           let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) {
            let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
            let layout = UnsafeRawPointer(CFDataGetBytePtr(data)).assumingMemoryBound(to: UCKeyboardLayout.self)
            for code in UInt16(0)..<128 {
                var dead: UInt32 = 0
                var count = 0
                var chars = [UniChar](repeating: 0, count: 8)
                let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDisplay), 0,
                    UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead,
                    chars.count, &count, &chars)
                if status == noErr && String(utf16CodeUnits: chars, count: count).lowercased() == name {
                    return CGKeyCode(code)
                }
            }
        }
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "Unsupported key \(name). Use lowercase named keys or a layout character; use typeText for text.")
    }
    private var flags: CGEventFlags {
        Self.modifiers.values.reduce(CGEventFlags()) { value, m in heldKeys.contains(m.0) ? value.union(m.1) : value }
    }
    private func post(_ event: CGEvent?, pid: pid_t?) throws {
        guard CGPreflightPostEventAccess() else {
            _ = CGRequestPostEventAccess()
            throw RuntimeError(code: "PERMISSION", message: "Enable Accessibility/Event Synthesizing for Agent Enhance Computer in System Settings, then observe again.")
        }
        guard let event else { throw RuntimeError(code: "INPUT", message: "Could not create input event.") }
        if let pid { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
    }
    func keyDown(_ name: String) throws {
        let code = try Self.keyCode(name)
        guard !heldKeys.contains(code) else { throw RuntimeError(code: "INPUT_SCOPE", message: "Key is already held: \(name).") }
        heldKeys.append(code)
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        event?.flags = flags
        do { try post(event, pid: nil) } catch { heldKeys.removeAll { $0 == code }; throw error }
    }
    func keyUp(_ name: String) throws {
        let code = try Self.keyCode(name)
        guard heldKeys.contains(code) else { throw RuntimeError(code: "INPUT_SCOPE", message: "Key is not held: \(name).") }
        let before = heldKeys
        heldKeys.removeAll { $0 == code }
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        event?.flags = flags
        do { try post(event, pid: nil) } catch { heldKeys = before; throw error }
    }
    func requireBackground() throws {
        guard heldKeys.isEmpty && heldButtons.isEmpty else { throw RuntimeError(code: "INPUT_SCOPE", message: "Background delivery cannot run inside a foreground input scope.") }
    }
    func press(_ names: [String], pid: pid_t?) throws {
        guard !names.isEmpty else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "keys must not be empty.") }
        let codes = try names.map(Self.keyCode)
        guard Set(codes).count == codes.count else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Duplicate keys in chord.") }
        if pid == nil {
            let before = Set(heldKeys)
            guard !codes.contains(where: { before.contains($0) }) else { throw RuntimeError(code: "INPUT_SCOPE", message: "Chord contains an already held key.") }
            defer {
                for name in names.reversed() where !before.contains((try? Self.keyCode(name)) ?? 65535) { try? keyUp(name) }
            }
            for name in names { try keyDown(name) }
        } else {
            try requireBackground()
            var f = CGEventFlags()
            var posted: [CGKeyCode] = []
            defer {
                for code in posted.reversed() {
                    for modifier in Self.modifiers.values where modifier.0 == code { f.remove(modifier.1) }
                    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
                    event?.flags = f
                    event?.postToPid(pid!)
                }
            }
            for (name, code) in zip(names, codes) {
                if let modifier = Self.modifiers[name] { f.insert(modifier.1) }
                let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
                event?.flags = f
                try post(event, pid: pid)
                posted.append(code)
            }
        }
    }
    func type(_ text: String, pid: pid_t?) throws {
        if pid != nil { try requireBackground() }
        guard text.utf8.count <= 32000 else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Text exceeds 32000 bytes.") }
        // Unicode scalar boundaries avoid splitting surrogate pairs across CGEvent payloads.
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                units.withUnsafeBufferPointer { buffer in event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress) }
                event?.flags = flags
                try post(event, pid: pid)
            }
        }
    }
    static func button(_ name: String) throws -> CGMouseButton {
        switch name { case "left": return .left; case "right": return .right; case "middle": return .center
        default: throw RuntimeError(code: "INVALID_ARGUMENT", message: "button must be left, right or middle.") }
    }
    func move(_ p: CGPoint) throws {
        cursor = p
        let button = heldButtons.last ?? .left
        let type: CGEventType = heldButtons.isEmpty ? .mouseMoved : button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
        event?.flags = flags
        try post(event, pid: nil)
    }
    func mouse(_ name: String, down: Bool, at p: CGPoint, count: Int = 1) throws {
        let b = try Self.button(name)
        if down && heldButtons.contains(b) { throw RuntimeError(code: "INPUT_SCOPE", message: "Mouse button is already held.") }
        if !down && !heldButtons.contains(b) { throw RuntimeError(code: "INPUT_SCOPE", message: "Mouse button is not held.") }
        cursor = p
        let type: CGEventType = b == .left ? (down ? .leftMouseDown : .leftMouseUp) : b == .right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: b)
        event?.flags = flags
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        try post(event, pid: nil)
        if down { heldButtons.append(b) } else { heldButtons.removeAll { $0 == b } }
    }
    func releaseMouse(_ name: String) throws { try mouse(name, down: false, at: cursor) }
    func scroll(x: Int32, y: Int32, at p: CGPoint) throws {
        try move(p)
        let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0)
        event?.flags = flags
        try post(event, pid: nil)
    }
    @discardableResult func releaseAll() -> [String: Any] {
        let keyCount = heldKeys.count, buttonCount = heldButtons.count
        for b in heldButtons.reversed() {
            let type: CGEventType = b == .left ? .leftMouseUp : b == .right ? .rightMouseUp : .otherMouseUp
            CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: cursor, mouseButton: b)?.post(tap: .cghidEventTap)
        }
        heldButtons.removeAll()
        for code in heldKeys.reversed() {
            heldKeys.removeAll { $0 == code }
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
        foregroundWindow = nil
        if leased { flock(lockFD, LOCK_UN); leased = false }
        return ["releasedKeys": keyCount, "releasedButtons": buttonCount]
    }
}
