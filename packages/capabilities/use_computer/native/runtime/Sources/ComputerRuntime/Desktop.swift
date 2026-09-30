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
    private var activeCall: String?
    private var windows: [String: WindowTarget] = [:]
    private var elements: [String: ElementTarget] = [:]
    private var observedBounds: [String: CGRect] = [:]
    init(lockPath: String) { input = Input(lockPath: lockPath) }
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
    private func bounds(_ ax: AXUIElement) throws -> CGRect {
        guard let pos = value(ax, kAXPositionAttribute), CFGetTypeID(pos as CFTypeRef) == AXValueGetTypeID(),
              let size = value(ax, kAXSizeAttribute), CFGetTypeID(size as CFTypeRef) == AXValueGetTypeID() else {
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
        guard let w = windows[id], !w.app.isTerminated,
              children(appAX(w.app), kAXWindowsAttribute).contains(where: { CFEqual($0, w.ax) }) else {
            throw RuntimeError(code: "STALE_TARGET", message: "Window has closed or its process has exited. List windows again.")
        }
        return w
    }
    private func element(_ id: String, windowID: String) throws -> AXUIElement {
        _ = try window(windowID)
        guard let e = elements[id], e.window == windowID, string(e.ax, kAXRoleAttribute) != nil else {
            throw RuntimeError(code: "STALE_TARGET", message: "Element belongs to an old observation, another window, or no longer exists. Observe again.")
        }
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
        try input.prepare(id, focused: { isFocused(w) }) { try focus(w) }
        for _ in 0..<50 {
            if isFocused(w) { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw RuntimeError(code: "FOCUS", message: "Target window did not become focused. No input was dispatched.")
    }
    private func backgroundKeyboard(_ w: WindowTarget, _ p: [String: Any], _ id: String) throws {
        try input.requireBackground()
        guard let elementID = p["element"] as? String else {
            throw RuntimeError(code: "BACKGROUND_TARGET", message: "Background keyboard delivery requires a focused element from an observation. Use setValue for writable controls, or explicitly choose foreground.")
        }
        let e = try element(elementID, windowID: id)
        guard writable(e, kAXFocusedAttribute) else { throw RuntimeError(code: "UNSUPPORTED", message: "Element cannot receive background accessibility focus.") }
        try checked(AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue), "Focus element")
        guard (value(e, kAXFocusedAttribute) as? Bool) == true,
              let owner = value(appAX(w.app), kAXFocusedWindowAttribute), CFEqual(owner as CFTypeRef, w.ax) else {
            throw RuntimeError(code: "BACKGROUND_TARGET", message: "Cannot confirm the selected element/window for background keyboard delivery.")
        }
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
        if let n = value(w.ax, "AXWindowNumber") as? NSNumber { return CGWindowID(n.uint32Value) }
        let r = try bounds(w.ax)
        let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
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
        if method == "hello" { return ["protocol": 1, "generation": generation, "pid": getpid(), "permissions": permissions()] }
        if method == "beginCall" {
            guard activeCall == nil else { throw RuntimeError(code: "CALL_BUSY", message: "A call is already active.") }
            activeCall = try required(p, "callId") as String
            return ["started": true]
        }
        if method == "endCall" { activeCall = nil; return input.releaseAll() }
        if method == "shutdown" { activeCall = nil; let cleanup = input.releaseAll(); return cleanup }
        guard let callID = p["callId"] as? String, callID == activeCall else { throw RuntimeError(code: "STALE_CALL", message: "The owning JS call has finished. No action was executed.") }
        switch method {
        case "getState": return ["apps": NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier != nil }.map(appJSON), "permissions": permissions(), "generation": generation]
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
            for ax in children(appAX(app), kAXWindowsAttribute) {
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
                var row: [String: Any] = ["id": key, "role": string(ax, kAXRoleAttribute) ?? "unknown", "actions": actions(ax), "valueWritable": writable(ax, kAXValueAttribute)]
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
            return ["image": (data as Data).base64EncodedString(), "mimeType": "image/png", "window": id, "bounds": rectJSON(r), "width": image.width, "height": image.height, "scaleX": Double(image.width) / r.width, "scaleY": Double(image.height) / r.height]
        case "activate": try await foreground(id, w)
        case "setBounds":
            var r = try bounds(w.ax)
            if let x = p["x"] as? Double { r.origin.x = x }; if let y = p["y"] as? Double { r.origin.y = y }
            if let width = p["width"] as? Double { r.size.width = width }; if let height = p["height"] as? Double { r.size.height = height }
            guard r.width > 0, r.height > 0, r.minX.isFinite, r.minY.isFinite, r.width.isFinite, r.height.isFinite else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "Invalid window bounds.") }
            var pos = r.origin, size = r.size
            try checked(AXUIElementSetAttributeValue(w.ax, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pos)!), "Set window position")
            try checked(AXUIElementSetAttributeValue(w.ax, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!), "Set window size")
            observedBounds.removeValue(forKey: id)
        case "minimize", "restore":
            try checked(AXUIElementSetAttributeValue(w.ax, kAXMinimizedAttribute as CFString, method == "minimize" ? kCFBooleanTrue : kCFBooleanFalse), method)
            observedBounds.removeValue(forKey: id)
        case "performAction":
            let e = try element(required(p, "element"), windowID: id)
            try perform(e, required(p, "action"))
        case "setValue":
            let e = try element(required(p, "element"), windowID: id)
            guard writable(e, kAXValueAttribute), let v = p["value"], v is String || v is NSNumber else { throw RuntimeError(code: "UNSUPPORTED", message: "AXValue is not writable or value is not a string, number or boolean.") }
            try checked(AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, v as CFTypeRef), "Set value")
            let actual = value(e, kAXValueAttribute)
            let matches = (actual as? NSObject)?.isEqual(v) ?? false
            return ["outcome": matches ? "observed" : "accepted", "window": id]
        case "menu":
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
            if mode == "background" {
                guard p["point"] == nil, (p["count"] as? Int ?? 1) == 1, (p["button"] as? String ?? "left") == "left" else { throw RuntimeError(code: "FOREGROUND_REQUIRED", message: "Coordinate, multi-click and non-left mouse input require foreground mode.") }
                let e = try element(required(p, "element"), windowID: id)
                try perform(e, kAXPressAction)
            } else {
                var target: CGPoint
                if let e = p["element"] as? String { let r = try bounds(element(e, windowID: id)); target = CGPoint(x: r.midX, y: r.midY) }
                else { target = try pixelPoint(p, "point", id, w) }
                let count = p["count"] as? Int ?? 1
                guard (1...3).contains(count) else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "click count must be 1 to 3.") }
                let button = p["button"] as? String ?? "left"; _ = try Input.button(button)
                try await foreground(id, w)
                if let e = p["element"] as? String { let r = try bounds(element(e, windowID: id)); target = CGPoint(x: r.midX, y: r.midY) }
                else { target = try pixelPoint(p, "point", id, w) }
                try input.move(target)
                for c in 1...count { try input.mouse(button, down: true, at: target, count: c); try input.mouse(button, down: false, at: target, count: c) }
            }
        case "pressKey", "typeText":
            if mode == "foreground" { try await foreground(id, w) }
            else { try backgroundKeyboard(w, p, id) }
            let pid = mode == "background" ? w.app.processIdentifier : nil
            if method == "pressKey" { try input.press(required(p, "keys"), pid: pid) }
            else { try input.type(required(p, "text"), pid: pid) }
            return ["outcome": "dispatched", "mode": mode, "window": id, "effectConfirmed": false]
        case "keyDown", "keyUp", "mouseDown", "mouseUp", "moveMouse", "drag", "scroll":
            guard mode == "foreground" else { throw RuntimeError(code: "FOREGROUND_REQUIRED", message: "\(method) uses shared physical input. Choose mode: foreground explicitly.") }
            // Resolve geometry and validate arguments before changing focus or holding input.
            if method == "keyDown" || method == "keyUp" {
                let key: String = try required(p, "key"); _ = try Input.keyCode(key)
                try await foreground(id, w)
                if method == "keyDown" { try input.keyDown(key) } else { try input.keyUp(key) }
            } else if method == "drag" {
                let from = try pixelPoint(p, "from", id, w), to = try pixelPoint(p, "to", id, w)
                let duration = p["duration_ms"] as? Double ?? 300
                guard duration.isFinite, (0...5000).contains(duration) else { throw RuntimeError(code: "INVALID_ARGUMENT", message: "duration_ms must be 0 to 5000.") }
                let button = p["button"] as? String ?? "left"; _ = try Input.button(button)
                try await foreground(id, w); try validateInputTarget(id, w)
                try input.move(from); try input.mouse(button, down: true, at: from)
                defer { try? input.releaseMouse(button) }
                let steps = max(1, Int(duration / 16))
                for step in 1...steps {
                    try Task.checkCancellation()
                    try validateInputTarget(id, w)
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
                try await foreground(id, w); try validateInputTarget(id, w)
                switch method {
                case "moveMouse": try input.move(at)
                case "mouseDown", "mouseUp": try input.mouse(button, down: method == "mouseDown", at: at)
                default:
                    try input.scroll(x: Int32(x), y: Int32(y), at: at)
                }
            }
        default: throw RuntimeError(code: "METHOD", message: "Unknown native method \(method).")
        }
        return ["outcome": "accepted", "window": id, "mode": mode]
    }
    func close() { activeCall = nil; input.releaseAll() }
}
