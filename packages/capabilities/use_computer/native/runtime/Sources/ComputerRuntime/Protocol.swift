import Foundation
import CoreGraphics

func canRestoreUserFocus(currentPID: Int32?, interruptedBy: Int32, elapsed: TimeInterval) -> Bool {
    currentPID == interruptedBy && elapsed >= 0 && elapsed <= 90
}

struct RuntimeError: Error {
    let code: String
    let message: String
    var indeterminate = false
    var details: [String: Any] = [:]
    var json: [String: Any] { ["code": code, "message": message, "indeterminate": indeterminate, "details": details] }
}
enum IsolationPolicy: String {
    case isolatedOnly = "isolated-only", shared
    func check(_ method: String, _ params: [String: Any]) throws {
        if self == .isolatedOnly && (params["mode"] as? String == "foreground" || method == "activate" ||
            (["launchApp", "restartApp"].contains(method) && params["foreground"] as? Bool == true)) {
            throw RuntimeError(code: "ISOLATION_REQUIRED", message: "This session is isolated-only. Foreground/HID delivery is disabled by the host; code cannot change the policy.",
                details: ["isolation": rawValue, "dispatched": false, "delivery": "blocked", "target": ["window": params["window"] ?? "", "app": params["app"] ?? ""]])
        }
    }
}
func textRange(_ raw: Any?, in text: String) throws -> CFRange {
    guard let p = raw as? [String: Any], let location = p["location"] as? Int, let length = p["length"] as? Int else {
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "Text range requires integer UTF-16 location and length.")
    }
    let units = Array(text.utf16)
    guard location >= 0, length >= 0, location <= units.count, length <= units.count - location else {
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "Text range is outside the current value.")
    }
    for index in [location, location + length] where index > 0 && index < units.count {
        guard !(0xDC00...0xDFFF).contains(units[index]) || !(0xD800...0xDBFF).contains(units[index - 1]) else {
            throw RuntimeError(code: "INVALID_ARGUMENT", message: "Text range splits a Unicode surrogate pair.")
        }
    }
    return CFRange(location: location, length: length)
}
func required<T>(_ params: [String: Any], _ key: String, as: T.Type = T.self) throws -> T {
    guard let value = params[key] as? T else {
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "Missing or invalid \(key).")
    }
    return value
}
func point(_ value: Any?) throws -> CGPoint {
    guard let p = value as? [String: Any], let x = p["x"] as? Double, let y = p["y"] as? Double,
          x.isFinite, y.isFinite else {
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "A point requires finite x and y coordinates.")
    }
    return CGPoint(x: x, y: y)
}
func rectJSON(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}
func localPoint(_ p: CGPoint, in r: CGRect) throws -> CGPoint {
    guard p.x >= 0, p.y >= 0, p.x < r.width, p.y < r.height else {
        throw RuntimeError(code: "INVALID_ARGUMENT", message: "Point lies outside the selected window.")
    }
    return CGPoint(x: r.minX + p.x, y: r.minY + p.y)
}
