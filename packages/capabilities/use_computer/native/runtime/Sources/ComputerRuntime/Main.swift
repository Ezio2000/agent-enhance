import AppKit
import Darwin
import WebKit

@main enum ComputerMain {
    static func main() {
        let args = CommandLine.arguments
        if args.contains("--fixture") {
            let app = NSApplication.shared; app.setActivationPolicy(.regular)
            let fixture = Fixture(); app.delegate = fixture; app.run(); return
        }
        guard let index = args.firstIndex(of: "--socket"), args.indices.contains(index + 1),
              let lockIndex = args.firstIndex(of: "--input-lock"), args.indices.contains(lockIndex + 1),
              let parentIndex = args.firstIndex(of: "--parent-pid"), args.indices.contains(parentIndex + 1),
              let parentPID = Int32(args[parentIndex + 1]), parentPID > 0,
              let policyIndex = args.firstIndex(of: "--isolation"), args.indices.contains(policyIndex + 1),
              let policy = IsolationPolicy(rawValue: args[policyIndex + 1]) else {
            fputs("Usage: ComputerRuntime --socket PATH --input-lock PATH --parent-pid PID\n", stderr); exit(2)
        }
        let path = args[index + 1], lock = args[lockIndex + 1]
        if let ready = args.firstIndex(of: "--ready-file"), args.indices.contains(ready + 1) {
            try? String(getpid()).write(toFile: args[ready + 1], atomically: true, encoding: .utf8)
        }
        signal(SIGPIPE, SIG_IGN); signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        let runtime = MainActor.assumeIsolated { Desktop(lockPath: lock, isolation: policy) }
        let requests = MainActor.assumeIsolated { RequestQueue { try await runtime.handle($0, $1) } }
        let watcher = DispatchSource.makeTimerSource(queue: .main)
        watcher.schedule(deadline: .now() + 1, repeating: 1)
        watcher.setEventHandler {
            if kill(parentPID, 0) != 0 && errno == ESRCH {
                MainActor.assumeIsolated { requests.stop(); runtime.close() }; unlink(path); exit(0)
            }
        }
        watcher.resume()
        var connected = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if !connected { MainActor.assumeIsolated { runtime.close() }; unlink(path); exit(0) }
        }
        var signals: [DispatchSourceSignal] = []
        for number in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { MainActor.assumeIsolated { requests.stop(); runtime.close() }; unlink(path); exit(0) }
            source.resume(); signals.append(source)
        }
        DispatchQueue.global().async {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { exit(2) }
            var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.utf8) + [UInt8(0)]
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { exit(2) }
            withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0, listen(fd, 1) == 0 else { Darwin.close(fd); exit(2) }
            let client = accept(fd, nil, nil); Darwin.close(fd)
            guard client >= 0 else { unlink(path); exit(2) }
            DispatchQueue.main.async { connected = true }
            let handle = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            var buffer = Data()
            while true {
                var bytes = [UInt8](repeating: 0, count: 65536)
                let count = Darwin.read(client, &bytes, bytes.count)
                guard count > 0 else { break }
                buffer.append(contentsOf: bytes.prefix(count))
                if buffer.count > 64 * 1024 * 1024 { break }
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                    guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                          let id = request["id"], let method = request["method"] as? String else { continue }
                    let params = request["params"] as? [String: Any] ?? [:]
                    Task { @MainActor in
                        requests.submit(RequestQueue.Job(method: method, params: params) { reply in
                            var response = reply; response["id"] = id
                            if let output = try? JSONSerialization.data(withJSONObject: response) { try? handle.write(contentsOf: output + Data([10])) }
                            if method == "shutdown" { try? handle.close(); unlink(path); exit(0) }
                        })
                    }
                }
            }
            Task { @MainActor in requests.stop(); runtime.close(); unlink(path); exit(0) }
        }
        withExtendedLifetime((signals, watcher)) { app.run() }
    }
}

/// A controlled, disposable UI used by native integration tests; never opens user documents.
final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    private var auxiliary: [NSWindow] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu?.addItem(withTitle: "Select All", action: NSSelectorFromString("selectAll:"), keyEquivalent: "a")
        menu.addItem(edit)
        NSApplication.shared.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 500, height: 350), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Agent Enhance Computer Fixture"
        let field = NSTextField(frame: NSRect(x: 20, y: 285, width: 450, height: 25)); field.stringValue = "fixture"; field.setAccessibilityIdentifier("fixture-text")
        let label = NSTextField(labelWithString: "count: 0"); label.frame = NSRect(x: 20, y: 250, width: 450, height: 25); label.setAccessibilityIdentifier("fixture-count")
        let button = FixtureButton(frame: NSRect(x: 20, y: 210, width: 150, height: 30)); button.title = "Increment"; button.counter = label; button.target = button; button.action = #selector(FixtureButton.increment); button.setAccessibilityIdentifier("fixture-button")
        let status = NSTextField(labelWithString: "drag: false shift: false"); status.frame = NSRect(x: 20, y: 185, width: 450, height: 20); status.setAccessibilityIdentifier("fixture-input")
        let canvas = FixtureCanvas(frame: NSRect(x: 20, y: 20, width: 450, height: 160)); canvas.status = status; canvas.setAccessibilityRole(.group); canvas.setAccessibilityIdentifier("fixture-canvas")
        window.contentView?.addSubview(field); window.contentView?.addSubview(label); window.contentView?.addSubview(button)
        window.contentView?.addSubview(status); window.contentView?.addSubview(canvas)
        let area = NSTextView(frame: NSRect(x: 185, y: 210, width: 280, height: 55))
        area.string = "A中🙂Z"; area.setAccessibilityIdentifier("fixture-text-area")
        window.contentView?.addSubview(area)
        let scroll = NSScrollView(frame: NSRect(x: 380, y: 70, width: 90, height: 100))
        scroll.documentView = NSView(frame: NSRect(x: 0, y: 0, width: 80, height: 1000))
        scroll.hasVerticalScroller = true; scroll.setAccessibilityIdentifier("fixture-scroll")
        let scrollState = NSTextField(labelWithString: "scroll: 0")
        scrollState.frame = NSRect(x: 300, y: 180, width: 160, height: 20)
        scrollState.setAccessibilityIdentifier("fixture-scroll-state")
        window.contentView?.addSubview(scroll); window.contentView?.addSubview(scrollState)
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
            scrollState.stringValue = "scroll: \(Int(scroll.contentView.bounds.origin.y))"
        }
        let sibling = NSWindow(contentRect: NSRect(x: 140, y: 140, width: 500, height: 350), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        sibling.title = "Agent Enhance Computer Sibling"
        let siblingText = NSTextField(frame: NSRect(x: 20, y: 280, width: 450, height: 25))
        siblingText.stringValue = "sibling"; siblingText.setAccessibilityIdentifier("fixture-sibling-text")
        sibling.contentView?.addSubview(siblingText); sibling.orderFront(nil); auxiliary.append(sibling)
        let webWindow = NSWindow(contentRect: NSRect(x: 660, y: 140, width: 500, height: 350), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        webWindow.title = "Agent Enhance Computer Web"
        let web = WKWebView(frame: NSRect(x: 0, y: 40, width: 500, height: 310))
        let webState = NSTextField(labelWithString: "{}"); webState.frame = NSRect(x: 10, y: 5, width: 480, height: 30)
        webState.setAccessibilityIdentifier("fixture-web-state")
        webWindow.contentView?.addSubview(web); webWindow.contentView?.addSubview(webState)
        web.loadHTMLString("""
        <html><body><textarea aria-label="fixture-web-text" id="t" style="position:absolute;left:20px;top:10px;width:400px;height:60px">Web中🙂</textarea>
        <button id="b" style="position:absolute;left:20px;top:90px;width:150px;height:40px" onclick="window.hits++">Fixture Web Button</button>
        <div id="c" style="position:absolute;left:220px;top:90px;width:240px;height:90px;background:teal"></div>
        <div id="sc" style="position:absolute;left:20px;top:160px;width:160px;height:100px;overflow:scroll"><div style="height:1000px">Scrollable</div></div>
        <script>window.hits=0;window.events=[];for(const type of ['pointerdown','pointermove','pointerup','click','dblclick','contextmenu','wheel'])
        document.addEventListener(type,e=>{window.events.push({type,target:e.target.id,x:e.clientX,y:e.clientY,shift:e.shiftKey,command:e.metaKey});if(type==='contextmenu')e.preventDefault()});</script>
        </body></html>
        """, baseURL: nil)
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            web.evaluateJavaScript("JSON.stringify({text:document.getElementById('t').value,start:document.getElementById('t').selectionStart,end:document.getElementById('t').selectionEnd,hits:window.hits,scrollY:document.getElementById('sc').scrollTop,events:window.events})") { value, _ in
                if let text = value as? String { webState.stringValue = text }
            }
        }
        webWindow.orderFront(nil); auxiliary.append(webWindow)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
final class FixtureCanvas: NSView {
    var status: NSTextField!
    private var dragged = false
    private var shifted = false
    override func isAccessibilityElement() -> Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { dragged = false; shifted = event.modifierFlags.contains(.shift) }
    override func mouseDragged(with event: NSEvent) { dragged = true; shifted = shifted && event.modifierFlags.contains(.shift) }
    override func mouseUp(with event: NSEvent) { status.stringValue = "drag: \(dragged) shift: \(shifted && event.modifierFlags.contains(.shift))" }
}
final class FixtureButton: NSButton {
    var counter: NSTextField!
    var count = 0
    @objc func increment() { count += 1; counter.stringValue = "count: \(count)" }
}
