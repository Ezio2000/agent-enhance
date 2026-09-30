import Foundation

/// Socket reads continue while an action awaits. Control requests cancel the
/// running task, invalidate queued work and await its owned-input cleanup.
@MainActor final class RequestQueue {
    struct Job {
        let method: String
        let params: [String: Any]
        let reply: ([String: Any]) -> Void
    }
    private var jobs: [Job] = []
    private var running: Task<Void, Never>?
    private var controlling = false
    private var stopped = false
    private let handle: (String, [String: Any]) async throws -> Any
    init(handle: @escaping (String, [String: Any]) async throws -> Any) { self.handle = handle }
    func submit(_ job: Job) {
        if controlling && ["endCall", "shutdown"].contains(job.method) { jobs.append(job); return }
        if stopped || controlling {
            job.reply(["error": RuntimeError(code: "CANCELLED", message: "Native control teardown is in progress. No action was dispatched.").json]); return
        }
        if ["endCall", "shutdown"].contains(job.method) {
            controlling = true
            let active = running; active?.cancel()
            let queued = jobs; jobs.removeAll()
            for item in queued { item.reply(["error": RuntimeError(code: "CANCELLED", message: "Queued native action was discarded by call teardown.").json]) }
            Task { @MainActor in
                await active?.value
                await execute(job)
                controlling = false
                if job.method == "shutdown" { stopped = true }
                next()
            }
        } else { jobs.append(job); next() }
    }
    private func execute(_ job: Job) async {
        do { job.reply(["result": try await handle(job.method, job.params)]) }
        catch let e as RuntimeError { job.reply(["error": e.json]) }
        catch is CancellationError { job.reply(["error": RuntimeError(code: "CANCELLED", message: "Native action cancelled; completed effects remain.", indeterminate: true).json]) }
        catch { job.reply(["error": RuntimeError(code: "NATIVE_ERROR", message: error.localizedDescription, indeterminate: true).json]) }
    }
    private func next() {
        guard !controlling, !stopped, running == nil, !jobs.isEmpty else { return }
        let job = jobs.removeFirst()
        running = Task { @MainActor in
            await execute(job); running = nil; next()
        }
    }
    func stop() { stopped = true; running?.cancel(); jobs.removeAll() }
}
