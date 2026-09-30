import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

private struct WindowTarget {
    let app: NSRunningApplication
    let ax: AXUIElement
    let title: String
}
private struct ElementTarget {
    let ax: AXUIElement
    let window: String
}

@MainActor final class Desktop {
    let generation = UUID().uuidString
    let input: Input
    let isolation: IsolationPolicy
    private var activeCall: String?
    private var windows: [String: WindowTarget] = [:]
    private var elements: [String: ElementTarget] = [:]
    private var observedBounds: [String: CGRect] = [:]
    init(lockPath: String, isolation: IsolationPolicy = .isolatedOnly) {
        input = Input(lockPath: lockPath); self.isolation = isolation
    }
    func permissions() -> [String: Bool] {
        ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "eventSynthesizing": CGPreflightPostEventAccess()]
    }
    private func requireAX() throws {
        guard AXIsProcessTrusted() else {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
            throw RuntimeError(code: "PERMISSION", message: "Enable Accessibility for Agent Enhance Computer in System Settings, then observe again.")
        }
    }
    private func value(_ ax: AXUIElement, _ attribute: String) -> Any? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(ax, attribute as CFString, &v) == .success ? v : nil
    }
    private func string(_ ax: AXUIElement, _ name: String) -> String? { value(ax, name) as? String }
    private func children(_ ax: AXUIElement, _ name: String = kAXChildrenAttribute) -> [AXUIElement] { value(ax, name) as? [AXUIElement] ?? [] }
    private func read(_ ax: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        var result: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(ax, attribute as CFString, &result)
        guard error == .success else {
            throw RuntimeError(code: error == .invalidUIElement ? "STALE_TARGET" : "AX_ERROR",
                message: "Could not read \(attribute): AX error \(error.rawValue). Observe fresh state; no action is replayed.",
                details: ["attribute": attribute, "axError": error.rawValue])
        }
        return result
    }
    private func bounds(_ ax: AXUIElement) throws -> CGRect {
        guard let pos = try read(ax, kAXPositionAttribute), CFGetTypeID(pos) == AXValueGetTypeID(),
              let size = try read(ax, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else {
            throw RuntimeError(code: "STALE_TARGET", message: "Window or element no longer exposes geometry. Observe again.")
        }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) else {
            throw RuntimeError(code: "STALE_TARGET", message: "Invalid accessibility geometry.")
        }
        return CGRect(origin: p, size: s)
    }
    private func checked(_ result: AXError, _ operation: String) throws {
        guard result == .success else {
            throw RuntimeError(code: result == .invalidUIElement ? "STALE_TARGET" : result == .actionUnsupported || result == .attributeUnsupported ? "UNSUPPORTED" : "AX_ERROR",
                message: "\(operation): AX error \(result.rawValue). Observe before continuing; the action is not replayed.",
                indeterminate: result == .cannotComplete)
        }
    }
    private func running(_ identifier: String) throws -> NSRunningApplication {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == identifier && !$0.isTerminated }
        guard apps.count == 1, let app = apps.first else {
            throw RuntimeError(code: "APP_TARGET", message: apps.isEmpty ? "Application \(identifier) is not running. Use computer.launchApp explicitly." : "Multiple processes match \(identifier). Cannot choose an application.")
        }
        return app
    }
    private func appJSON(_ app: NSRunningApplication) -> [String: Any] {
        ["id": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "pid": app.processIdentifier, "active": app.isActive, "hidden": app.isHidden]
    }
    private func appAX(_ app: NSRunningApplication) -> AXUIElement {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 2)
        return ax
    }
    private func window(_ id: String) throws -> WindowTarget {
        try requireAX()
        guard let w = windows[id], !w.app.isTerminated else {
            throw RuntimeError(code: "STALE_TARGET", message: "Window has closed or its process has exited. List windows again.")
        }
        let current = try read(appAX(w.app), kAXWindowsAttribute) as? [AXUIElement] ?? []
        guard current.contains(where: { CFEqual($0, w.ax) }) else { throw RuntimeError(code: "STALE_TARGET", message: "Window has closed. List windows again.") }
        return w
    }
    private func element(_ id: String, windowID: String) throws -> AXUIElement {
        _ = try window(windowID)
        guard let e = elements[id], e.window == windowID else {
            throw RuntimeError(code: "STALE_TARGET", message: "Element belongs to an old observation, another window, or no longer exists. Observe again.")
        }
        guard try read(e.ax, kAXRoleAttribute) is String else { throw RuntimeError(code: "STALE_TARGET", message: "Element no longer exposes its role. Observe again.") }
        // A retained AX object can move to a different window without becoming invalid.
        if let owner = value(e.ax, kAXWindowAttribute), CFGetTypeID(owner as CFTypeRef) == AXUIElementGetTypeID(),
           let w = windows[windowID], !CFEqual(owner as CFTypeRef, w.ax) {
            throw RuntimeError(code: "STALE_TARGET", message: "Element moved to another window.")
        }
        return e.ax
    }
    private func actions(_ ax: AXUIElement) -> [String] {
        var names: CFArray?
        return AXUIElementCopyActionNames(ax, &names) == .success ? names as? [String] ?? [] : []
    }
    private func perform(_ ax: AXUIElement, _ name: String) throws {
        guard actions(ax).contains(name) else { throw RuntimeError(code: "UNSUPPORTED", message: "Element does not support \(name). No foreground fallback was attempted.") }
        try checked(AXUIElementPerformAction(ax, name as CFString), name)
    }
    private func writable(_ ax: AXUIElement, _ name: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(ax, name as CFString, &settable) == .success && settable.boolValue
    }
    private func focus(_ w: WindowTarget) throws {
        guard w.app.activate(options: []) else { throw RuntimeError(code: "FOCUS", message: "Could not activate target application.") }
        try checked(AXUIElementPerformAction(w.ax, kAXRaiseAction as CFString), "Raise window")
        if writable(w.ax, kAXMainAttribute) { try checked(AXUIElementSetAttributeValue(w.ax, kAXMainAttribute as CFString, kCFBooleanTrue), "Select window") }
    }
    private func isFocused(_ w: WindowTarget) -> Bool {
        guard w.app.isActive, let focused = value(appAX(w.app), kAXFocusedWindowAttribute) else { return false }
        return CFEqual(focused as CFTypeRef, w.ax)
    }
    private func foreground(_ id: String, _ w: WindowTarget) async throws {
        try input.prepare(id, pid: w.app.processIdentifier, focused: { isFocused(w) }) { try focus(w) }
        for _ in 0..<50 {
            if isFocused(w) { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw RuntimeError(code: "FOCUS", message: "Target window did not become focused. No input was dispatched.")
    }
    private func backgroundKeyboard(_ w: WindowTarget, _ p: [String: Any], _ id: String) throws {
        try input.requireBackground()
        try backgroundInput(w, id)
        guard let elementID = p["element"] as? String else {
            throw RuntimeError(code: "BACKGROUND_TARGET", message: "Background keyboard delivery requires a focused element from an observation. Use setValue for writable controls, or explicitly choose foreground.")
        }
        let e = try element(elementID, windowID: id)
        try selectBackgroundElement(w, e)
    }
    private func selectBackgroundElement(_ w: WindowTarget, _ e: AXUIElement) throws {
        let owner = try read(appAX(w.app), kAXFocusedWindowAttribute)
        if owner.map({ CFEqual($0 as CFTypeRef, w.ax) }) != true {
            guard !input.hasHeldInput, writable(w.ax, kAXMainAttribute) else {
                throw RuntimeError(code: "BACKGROUND_TARGET", message: "Cannot select the app's target window while input is held or AXMain is unavailable.")
            }
            try checked(AXUIElementSetAttributeValue(w.ax, kAXMainAttribute as CFString, kCFBooleanTrue), "Select background window")
        }
        if (try read(e, kAXFocusedAttribute) as? Bool) != true {
            guard !input.hasHeldInput, writable(e, kAXFocusedAttribute) else { throw RuntimeError(code: "UNSUPPORTED", message: "Cannot change background element focus inside a held-input scope.") }
            try checked(AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue), "Focus element")
        }
        guard (try read(e, kAXFocusedAttribute) as? Bool) == true,
              let owner = try read(appAX(w.app), kAXFocusedWindowAttribute), CFEqual(owner, w.ax) else {
            throw RuntimeError(code: "BACKGROUND_TARGET", message: "Cannot confirm the selected element/window for background keyboard delivery.")
        }
    }
    private func prepareSemanticElement(_ w: WindowTarget, _ e: AXUIElement) throws {
        // WebKit's writable text attributes may silently ignore writes until its
        // element/window is selected. Never change the active user's key window.
        if !w.app.isActive && writable(e, kAXFocusedAttribute) { try selectBackgroundElement(w, e) }
    }
    private func backgroundInput(_ w: WindowTarget, _ id: String) throws {
        if isolation == .isolatedOnly && w.app.isActive {
            throw RuntimeError(code: "ISOLATION_REQUIRED", message: "The user is using this application. Directed input shares its key window; use observable AX text semantics on another window or a dedicated app.", details: ["target": ["pid": w.app.processIdentifier, "window": id]])
        }
        try input.prepareBackground(id, pid: w.app.processIdentifier, number: windowNumber(w), bounds: bounds(w.ax))
    }
    private func selectedRange(_ e: AXUIElement) -> CFRange? {
        guard let raw = value(e, kAXSelectedTextRangeAttribute), CFGetTypeID(raw as CFTypeRef) == AXValueGetTypeID() else { return nil }
        var range = CFRange(location: 0, length: 0)
        return AXValueGetValue(raw as! AXValue, .cfRange, &range) ? range : nil
    }
    private func rangeJSON(_ range: CFRange) -> [String: Int] { ["location": range.location, "length": range.length] }
    private func selection(_ e: AXUIElement, _ range: CFRange) async throws {
        guard writable(e, kAXSelectedTextRangeAttribute) else { throw RuntimeError(code: "UNSUPPORTED", message: "AXSelectedTextRange is not writable. No keyboard fallback was attempted.") }
        var r = range
        try checked(AXUIElementSetAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, AXValueCreate(.cfRange, &r)!), "Select text")
        for _ in 0..<25 {
            if let actual = selectedRange(e), actual.location == range.location, actual.length == range.length { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard let actual = selectedRange(e), actual.location == range.location, actual.length == range.length else {
            throw RuntimeError(code: "EFFECT_MISMATCH", message: "AX selection did not match the requested range.", indeterminate: true,
                details: ["expected": rangeJSON(range), "observed": selectedRange(e).map(rangeJSON) ?? [:]])
        }
    }
    private func semanticTarget(_ w: WindowTarget, _ id: String) throws {
        if isolation == .isolatedOnly, w.app.isActive {
            guard let owner = try read(appAX(w.app), kAXFocusedWindowAttribute), !CFEqual(owner, w.ax) else {
                throw RuntimeError(code: "ISOLATION_REQUIRED", message: "This is the user's active window, or its focus cannot be confirmed. Isolated writes require another target window/application.")
            }
        }
        guard !input.hasHeldInput else { throw RuntimeError(code: "INPUT_SCOPE", message: "AX semantic edits cannot change focus/selection while input is held.") }
        try input.acquireApplication(w.app.processIdentifier)
    }
    private func verifiedValue(_ e: AXUIElement, _ expected: Any) async throws {
        guard writable(e, kAXValueAttribute) else { throw RuntimeError(code: "UNSUPPORTED", message: "AXValue is not writable.") }
        try checked(AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, expected as CFTypeRef), "Set value")
        for _ in 0..<25 {
            if (value(e, kAXValueAttribute) as? NSObject)?.isEqual(expected) == true { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard (value(e, kAXValueAttribute) as? NSObject)?.isEqual(expected) == true else {
            throw RuntimeError(code: "EFFECT_MISMATCH", message: "AXValue did not match the requested value.", indeterminate: true,
                details: ["expected": expected, "observed": value(e, kAXValueAttribute) ?? NSNull()])
        }
    }
    private func expectedEffect(_ p: [String: Any], _ id: String) async throws -> [String: Any]? {
        guard let expected = p["expect"] as? [String: Any] else { return nil }
        let elementID: String = try required(expected, "element")
        let e = try element(elementID, windowID: id)
        guard expected["value"] != nil || expected["selectedRange"] != nil else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "expect requires value or selectedRange.") }
        let timeout = expected["timeout_ms"] as? Int ?? 500
        guard (0...2000).contains(timeout) else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "expect.timeout_ms must be 0..2000.") }
        var observed: [String: Any] = [:]
        let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
        repeat {
            try Task.checkCancellation()
            observed = ["value": value(e, kAXValueAttribute) ?? NSNull(), "selectedRange": selectedRange(e).map(rangeJSON) ?? [:]]
            let valueMatches = expected["value"] == nil || (value(e, kAXValueAttribute) as? NSObject)?.isEqual(expected["value"]) == true
            var rangeMatches = true
            if let requested = expected["selectedRange"] {
                guard let text = value(e, kAXValueAttribute) as? String else { throw RuntimeError(code: "UNSUPPORTED", message: "Selection expectation needs an observable text value.") }
                let range = try textRange(requested, in: text)
                rangeMatches = selectedRange(e).map { $0.location == range.location && $0.length == range.length } ?? false
            }
            if valueMatches && rangeMatches { return observed }
            if Date() >= deadline { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        } while true
        throw RuntimeError(code: "EFFECT_MISMATCH", message: "Dispatched input did not satisfy its observable expectation; no subsequent action was replayed.",
            indeterminate: true, details: ["expected": expected, "observed": observed, "target": ["window": id]])
    }
    private func pixelPoint(_ p: [String: Any], _ key: String, _ id: String, _ w: WindowTarget) throws -> CGPoint {
        let r = try bounds(w.ax)
        guard let observed = observedBounds[id], observed == r else {
            throw RuntimeError(code: "STALE_OBSERVATION", message: "Observe or screenshot this window before coordinate input; its geometry must still match.")
        }
        return try localPoint(point(p[key]), in: r)
    }
    private func validateInputTarget(_ id: String, _ w: WindowTarget) throws {
        guard isFocused(w) else { throw RuntimeError(code: "FOCUS_CHANGED", message: "Foreground focus changed. No further input was dispatched.") }
        guard let observed = observedBounds[id], observed == (try bounds(w.ax)) else {
            throw RuntimeError(code: "STALE_OBSERVATION", message: "Window geometry changed during input. Observe again; no further input was dispatched.")
        }
    }
    private func windowNumber(_ w: WindowTarget) throws -> CGWindowID {
        let r = try bounds(w.ax)
        let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
        if let n = value(w.ax, "AXWindowNumber") as? NSNumber,
           all.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == n.uint32Value && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == w.app.processIdentifier }) {
            return CGWindowID(n.uint32Value)
        }
        let matches = all.filter {
            guard ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == w.app.processIdentifier,
                  ($0[kCGWindowLayer as String] as? Int) == 0,
                  let raw = $0[kCGWindowBounds as String] as? NSDictionary,
                  let other = CGRect(dictionaryRepresentation: raw) else { return false }
            return abs(r.minX - other.minX) < 2 && abs(r.minY - other.minY) < 2 && abs(r.width - other.width) < 2 && abs(r.height - other.height) < 2
        }
        guard matches.count == 1, let n = matches[0][kCGWindowNumber as String] as? NSNumber else {
            throw RuntimeError(code: "WINDOW_CAPTURE", message: "Cannot uniquely match the accessibility window to a capture window.")
        }
        return CGWindowID(n.uint32Value)
    }
    func handle(_ method: String, _ p: [String: Any]) async throws -> Any {
        let target = (p["window"] as? String).flatMap { windows[$0] }
        let checkWindow = isolation == .isolatedOnly && target != nil && !["observe", "screenshot", "keyUp", "mouseUp"].contains(method)
        let checkLaunch = isolation == .isolatedOnly && method == "launchApp"
        let active = (checkWindow || checkLaunch) ? NSWorkspace.shared.frontmostApplication : nil
        let before = checkWindow ? active.flatMap { value(appAX($0), kAXFocusedWindowAttribute) } : nil
        do {
            let result = try await dispatch(method, p)
            if checkLaunch, let app = result as? [String: Any], app["active"] as? Bool == true,
               app["pid"] as? Int32 != active?.processIdentifier {
                throw RuntimeError(code: "ISOLATION_VIOLATION", message: "The launched application activated itself. Stop and observe; no action is replayed.", indeterminate: true,
                    details: ["target": ["app": app["id"] ?? "", "pid": app["pid"] ?? 0], "delivery": "launch-services"])
            }
            if checkWindow, let target, target.app.isActive {
                let after = value(appAX(target.app), kAXFocusedWindowAttribute)
                if active?.processIdentifier != target.app.processIdentifier ||
                    (before != nil && after.map { CFEqual(before! as CFTypeRef, $0 as CFTypeRef) } != true) ||
                    (before == nil && after.map { CFEqual($0 as CFTypeRef, target.ax) } == true) {
                    throw RuntimeError(code: "ISOLATION_VIOLATION", message: "The target application/window became the user's active input target. Stop and observe; completed effects are not undone.", indeterminate: true)
                }
            }
            return result
        } catch {
            var error = error is CancellationError ? RuntimeError(code: "CANCELLED", message: "Native action cancelled; completed effects remain.", indeterminate: true) :
                (error as? RuntimeError) ?? RuntimeError(code: "NATIVE_ERROR", message: error.localizedDescription,
                indeterminate: !["getState", "getApp", "listWindows", "observe", "screenshot"].contains(method))
            if let target {
                error.details["target"] = ["pid": target.app.processIdentifier, "window": p["window"] ?? ""]
                let keyboard = ["typeText", "pressKey", "keyDown", "keyUp"].contains(method)
                let pointer = ["moveMouse", "mouseDown", "mouseUp", "drag", "scroll"].contains(method) ||
                    (method == "click" && (p["point"] != nil || input.hasHeldInput || (p["count"] as? Int ?? 1) != 1 || (p["button"] as? String ?? "left") != "left"))
                if error.details["delivery"] == nil {
                    error.details["delivery"] = method == "screenshot" ? "screen-capture-kit" : keyboard || pointer ? input.metadata(keyboard: keyboard)["delivery"] ?? "background" : "ax"
                }
            }
            throw error
        }
    }
    private func dispatch(_ method: String, _ p: [String: Any]) async throws -> Any {
        if method == "hello" { return ["protocol": 1, "generation": generation, "pid": getpid(), "permissions": permissions(), "isolation": isolation.rawValue, "directedPointer": PointerEvents.available] }
        if method == "beginCall" {
            guard activeCall == nil else { throw RuntimeError(code: "CALL_BUSY", message: "A call is already active.") }
            activeCall = try required(p, "callId") as String
            return ["started": true]
        }
        if method == "endCall" { activeCall = nil; return input.releaseAll() }
        if method == "shutdown" { activeCall = nil; let cleanup = input.releaseAll(); return cleanup }
        guard let callID = p["callId"] as? String, callID == activeCall else { throw RuntimeError(code: "STALE_CALL", message: "The owning JS call has finished. No action was executed.") }
        try isolation.check(method, p)
        switch method {
        case "getState": return ["apps": NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier != nil }.map(appJSON), "permissions": permissions(), "generation": generation, "isolation": isolation.rawValue, "directedPointer": PointerEvents.available]
        case "getApp": return appJSON(try running(required(p, "app")))
        case "launchApp":
            let bundle: String = try required(p, "app")
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw RuntimeError(code: "APP_TARGET", message: "Application is not installed: \(bundle).") }
            let config = NSWorkspace.OpenConfiguration(); config.activates = p["foreground"] as? Bool ?? false
            let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            return appJSON(app)
        case "listWindows":
            try requireAX()
            let app = try running(required(p, "app"))
            var result: [[String: Any]] = []
            for ax in try read(appAX(app), kAXWindowsAttribute) as? [AXUIElement] ?? [] {
                AXUIElementSetMessagingTimeout(ax, 2)
                let existing = windows.first { $0.value.app.processIdentifier == app.processIdentifier && CFEqual($0.value.ax, ax) }?.key
                let id = existing ?? "w:\(generation):\(UUID().uuidString)"
                let w = WindowTarget(app: app, ax: ax, title: string(ax, kAXTitleAttribute) ?? "")
                windows[id] = w
                result.append(["id": id, "title": w.title, "bounds": rectJSON(try bounds(ax)), "minimized": value(ax, kAXMinimizedAttribute) as? Bool ?? false])
            }
            return result
        default: break
        }
        let id: String = try required(p, "window")
        let w = try window(id)
        let mode = p["mode"] as? String ?? "background"
        guard mode == "background" || mode == "foreground" else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "mode must be background or foreground.") }
        if p["expect"] != nil {
            guard let expected = p["expect"] as? [String: Any], let elementID = expected["element"] as? String,
                  expected["value"] != nil || expected["selectedRange"] != nil else {
                throw RuntimeError(code: "INVALID_ARGUMENT", message: "expect requires element and observable value/selectedRange.")
            }
            _ = try element(elementID, windowID: id)
            if let v = expected["value"], !(v is String || v is NSNumber) {
                throw RuntimeError(code: "INVALID_ARGUMENT", message: "expect.value must be a string, number or boolean.")
            }
            if let range = expected["selectedRange"] {
                guard let range = range as? [String: Any], let l = range["location"] as? Int, let n = range["length"] as? Int,
                      l >= 0, n >= 0 else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Expected selection requires nonnegative UTF-16 integers.") }
            }
            if expected["timeout_ms"] != nil && !(expected["timeout_ms"] is Int) {
                throw RuntimeError(code: "INVALID_ARGUMENT", message: "expect.timeout_ms must be an integer.")
            }
            let timeout = expected["timeout_ms"] as? Int ?? 500
            guard (0...2000).contains(timeout) else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "expect.timeout_ms must be 0..2000.") }
        }
        switch method {
        case "observe":
            let snapshot = UUID().uuidString
            elements = elements.filter { $0.value.window != id }
            var rows: [[String: Any]] = [], seen: [AXUIElement] = []
            let depth = min(max(p["depth"] as? Int ?? 12, 1), 30)
            func walk(_ ax: AXUIElement, _ level: Int, _ parent: String?) {
                guard rows.count < 1500, level <= depth, !seen.contains(where: { CFEqual($0, ax) }) else { return }
                seen.append(ax)
                let key = "e:\(snapshot):\(rows.count)"
                elements[key] = ElementTarget(ax: ax, window: id)
                var row: [String: Any] = ["id": key, "role": string(ax, kAXRoleAttribute) ?? "unknown", "actions": actions(ax), "valueWritable": writable(ax, kAXValueAttribute), "selectedRangeWritable": writable(ax, kAXSelectedTextRangeAttribute)]
                if let range = selectedRange(ax) { row["selectedRange"] = rangeJSON(range) }
                if let parent { row["parent"] = parent }
                for (key, attr) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("identifier", kAXIdentifierAttribute)] {
                    if let s = string(ax, attr), !s.isEmpty { row[key] = s }
                }
                if let v = value(ax, kAXValueAttribute), v is String || v is NSNumber { row["value"] = v }
                if let v = value(ax, kAXEnabledAttribute) as? Bool { row["enabled"] = v }
                if let v = value(ax, kAXFocusedAttribute) as? Bool { row["focused"] = v }
                if let r = try? bounds(ax) { row["bounds"] = rectJSON(r) }
                rows.append(row)
                for child in children(ax) { walk(child, level + 1, key) }
            }
            walk(w.ax, 0, nil)
            let r = try bounds(w.ax); observedBounds[id] = r
            return ["snapshot": snapshot, "window": id, "bounds": rectJSON(r), "elements": rows, "truncated": rows.count >= 1500]
        case "screenshot":
            guard CGPreflightScreenCaptureAccess() else {
                _ = CGRequestScreenCaptureAccess()
                throw RuntimeError(code: "PERMISSION", message: "Enable Screen Recording for Agent Enhance Computer in System Settings.")
            }
            guard (value(w.ax, kAXMinimizedAttribute) as? Bool) != true else { throw RuntimeError(code: "WINDOW_CAPTURE", message: "Minimized windows cannot be captured. Restore explicitly.") }
            let number = try windowNumber(w)
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let scWindow = content.windows.first(where: { $0.windowID == number }) else { throw RuntimeError(code: "WINDOW_CAPTURE", message: "Selected window is not available to ScreenCaptureKit.") }
            let filter = SCContentFilter(desktopIndependentWindow: scWindow)
            let config = SCStreamConfiguration()
            let r = try bounds(w.ax)
            config.width = max(1, Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)))
            config.height = max(1, Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let data = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw RuntimeError(code: "WINDOW_CAPTURE", message: "Cannot encode screenshot.") }
            CGImageDestinationAddImage(dest, image, nil)
            guard CGImageDestinationFinalize(dest) else { throw RuntimeError(code: "WINDOW_CAPTURE", message: "PNG encoding failed.") }
            observedBounds[id] = r
            return ["image": (data as Data).base64EncodedString(), "mimeType": "image/png", "window": id, "bounds": rectJSON(r), "width": image.width, "height": image.height, "scaleX": Double(image.width) / r.width, "scaleY": Double(image.height) / r.height, "delivery": "screen-capture-kit", "target": ["pid": w.app.processIdentifier, "window": id]]
        case "activate": try await foreground(id, w)
        case "setBounds":
            try semanticTarget(w, id)
            var r = try bounds(w.ax)
            if let x = p["x"] as? Double { r.origin.x = x }; if let y = p["y"] as? Double { r.origin.y = y }
            if let width = p["width"] as? Double { r.size.width = width }; if let height = p["height"] as? Double { r.size.height = height }
            guard r.width > 0, r.height > 0, r.minX.isFinite, r.minY.isFinite, r.width.isFinite, r.height.isFinite else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Invalid window bounds.") }
            var pos = r.origin, size = r.size
            try checked(AXUIElementSetAttributeValue(w.ax, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pos)!), "Set window position")
            try checked(AXUIElementSetAttributeValue(w.ax, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!), "Set window size")
            observedBounds.removeValue(forKey: id)
        case "minimize", "restore":
            try semanticTarget(w, id)
            try checked(AXUIElementSetAttributeValue(w.ax, kAXMinimizedAttribute as CFString, method == "minimize" ? kCFBooleanTrue : kCFBooleanFalse), method)
            observedBounds.removeValue(forKey: id)
        case "performAction":
            try semanticTarget(w, id)
            let e = try element(required(p, "element"), windowID: id)
            try perform(e, required(p, "action"))
        case "setValue":
            try semanticTarget(w, id)
            let e = try element(required(p, "element"), windowID: id)
            guard writable(e, kAXValueAttribute), let v = p["value"], v is String || v is NSNumber else { throw RuntimeError(code: "UNSUPPORTED", message: "AXValue is not writable or value is not a string, number or boolean.") }
            try prepareSemanticElement(w, e)
            try await verifiedValue(e, v)
            _ = try await expectedEffect(p, id)
            return ["outcome": "observed", "effectConfirmed": true, "window": id, "delivery": "ax", "target": ["pid": w.app.processIdentifier, "window": id]]
        case "selectAll", "selectText", "replaceText":
            try semanticTarget(w, id)
            let elementID: String = try required(p, "element")
            let e = try element(elementID, windowID: id)
            guard let text = value(e, kAXValueAttribute) as? String else { throw RuntimeError(code: "UNSUPPORTED", message: "Semantic text APIs require an observable text value.") }
            let range = method == "selectText" || (method == "replaceText" && p["range"] != nil)
                ? try textRange(p["range"], in: text) : CFRange(location: 0, length: text.utf16.count)
            try prepareSemanticElement(w, e)
            if method == "replaceText" {
                let replacement: String = try required(p, "text")
                let result = (text as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: replacement)
                try await verifiedValue(e, result)
            } else {
                if !writable(e, kAXSelectedTextRangeAttribute) { try backgroundKeyboard(w, ["element": elementID], id) }
                try await selection(e, range)
            }
            _ = try await expectedEffect(p, id)
            return ["outcome": "observed", "effectConfirmed": true, "delivery": "ax", "target": ["pid": w.app.processIdentifier, "window": id],
                    "value": value(e, kAXValueAttribute) ?? NSNull(), "selectedRange": selectedRange(e).map(rangeJSON) ?? [:]]
        case "menu":
            if mode == "background" { try semanticTarget(w, id) }
            if mode == "foreground" { try await foreground(id, w) }
            else {
                guard let selected = value(appAX(w.app), kAXFocusedWindowAttribute), CFEqual(selected as CFTypeRef, w.ax) else {
                    throw RuntimeError(code: "BACKGROUND_TARGET", message: "Menu command target is not the app key window. Select that window or choose foreground mode.")
                }
            }
            let path: [String] = try required(p, "path")
            guard !path.isEmpty else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Menu path must not be empty.") }
            let app = appAX(w.app)
            guard let raw = value(app, kAXMenuBarAttribute), CFGetTypeID(raw as CFTypeRef) == AXUIElementGetTypeID() else { throw RuntimeError(code: "UNSUPPORTED", message: "Application has no AX menu bar.") }
            var node = raw as! AXUIElement
            for name in path {
                func find(_ ax: AXUIElement, _ depth: Int) -> [AXUIElement] {
                    guard depth < 4 else { return [] }
                    return children(ax).flatMap { child in string(child, kAXTitleAttribute) == name ? [child] : find(child, depth + 1) }
                }
                let matches = find(node, 0)
                guard matches.count == 1 else { throw RuntimeError(code: "MENU_TARGET", message: "Menu item \(name) is missing or ambiguous.") }
                node = matches[0]
            }
            try perform(node, kAXPressAction)
        case "click":
            if mode == "background", p["point"] == nil, (p["count"] as? Int ?? 1) == 1,
               (p["button"] as? String ?? "left") == "left", !input.hasHeldInput {
                try semanticTarget(w, id)
                let e = try element(required(p, "element"), windowID: id)
                try perform(e, kAXPressAction)
                let observed = try await expectedEffect(p, id)
                return ["outcome": observed == nil ? "accepted" : "observed", "delivery": "ax",
                        "target": ["pid": w.app.processIdentifier, "window": id], "effectConfirmed": observed != nil]
            } else {
                var target: CGPoint
                if let e = p["element"] as? String { let r = try bounds(element(e, windowID: id)); target = CGPoint(x: r.midX, y: r.midY) }
                else { target = try pixelPoint(p, "point", id, w) }
                let count = p["count"] as? Int ?? 1
                guard (1...3).contains(count) else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "click count must be 1 to 3.") }
                let button = p["button"] as? String ?? "left"; _ = try Input.button(button)
                if mode == "foreground" { try await foreground(id, w) } else { try backgroundInput(w, id) }
                if let e = p["element"] as? String { let r = try bounds(element(e, windowID: id)); target = CGPoint(x: r.midX, y: r.midY) }
                else { target = try pixelPoint(p, "point", id, w) }
                try input.move(target)
                for c in 1...count { try input.mouse(button, down: true, at: target, count: c); try input.mouse(button, down: false, at: target, count: c) }
            }
        case "pressKey", "typeText":
            if mode == "foreground" { try await foreground(id, w) }
            else { try backgroundKeyboard(w, p, id) }
            if method == "pressKey" { try input.press(required(p, "keys")) }
            else {
                try await input.type(required(p, "text")) {
                    if mode == "foreground" {
                        guard self.isFocused(w) else { throw RuntimeError(code: "FOCUS_CHANGED", message: "Focus changed during text delivery.") }
                    } else {
                        if self.isolation == .isolatedOnly && w.app.isActive { throw RuntimeError(code: "ISOLATION_REQUIRED", message: "The user activated the target during text delivery.", indeterminate: true) }
                        guard let owner = self.value(self.appAX(w.app), kAXFocusedWindowAttribute), CFEqual(owner as CFTypeRef, w.ax) else {
                            throw RuntimeError(code: "BACKGROUND_TARGET", message: "App key window changed during text delivery.")
                        }
                        let e = try self.element(required(p, "element"), windowID: id)
                        guard (self.value(e, kAXFocusedAttribute) as? Bool) == true else { throw RuntimeError(code: "BACKGROUND_TARGET", message: "Element focus changed during text delivery.", indeterminate: true) }
                    }
                }
            }
            let observed = try await expectedEffect(p, id)
            var result = input.metadata(keyboard: true); result["outcome"] = observed == nil ? "dispatched" : "observed"
            result["effectConfirmed"] = observed != nil; if let observed { result["observed"] = observed }
            return result
        case "keyDown", "keyUp", "mouseDown", "mouseUp", "moveMouse", "drag", "scroll":
            // Resolve geometry and validate arguments before changing focus or holding input.
            if method == "keyDown" || method == "keyUp" {
                let key: String = try required(p, "key"); _ = try Input.keyCode(key)
                if method == "keyUp" { try input.resumeOwned(id, directed: mode == "background") }
                else if mode == "foreground" { try await foreground(id, w) }
                else { try backgroundKeyboard(w, p, id) }
                if method == "keyDown" { try input.keyDown(key) } else { try input.keyUp(key) }
            } else if method == "mouseUp" {
                let button = p["button"] as? String ?? "left"; _ = try Input.button(button)
                try input.resumeOwned(id, directed: mode == "background")
                try input.releaseMouse(button)
            } else if method == "drag" {
                let from = try pixelPoint(p, "from", id, w), to = try pixelPoint(p, "to", id, w)
                let duration = p["duration_ms"] as? Double ?? 300
                guard duration.isFinite, (0...5000).contains(duration) else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "duration_ms must be 0 to 5000.") }
                let button = p["button"] as? String ?? "left"; _ = try Input.button(button)
                if mode == "foreground" { try await foreground(id, w); try validateInputTarget(id, w) }
                else { try backgroundInput(w, id) }
                try input.move(from); try input.mouse(button, down: true, at: from)
                defer { try? input.releaseMouse(button) }
                let steps = max(1, Int(duration / 16))
                for step in 1...steps {
                    try Task.checkCancellation()
                    if mode == "foreground" { try validateInputTarget(id, w) }
                    else { try backgroundInput(w, id); _ = try pixelPoint(p, "from", id, w) }
                    let ratio = Double(step) / Double(steps)
                    try input.move(CGPoint(x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio))
                    if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration / Double(steps) * 1_000_000)) }
                }
            } else {
                let at = try pixelPoint(p, "point", id, w)
                let button = p["button"] as? String ?? "left"; _ = try Input.button(button)
                let x = p["x"] as? Int ?? 0, y = p["y"] as? Int ?? 0
                if method == "scroll" && (!(-100000...100000).contains(x) || !(-100000...100000).contains(y)) {
                    throw RuntimeError(code: "INVALID_ARGUMENT", message: "Scroll delta exceeds 100000 pixels.")
                }
                if mode == "foreground" { try await foreground(id, w); try validateInputTarget(id, w) }
                else { try backgroundInput(w, id) }
                switch method {
                case "moveMouse": try input.move(at)
                case "mouseDown", "mouseUp": try input.mouse(button, down: method == "mouseDown", at: at)
                default:
                    try input.scroll(x: Int32(x), y: Int32(y), at: at)
                }
            }
        default: throw RuntimeError(code: "METHOD", message: "Unknown native method \(method).")
        }
        let observed = try await expectedEffect(p, id)
        let directed = ["click", "keyDown", "keyUp", "mouseDown", "mouseUp", "moveMouse", "drag", "scroll"].contains(method)
        var result = directed ? input.metadata(keyboard: ["keyDown", "keyUp"].contains(method)) : ["delivery": "ax", "target": ["pid": w.app.processIdentifier, "window": id]]
        result["outcome"] = observed != nil ? "observed" : directed ? "dispatched" : "accepted"
        result["effectConfirmed"] = observed != nil; result["mode"] = mode
        if let observed { result["observed"] = observed }
        return result
    }
    func close() { activeCall = nil; input.releaseAll() }
}
