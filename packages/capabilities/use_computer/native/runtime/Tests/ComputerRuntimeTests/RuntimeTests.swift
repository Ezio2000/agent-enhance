import XCTest
@testable import ComputerRuntime
final class RuntimeTests: XCTestCase {
    func testEmbeddedWebReadinessDistinguishesMissingContentFromTraversalLimits() {
        let shell: [[String: Any]] = [
            ["id": "window", "role": "AXWindow"],
            ["id": "browser", "parent": "window", "title": "BrowserUserView", "role": "AXGroup"],
            ["id": "list", "parent": "browser", "description": "MultiWebView - messenger", "role": "AXGroup"],
            ["id": "chat", "parent": "browser", "description": "MultiWebView - messenger-chat", "role": "AXGroup"]
        ]
        func inspect(_ rows: [[String: Any]], _ depth: Bool = false, _ limit: Bool = false) -> [String: Any] {
            WebContentReadiness.inspect(rows, depthLimited: depth, nodeLimited: limit)
        }
        let missing = inspect(shell)
        XCTAssertEqual(missing["status"] as? String, "pending")
        XCTAssertEqual((missing["missing"] as? [[String: String]])?.map { $0["id"] }, ["list", "chat"])
        XCTAssertEqual(inspect(shell, true)["status"] as? String, "depth_limited")
        XCTAssertEqual(inspect(shell, false, true)["status"] as? String, "node_limited")
        let listReady = shell + [["id": "list-web", "parent": "list", "role": "AXWebArea", "title": "WebView"]]
        XCTAssertEqual((inspect(listReady)["missing"] as? [[String: String]])?.map { $0["id"] }, ["chat"])
        XCTAssertEqual(inspect(listReady + [["id": "chat-web", "parent": "chat", "role": "AXWebArea"]])["status"] as? String, "ready")
        XCTAssertEqual(inspect([["id": "native", "role": "AXTextField"]])["status"] as? String, "not_detected")
        XCTAssertEqual(inspect([["id": "web", "role": "AXWebArea", "title": "WebView"]])["status"] as? String, "ready")
    }
    func testOverlappingWindowIdentityUsesDirectNumberOrUniqueTitle() throws {
        let rect = CGRect(x: 77, y: 83, width: 1203, height: 680)
        let candidates = [
            WindowCandidate(id: 10, pid: 123, title: "WatermarkWidget", layer: 0, bounds: rect),
            WindowCandidate(id: 11, pid: 123, title: "飞书", layer: 0, bounds: rect),
            WindowCandidate(id: 12, pid: 456, title: "飞书", layer: 0, bounds: rect)
        ]
        XCTAssertEqual(try WindowIdentity.resolve(pid: 123, title: "飞书", bounds: rect, directIDs: [], candidates: candidates), 11)
        XCTAssertEqual(try WindowIdentity.resolve(pid: 123, title: "WatermarkWidget", bounds: rect, directIDs: [], candidates: candidates), 10)
        XCTAssertEqual(try WindowIdentity.resolve(pid: 123, title: "", bounds: rect, directIDs: [12, 11], candidates: candidates), 11)
        XCTAssertThrowsError(try WindowIdentity.resolve(pid: 123, title: "", bounds: rect, directIDs: [12], candidates: candidates))
        XCTAssertThrowsError(try WindowIdentity.resolve(pid: 123, title: "missing", bounds: rect, directIDs: [], candidates: candidates))
        let duplicate = candidates + [WindowCandidate(id: 13, pid: 123, title: "飞书", layer: 0, bounds: rect)]
        XCTAssertThrowsError(try WindowIdentity.resolve(pid: 123, title: "飞书", bounds: rect, directIDs: [], candidates: duplicate))
    }
    func testWindowRelativeCoordinatesAcrossDisplays() throws {
        let r = CGRect(x: -1000, y: -300, width: 500, height: 400)
        XCTAssertEqual(try localPoint(CGPoint(x: 20, y: 30), in: r), CGPoint(x: -980, y: -270))
        XCTAssertThrowsError(try localPoint(CGPoint(x: 500, y: 0), in: r))
        XCTAssertThrowsError(try point(["x": Double.infinity, "y": 0]))
    }
    func testKeyValidationDoesNotSynthesizeEvents() throws {
        XCTAssertEqual(try Input.keyCode("command"), 55)
        XCTAssertEqual(try Input.keyCode("return"), 36)
        XCTAssertEqual(try Input.keyCode("Return"), 36)
        XCTAssertEqual(try Input.keyCode("Enter"), 36)
        XCTAssertEqual(try Input.keyCode("Command"), 55)
        XCTAssertEqual(try Input.keyCode("CMD"), 55)
        XCTAssertEqual(try Input.keyCode("Meta"), 55)
        XCTAssertEqual(try Input.keyCode("Ctrl"), 59)
        XCTAssertEqual(try Input.keyCode("Alt"), 58)
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
        try input.prepare("one", pid: 123, focused: { true }) { activated.append("one") }
        try input.prepare("two", pid: 123, focused: { true }) { activated.append("two") }
        try input.prepare("one", pid: 123, focused: { true }) { activated.append("one") }
        try input.prepare("one", pid: 123, focused: { true }) { XCTFail("Repeated input should retain focus") }
        XCTAssertEqual(activated, ["one", "two", "one"])
        XCTAssertThrowsError(try input.prepare("one", pid: 123, focused: { false }) { XCTFail("Do not reactivate after focus changed") })
    }
}

extension RuntimeTests {
    func testFocusRecoveryOnlyRestoresTheRecordedInterruptionBeforeExpiry() {
        XCTAssertTrue(canRestoreUserFocus(currentPID: 123, interruptedBy: 123, elapsed: 10))
        XCTAssertFalse(canRestoreUserFocus(currentPID: 456, interruptedBy: 123, elapsed: 10))
        XCTAssertFalse(canRestoreUserFocus(currentPID: nil, interruptedBy: 123, elapsed: 10))
        XCTAssertFalse(canRestoreUserFocus(currentPID: 123, interruptedBy: 123, elapsed: 91))
        XCTAssertFalse(canRestoreUserFocus(currentPID: 123, interruptedBy: 123, elapsed: -1))
        XCTAssertNoThrow(try IsolationPolicy.isolatedOnly.check("restoreUserFocus", [:]))
    }
    func testUTF16SelectionsRejectSplitSurrogates() throws {
        let text = "A中🙂Z"
        let range = try textRange(["location": 1, "length": 3], in: text)
        XCTAssertEqual(range.location, 1); XCTAssertEqual(range.length, 3)
        XCTAssertThrowsError(try textRange(["location": 3, "length": 1], in: text))
        XCTAssertThrowsError(try textRange(["location": 0, "length": 6], in: text))
    }
    func testDirectedInputPreservesModifiersAndReleaseRouteWithoutMovingPointer() throws {
        guard PointerEvents.available else { throw XCTSkip("Private directed pointer symbol unavailable") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var posted: [(CGEventType, CGEventFlags, InputRoute)] = []
        let before = CGEvent(source: nil)!.location
        let input = Input(lockPath: root.appendingPathComponent("input").path) { e, route in
            XCTAssertNotEqual(e.getIntegerValueField(.eventSourceStateID), Int64(CGEventSourceStateID.combinedSessionState.rawValue))
            XCTAssertNotEqual(e.getIntegerValueField(.eventSourceStateID), Int64(CGEventSourceStateID.hidSystemState.rawValue))
            posted.append((e.type, e.flags, route))
        }
        let bounds = CGRect(x: -1000, y: -300, width: 500, height: 400)
        try input.prepareBackground("one", pid: 123, number: 777, bounds: bounds)
        try input.keyDown("shift")
        try input.mouse("left", down: true, at: CGPoint(x: -980, y: -280))
        XCTAssertThrowsError(try input.prepareBackground("two", pid: 456, number: 888, bounds: bounds))
        let cleanup = input.releaseAll()
        XCTAssertEqual(cleanup["releasedKeys"] as? Int, 1); XCTAssertEqual(cleanup["releasedButtons"] as? Int, 1)
        XCTAssertEqual(posted.map{$0.0}, [.flagsChanged,.leftMouseDown,.leftMouseUp,.flagsChanged])
        XCTAssertTrue(posted.allSatisfy{$0.2.pid == 123 && $0.2.window == "one"})
        XCTAssertTrue(posted.dropLast().allSatisfy{$0.1.contains(.maskShift) && !$0.1.contains(.maskCommand)})
        XCTAssertEqual(posted.last!.1, [])
        XCTAssertEqual(CGEvent(source: nil)!.location, before)
    }
    func testReleaseFailureRetainsOwnershipForRetry() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = true
        let input = Input(lockPath: root.appendingPathComponent("input").path) { e, _ in
            if !e.flags.contains(.maskShift) && fail { fail = false; throw RuntimeError(code: "INPUT", message: "release failure") }
        }
        let another = Input(lockPath: root.appendingPathComponent("input").path) { _, _ in }
        try input.prepareBackground("one", pid: 123, number: 777, bounds: .zero)
        try input.keyDown("shift")
        XCTAssertEqual(input.releaseAll()["releasedKeys"] as? Int, 0)
        XCTAssertTrue(input.hasHeldInput)
        XCTAssertThrowsError(try another.acquireApplication(123))
        XCTAssertEqual(input.releaseAll()["releasedKeys"] as? Int, 1)
        XCTAssertFalse(input.hasHeldInput)
        XCTAssertNoThrow(try another.acquireApplication(123)); another.releaseAll()
    }
    func testOriginalRouteReleaseAndApplicationLeases() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var routes: [InputRoute] = []
        let one = Input(lockPath: root.appendingPathComponent("input").path) { _, route in routes.append(route) }
        let two = Input(lockPath: root.appendingPathComponent("input").path) { _, _ in }
        try one.prepareBackground("one", pid: 123, number: 777, bounds: CGRect(x: 1, y: 2, width: 30, height: 40))
        try one.keyDown("shift")
        XCTAssertThrowsError(try two.acquireApplication(123))
        XCTAssertNoThrow(try two.acquireApplication(456))
        XCTAssertThrowsError(try one.prepareBackground("one", pid: 123, number: 777, bounds: .zero))
        try one.resumeOwned("one", directed: true)
        try one.keyUp("shift")
        XCTAssertEqual(routes.count, 2); XCTAssertEqual(routes.first, routes.last)
        one.releaseAll(); two.releaseAll()
        XCTAssertNoThrow(try two.acquireApplication(123)); two.releaseAll()
    }
    func testIsolationPolicyRejectsDirectNativeBypasses() throws {
        for (method, params) in [("activate", [:]), ("typeText", ["mode": "foreground"]), ("launchApp", ["foreground": true]), ("restartApp", ["foreground": true])] as [(String,[String:Any])] {
            XCTAssertThrowsError(try IsolationPolicy.isolatedOnly.check(method, params))
            XCTAssertNoThrow(try IsolationPolicy.shared.check(method, params))
        }
    }
    @MainActor func testControlCancelsAwaitingActionAndDropsQueuedMutations() async {
        let started = expectation(description: "started"), stopped = expectation(description: "stopped")
        var held = false, queuedExecuted = false, replies = 0
        let queue = RequestQueue { method, _ in
            if method == "drag" {
                held = true; started.fulfill()
                defer { held = false }
                try await Task.sleep(nanoseconds: 10_000_000_000)
            } else if method == "mutation" { queuedExecuted = true }
            return ["held":held]
        }
        queue.submit(.init(method: "drag", params: [:]) {_ in replies += 1})
        await fulfillment(of: [started], timeout: 1)
        queue.submit(.init(method: "mutation", params: [:]) {_ in replies += 1})
        queue.submit(.init(method: "shutdown", params: [:]) {reply in
            XCTAssertFalse(held); XCTAssertNotNil(reply["result"]); replies += 1; stopped.fulfill()
        })
        await fulfillment(of: [stopped], timeout: 1)
        XCTAssertFalse(queuedExecuted); XCTAssertEqual(replies, 3)
    }
}
