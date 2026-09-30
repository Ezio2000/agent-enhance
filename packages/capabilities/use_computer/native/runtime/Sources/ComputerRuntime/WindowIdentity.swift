import ApplicationServices
import CoreGraphics
import Darwin

struct WindowCandidate {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let layer: Int
    let bounds: CGRect
}

enum WindowIdentity {
    typealias WindowGetter = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> Int32
    private static let getter: WindowGetter? = {
        guard let symbol = dlsym(dlopen(nil, RTLD_LAZY), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: WindowGetter.self)
    }()
    static func number(_ element: AXUIElement) -> CGWindowID? {
        var number: CGWindowID = 0
        guard let getter, getter(element, &number) == 0, number != 0 else { return nil }
        return number
    }
    static func resolve(pid: pid_t, title: String, bounds: CGRect, directIDs: [CGWindowID], candidates: [WindowCandidate]) throws -> CGWindowID {
        let owned = candidates.filter { $0.pid == pid }
        for id in directIDs where owned.contains(where: { $0.id == id }) { return id }
        let geometry = owned.filter {
            $0.layer == 0 && abs($0.bounds.minX - bounds.minX) < 2 && abs($0.bounds.minY - bounds.minY) < 2
                && abs($0.bounds.width - bounds.width) < 2 && abs($0.bounds.height - bounds.height) < 2
        }
        let named = title.isEmpty ? [] : geometry.filter { $0.title == title }
        if named.count == 1 { return named[0].id }
        if geometry.count == 1 { return geometry[0].id }
        throw RuntimeError(code: "WINDOW_CAPTURE", message: "Cannot uniquely match the accessibility window to a capture window.", details: [
            "title": title, "candidateCount": geometry.count,
            "candidates": geometry.map { ["number": $0.id, "title": $0.title, "layer": $0.layer] as [String: Any] }
        ])
    }
}
