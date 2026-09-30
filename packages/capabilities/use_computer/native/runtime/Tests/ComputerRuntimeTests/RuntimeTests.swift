import XCTest
@testable import ComputerRuntime
final class RuntimeTests: XCTestCase {
    func testWindowRelativeCoordinatesAcrossDisplays() throws {
        let r = CGRect(x: -1000, y: -300, width: 500, height: 400)
        XCTAssertEqual(try localPoint(CGPoint(x: 20, y: 30), in: r), CGPoint(x: -980, y: -270))
        XCTAssertThrowsError(try localPoint(CGPoint(x: 500, y: 0), in: r))
        XCTAssertThrowsError(try point(["x": Double.infinity, "y": 0]))
    }
    func testKeyValidationDoesNotSynthesizeEvents() throws {
        XCTAssertEqual(try Input.keyCode("command"), 55)
        XCTAssertEqual(try Input.keyCode("return"), 36)
        XCTAssertThrowsError(try Input.keyCode("unknown-key"))
        XCTAssertThrowsError(try Input.button("invalid"))
    }
    func testForegroundLeaseExcludesOtherSessionsAndReleases() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let one = Input(lockPath: dir.appendingPathComponent("input.lock").path)
        let two = Input(lockPath: dir.appendingPathComponent("input.lock").path)
        try one.acquire()
        XCTAssertThrowsError(try two.acquire())
        one.releaseAll()
        try two.acquire()
        two.releaseAll()
    }
    func testForegroundFocusIsCheckedAndExplicitSwitchesCanReturnToAnEarlierWindow() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = Input(lockPath: dir.appendingPathComponent("input.lock").path)
        defer { input.releaseAll() }
        var activated: [String] = []
        try input.prepare("one", focused: { true }) { activated.append("one") }
        try input.prepare("two", focused: { true }) { activated.append("two") }
        try input.prepare("one", focused: { true }) { activated.append("one") }
        try input.prepare("one", focused: { true }) { XCTFail("Repeated input should retain focus") }
        XCTAssertEqual(activated, ["one", "two", "one"])
        XCTAssertThrowsError(try input.prepare("one", focused: { false }) { XCTFail("Do not reactivate after focus changed") })
    }
}
