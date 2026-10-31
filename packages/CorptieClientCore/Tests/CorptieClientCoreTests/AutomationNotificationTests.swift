import Foundation
import Testing
@testable import CorptieClientCore

struct AutomationNotificationTests {
    @Test func realtimeWireCarriesOpaqueCursorAndDecodesNotificationBatches() async throws {
        let payload = try JSONEncoder().encode(batch(1..<2, recovery: true))
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!)
        let transport = BackendTransport(endpoint: endpoint, data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "automationNotifications", value: "true")))
            #expect(query.contains(URLQueryItem(name: "automationCursor", value: "opaque-cursor")))
            let frame = Data("event: automation-notifications\ndata: \(String(decoding: payload, as: UTF8.self))\n\n".utf8)
            let stream = AsyncThrowingStream<Data, Error> { continuation in
                continuation.yield(frame); continuation.finish()
            }
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
        })
        var received = 0
        for try await update in ClientEvents(transport: transport).subscribeRealtime(sessionId: nil, automationCursor: "opaque-cursor") {
            guard case .automationNotifications(let batch) = update else { Issue.record("Unexpected realtime frame"); continue }
            #expect(batch.recovery)
            #expect(batch.events.first?.eventId == "event:1")
            received += 1
        }
        #expect(received == 1)
    }

    private func batch(_ range: Range<Int>, recovery: Bool = false, reset: Bool = false,
                       occurredAt: String = "2026-10-31T12:00:00Z") throws -> ClientAutomationNotificationBatch {
        let items: [[String: Any]] = range.map { sequence in
            ["eventId": "event:\(sequence)", "sequence": sequence,
             "automationId": "automation:\(sequence % 11)", "name": "Check", "kind": "completed",
             "occurredAt": occurredAt]
        }
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "cursor": "cursor\(range.upperBound)",
            "reset": reset, "recovery": recovery, "hasMore": false, "events": items])
        return try JSONDecoder().decode(ClientAutomationNotificationBatch.self, from: data).validated()
    }

    @Test func cursorAndPendingSurviveRestartAndMoreThan256Events() throws {
        let date = try #require(ClientAutomationNotificationBatch.date("2026-10-31T12:00:00Z"))
        var ledger = ClientAutomationNotificationLedger()
        ledger.consume(try batch(1..<1, reset: true), enabled: true, now: date)
        for start in stride(from: 1, to: 501, by: 100) {
            ledger.consume(try batch(start..<(start + 100), recovery: true), enabled: true, now: date)
        }
        #expect(ledger.pending.count == 8)
        #expect(ledger.pendingCount == 500)
        #expect(ledger.recovered)
        ledger = try JSONDecoder().decode(ClientAutomationNotificationLedger.self, from: JSONEncoder().encode(ledger))
        ledger.consume(try batch(401..<501), enabled: true, now: date)
        #expect(ledger.pendingCount == 500)
        ledger.acknowledge(through: 500, count: 500)
        #expect(ledger.pending.isEmpty)
        ledger.consume(try batch(501..<502), enabled: true, now: date)
        #expect(ledger.pendingCount == 1)
        #expect(ledger.cursor == "cursor502")
    }

    @Test func disabledExpiredAndResetBatchesNeverReplay() throws {
        let date = try #require(ClientAutomationNotificationBatch.date("2026-10-31T12:00:00Z"))
        var ledger = ClientAutomationNotificationLedger()
        ledger.consume(try batch(1..<2), enabled: false, now: date)
        ledger.consume(try batch(1..<2), enabled: true, now: date)
        #expect(ledger.pendingCount == 0)
        ledger.consume(try batch(2..<3, occurredAt: "2026-10-30T12:00:00Z"), enabled: true, now: date)
        #expect(ledger.pendingCount == 0)
        #expect(ledger.sequence == 2)
        ledger.consume(try batch(3..<4), enabled: true, now: date)
        #expect(ledger.pendingCount == 1)
        ledger.discardExpired(now: date.addingTimeInterval(901))
        #expect(ledger.pendingCount == 0)
        ledger.consume(try batch(1..<1, reset: true), enabled: true, now: date)
        #expect(ledger.pendingCount == 0)
        #expect(ledger.sequence == 0)
    }

    @Test func acknowledgingAnInFlightSummaryDoesNotDropNewArrivals() throws {
        let date = try #require(ClientAutomationNotificationBatch.date("2026-10-31T12:00:00Z"))
        var ledger = ClientAutomationNotificationLedger()
        ledger.consume(try batch(1..<3), enabled: true, now: date)
        ledger.consume(try batch(3..<4), enabled: true, now: date)
        ledger.acknowledge(through: 2, count: 2)
        #expect(ledger.pendingCount == 1)
        #expect(ledger.pending.map(\.sequence) == [3])
    }

    @Test func independentScopesDoNotShareCursorAndMalformedBatchesFailClosed() throws {
        let date = try #require(ClientAutomationNotificationBatch.date("2026-10-31T12:00:00Z"))
        var first = ClientAutomationNotificationLedger()
        first.consume(try batch(1..<2), enabled: true, now: date)
        let second = ClientAutomationNotificationLedger()
        #expect(second.cursor == nil)
        #expect(first.cursor != second.cursor)
        #expect(throws: (any Error).self) { try batch(1..<130) }
        #expect(throws: (any Error).self) { try batch(1..<2, reset: true) }
        #expect(throws: (any Error).self) { try batch(1..<2, occurredAt: "invalid") }
    }
}
