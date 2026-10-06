import Foundation
import Testing
@testable import CorptieMobileState

@MainActor
struct PadMessageDeliveryLifetimeTests {
    @Test func inactiveSceneDoesNotCancelSubmission() async {
        let probe = BackgroundAssertionProbe()
        let lifetime = probe.lifetime()
        var started = false
        var completed = false
        lifetime.schedule(key: "same") {
            started = true
            for _ in 0..<8 { await Task.yield() }
            completed = !Task.isCancelled
        }
        while !started { await Task.yield() }
        lifetime.setActive(false)
        await lifetime.waitForCurrentWorker()
        #expect(completed)
        #expect(probe.begins == 1)
        #expect(probe.ends == [1])
    }

    @Test func persistenceAndSubmissionShareOneAssertion() async {
        let probe = BackgroundAssertionProbe()
        let lifetime = probe.lifetime()
        let persistence = lifetime.acquire()
        lifetime.schedule(key: "message") { await Task.yield() }
        lifetime.release(persistence)
        #expect(probe.ends.isEmpty)
        await lifetime.waitForCurrentWorker()
        #expect(probe.begins == 1)
        #expect(probe.ends == [1])
        lifetime.release(persistence)
        #expect(probe.ends == [1])
    }

    @Test func expirationCancelsWithoutRestartingUntilForeground() async {
        let probe = BackgroundAssertionProbe()
        let lifetime = probe.lifetime()
        var started = false
        var cancelled = false
        lifetime.schedule(key: "first") {
            started = true
            do { try await Task.sleep(for: .seconds(60)) } catch { cancelled = true }
        }
        while !started { await Task.yield() }
        lifetime.setActive(false)
        probe.expiration?()
        await lifetime.waitForCurrentWorker()
        #expect(cancelled)
        #expect(probe.ends == [1])
        var resumed = false
        lifetime.schedule(key: "second") { resumed = true }
        #expect(!resumed)
        #expect(lifetime.acquire() == nil)
        lifetime.setActive(true)
        lifetime.schedule(key: "second") { resumed = true }
        await lifetime.waitForCurrentWorker()
        #expect(resumed)
        #expect(probe.ends == [1, 2])
    }

    @Test func replacementWaitsForCancelledWorkerToExit() async {
        let probe = BackgroundAssertionProbe()
        let lifetime = probe.lifetime()
        var events: [String] = []
        lifetime.schedule(key: "old-account") {
            events.append("old-start")
            do { try await Task.sleep(for: .seconds(60)) } catch { }
            for _ in 0..<8 { await Task.yield() }
            events.append("old-end")
        }
        while events.isEmpty { await Task.yield() }
        lifetime.schedule(key: "new-account") { events.append("new-start") }
        await lifetime.waitForCurrentWorker()
        #expect(events == ["old-start", "old-end", "new-start"])
        #expect(probe.begins == 1)
        #expect(probe.ends == [1])
    }

    @Test func deniedAssertionDoesNotBlockForegroundSend() async {
        let lifetime = PadMessageDeliveryLifetime(begin: { _ in nil }, end: { _ in Issue.record("No assertion to end") })
        var sent = false
        lifetime.schedule(key: "first") { sent = true }
        await lifetime.waitForCurrentWorker()
        #expect(sent)
        lifetime.setActive(false)
        lifetime.schedule(key: "second") { Issue.record("Denied background execution must not dispatch") }
        await lifetime.waitForCurrentWorker()
        lifetime.setActive(true)
        lifetime.schedule(key: "third") { sent = true }
        await lifetime.waitForCurrentWorker()
    }
}

@MainActor
private final class BackgroundAssertionProbe {
    var begins = 0
    var ends: [Int] = []
    var expiration: (@MainActor @Sendable () -> Void)?
    func lifetime() -> PadMessageDeliveryLifetime {
        PadMessageDeliveryLifetime(begin: { expiration in
            self.begins += 1
            self.expiration = expiration
            return self.begins
        }, end: { self.ends.append($0) })
    }
}
