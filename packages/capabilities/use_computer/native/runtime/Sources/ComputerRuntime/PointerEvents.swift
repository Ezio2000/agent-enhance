import AppKit
import CoreGraphics
import Darwin

/// Directed events never move, hide or restore the physical cursor.
enum PointerEvents {
    typealias Setter = @convention(c) (CGEvent, CGPoint) -> Void
    private static let setter: Setter? = {
        guard let symbol = dlsym(dlopen(nil, RTLD_LAZY), "CGEventSetWindowLocation") else { return nil }
        return unsafeBitCast(symbol, to: Setter.self)
    }()
    static var available: Bool { setter != nil }
    static func stamp(_ event: CGEvent, window: CGWindowID, bounds: CGRect, point: CGPoint, tag: Int64) throws {
        guard let setter else { throw RuntimeError(code: "UNSUPPORTED", message: "Directed mouse input needs CGEventSetWindowLocation on this macOS build. No shared input fallback was attempted.") }
        event.location = point
        event.setIntegerValueField(.eventSourceUserData, value: tag)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
        // Scroll has no NSEvent factory; this private field supplies its window identity.
        event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window))
        setter(event, CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY))
    }
    static func mouse(_ type: CGEventType, button: CGMouseButton, point: CGPoint,
                      window: CGWindowID, bounds: CGRect, flags: CGEventFlags,
                      count: Int, number: Int, tag: Int64, source: CGEventSource) throws -> CGEvent {
        let cocoa: NSEvent.EventType
        switch type {
        case .mouseMoved: cocoa = .mouseMoved
        case .leftMouseDown: cocoa = .leftMouseDown
        case .leftMouseUp: cocoa = .leftMouseUp
        case .leftMouseDragged: cocoa = .leftMouseDragged
        case .rightMouseDown: cocoa = .rightMouseDown
        case .rightMouseUp: cocoa = .rightMouseUp
        case .rightMouseDragged: cocoa = .rightMouseDragged
        case .otherMouseDown: cocoa = .otherMouseDown
        case .otherMouseUp: cocoa = .otherMouseUp
        case .otherMouseDragged: cocoa = .otherMouseDragged
        default: throw RuntimeError(code: "INPUT", message: "Unsupported directed mouse event.")
        }
        guard let event = NSEvent.mouseEvent(with: cocoa, location: .zero,
            modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)),
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(window),
            context: nil, eventNumber: number, clickCount: count, pressure: 0.5)?.cgEvent else {
            throw RuntimeError(code: "INPUT", message: "Could not create directed mouse event.")
        }
        event.setSource(source)
        event.flags = flags
        event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
        event.setIntegerValueField(.mouseEventSubtype, value: 3)
        try stamp(event, window: window, bounds: bounds, point: point, tag: tag)
        return event
    }
}
