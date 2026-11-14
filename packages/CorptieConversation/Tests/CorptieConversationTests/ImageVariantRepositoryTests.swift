import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor struct ImageVariantRepositoryTests {
    @Test func previewsDoNotReadOriginalCacheAndOriginalRequestsCoalesce() async throws {
        let repository = ConversationImageRepository()
        let resource = ClientMessageImageResource(sessionID: "s", sourceItemID: "m", source: .managed(path: "owned"))
        let counter = ImageFetchCounter()
        let fetch: ConversationImageRepository.Fetch = { _ in
            await counter.increment()
            try await Task.sleep(for: .milliseconds(100))
            return Data([1,2,3])
        }
        #expect(await counter.value == 0)
        _ = try await repository.data(resource.withVariant(.preview), fetch: fetch)
        #expect(await counter.value == 1)
        async let first = repository.data(resource, fetch: fetch)
        async let second = repository.data(resource, fetch: fetch)
        let results = try await (first, second)
        #expect(results.0 == results.1)
        #expect(await counter.value == 2)
        _ = try await repository.data(resource, fetch: fetch)
        #expect(await counter.value == 2)
        #expect(ConversationImageRepository.key(resource) != ConversationImageRepository.key(resource.withVariant(.preview)))
    }
    @Test func closingLastConsumerCancelsSlowTransfer() async throws {
        let repository = ConversationImageRepository()
        let counter = ImageFetchCounter()
        let resource = ClientMessageImageResource(sessionID: "cancel", sourceItemID: "m", source: .managed(path: "owned"))
        let task = Task {
            try await repository.data(resource, fetch: { _ in
                await counter.increment()
                do { try await Task.sleep(for: .seconds(30)); return Data([1]) }
                catch { await counter.cancel(); throw error }
            })
        }
        while await counter.value == 0 { await Task.yield() }
        task.cancel()
        _ = try? await task.value
        for _ in 0..<100 where !(await counter.cancelled) { try await Task.sleep(for: .milliseconds(10)) }
        #expect(await counter.cancelled)
    }
}
private actor ImageFetchCounter {
    var value = 0
    var cancelled = false
    func increment() { value += 1 }
    func cancel() { cancelled = true }
}
