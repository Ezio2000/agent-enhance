import Foundation
import CoreGraphics

struct RuntimeError: Error {
    let code: String
    let message: String
    var indeterminate = false
    var json: [String: Any] { ["code": code, "message": message, "indeterminate": indeterminate] }
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
