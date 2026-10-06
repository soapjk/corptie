import Foundation
import Testing
@testable import CorptieClientSecurity

struct CloudRelaySendSchedulerTests {
    @Test func receiptQueriesAreControlTrafficNotHistory() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1/client/v1/commands/request")!)
        #expect(CloudRelaySendPriority.response(to: request) == .control)
        request = URLRequest(url: URL(string: "http://127.0.0.1/client/v1/sessions/session/messages")!)
        #expect(CloudRelaySendPriority.response(to: request) == .background)
        request.httpMethod = "POST"
        #expect(CloudRelaySendPriority.response(to: request) == .control)
        request = URLRequest(url: URL(string: "http://127.0.0.1/client/v1/sessions")!)
        #expect(CloudRelaySendPriority.response(to: request) == .interactive)
    }
    @Test func controlOvertakesHistoryButWritesRemainSerialized() async throws {
        let scheduler = CloudRelaySendScheduler(backgroundBytesPerSecond: 1_000_000)
        let probe = SchedulerProbe()
        let first = Task { try await scheduler.send(bytes: 1, priority: .interactive) { await probe.write(0, block: true) } }
        await probe.waitForCount(1)
        let history = Task { try await scheduler.send(bytes: 1, priority: .background) { await probe.write(1) } }
        while await scheduler.pendingCount < 1 { await Task.yield() }
        let control = Task { try await scheduler.send(bytes: 1, priority: .control) { await probe.write(2) } }
        while await scheduler.pendingCount < 2 { await Task.yield() }
        await probe.release()
        try await first.value; try await history.value; try await control.value
        #expect(await probe.values == [0, 2, 1])
        await scheduler.close()
    }

    @Test func waitingForHistoryBudgetDoesNotBlockControl() async throws {
        let scheduler = CloudRelaySendScheduler(backgroundBytesPerSecond: 10)
        let probe = SchedulerProbe()
        try await scheduler.send(bytes: 10, priority: .background) { await probe.write(0) }
        let history = Task { try await scheduler.send(bytes: 10, priority: .background) { await probe.write(1) } }
        while await scheduler.pendingCount < 1 { await Task.yield() }
        try await scheduler.send(bytes: 1, priority: .control) { await probe.write(2) }
        #expect(await probe.values == [0, 2])
        history.cancel()
        do { try await history.value; Issue.record("Queued history must be cancelled") }
        catch { #expect(error is CancellationError) }
        await scheduler.close()
    }

    @Test func queueIsBoundedAndCloseReleasesWaitingProducers() async throws {
        let scheduler = CloudRelaySendScheduler(maximumQueuedBytes: 8)
        let probe = SchedulerProbe()
        let first = Task { try await scheduler.send(bytes: 8, priority: .interactive) { await probe.write(0, block: true) } }
        await probe.waitForCount(1)
        let waiting = Task { try await scheduler.send(bytes: 8, priority: .interactive) { await probe.write(1) } }
        while await scheduler.pendingCount < 1 { await Task.yield() }
        await #expect(throws: CloudRelayTransportError.responseTooLarge) {
            try await scheduler.send(bytes: 1, priority: .control) { await probe.write(2) }
        }
        await scheduler.close()
        await #expect(throws: CloudRelayTransportError.disconnected) { try await waiting.value }
        await probe.release(); try await first.value
        #expect(await probe.values == [0])
    }

    @Test func backgroundCannotFillTheControlReserve() async throws {
        let scheduler = CloudRelaySendScheduler(maximumQueuedBytes: 8)
        let probe = SchedulerProbe()
        let first = Task { try await scheduler.send(bytes: 1, priority: .interactive) { await probe.write(0, block: true) } }
        await probe.waitForCount(1)
        let background = Task { try await scheduler.send(bytes: 6, priority: .background) { await probe.write(1) } }
        while await scheduler.pendingCount < 1 { await Task.yield() }
        await #expect(throws: CloudRelayTransportError.responseTooLarge) {
            try await scheduler.send(bytes: 1, priority: .background) { await probe.write(3) }
        }
        let control = Task { try await scheduler.send(bytes: 2, priority: .control) { await probe.write(2) } }
        while await scheduler.pendingCount < 2 { await Task.yield() }
        await probe.release()
        try await first.value; try await background.value; try await control.value
        #expect(await probe.values == [0, 2, 1])
        await scheduler.close()
    }

    @Test func continuousInteractiveTrafficDoesNotStarveReadyBackgroundWork() async throws {
        let scheduler = CloudRelaySendScheduler(backgroundBytesPerSecond: 1_000_000)
        let probe = SchedulerProbe()
        let first = Task { try await scheduler.send(bytes: 1, priority: .interactive) { await probe.write(0, block: true) } }
        await probe.waitForCount(1)
        let background = Task { try await scheduler.send(bytes: 1, priority: .background) { await probe.write(100) } }
        while await scheduler.pendingCount < 1 { await Task.yield() }
        var producers: [Task<Void, Error>] = []
        for value in 1...16 {
            producers.append(Task { try await scheduler.send(bytes: 1, priority: .interactive) { await probe.write(value) } })
        }
        while await scheduler.pendingCount < 17 { await Task.yield() }
        await probe.release()
        try await first.value; try await background.value
        for producer in producers { try await producer.value }
        let values = await probe.values
        #expect(try #require(values.firstIndex(of: 100)) <= 8)
        await scheduler.close()
    }
}

private actor SchedulerProbe {
    var values: [Int] = []
    private var blocked: CheckedContinuation<Void, Never>?
    func write(_ value: Int, block: Bool = false) async {
        values.append(value)
        if block { await withCheckedContinuation { blocked = $0 } }
    }
    func release() { blocked?.resume(); blocked = nil }
    func waitForCount(_ count: Int) async {
        while values.count < count { await Task.yield() }
    }
}
