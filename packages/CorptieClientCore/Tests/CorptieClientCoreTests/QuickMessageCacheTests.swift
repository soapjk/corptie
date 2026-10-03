import Foundation
import Testing
@testable import CorptieClientCore

@MainActor
struct QuickMessageCacheTests {
    private func withCache(_ test: (ClientQuickMessageCache, UserDefaults) -> Void) {
        let suite = "QuickMessageCacheTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        test(ClientQuickMessageCache(defaults: defaults), defaults)
    }

    private func learned(_ text: String) -> ClientQuickMessage {
        .init(id: text, text: text, scope: "task", count: 4)
    }

    @Test func exactlyThreeDefaultsHaveStableIDsAndStayPresentWithLearnedMessages() {
        withCache { cache, _ in
            #expect(ClientQuickMessage.defaults.map(\.text) == ["继续", "开始开发", "给我一个完整方案"])
            let oldDefaults = ClientQuickMessage.defaults + [
                .init(id: "obsolete", text: "检查并运行测试", scope: "default", count: 0)
            ]
            let items = cache.remember((0..<8).map { learned("推荐\($0)") } + oldDefaults, for: "a")
            #expect(items.count == 6)
            #expect(Array(items.suffix(3)) == ClientQuickMessage.defaults)
            #expect(!items.contains { $0.id == "obsolete" })
            let repeated = cache.remember([learned("推荐0"), learned("推荐0")] + oldDefaults, for: "a")
            #expect(repeated.filter { $0.text == "推荐0" }.count == 1)
        }
    }

    @Test func snapshotsSurviveComposerAndCacheRecreationAndEmptyResponses() {
        withCache { cache, defaults in
            let scope = ClientQuickMessageCache.scope(host: "host", taskID: "a", sessionID: "s1")
            let stored = cache.remember([learned("检查布局")], for: scope)
            #expect(cache.remember([], for: scope) == stored)
            let recreated = ClientQuickMessageCache(defaults: defaults)
            #expect(recreated.items(for: scope) == stored)
            #expect(recreated.remember([], for: scope) == stored)
            #expect(recreated.remember(ClientQuickMessage.defaults, for: scope) == stored)
            let refreshed = recreated.remember([learned("检查接口")], for: scope)
            #expect(refreshed.prefix(2).map(\.text) == ["检查接口", "检查布局"])
        }
    }

    @Test func tasksAndHostsAreIsolatedWhileSessionsOfOneTaskShareTheirSnapshot() {
        withCache { cache, _ in
            let a = ClientQuickMessageCache.scope(host: "one", taskID: "a", sessionID: "s1")
            let secondSession = ClientQuickMessageCache.scope(host: "one", taskID: "a", sessionID: "s2")
            #expect(a == secondSession)
            let stored = cache.remember([learned("检查布局")], for: a)
            #expect(cache.items(for: secondSession) == stored)
            for scope in [
                ClientQuickMessageCache.scope(host: "one", taskID: "b", sessionID: "s1"),
                ClientQuickMessageCache.scope(host: "two", taskID: "a", sessionID: "s1"),
                ClientQuickMessageCache.scope(host: "one", taskID: nil, sessionID: "s1")
            ] { #expect(cache.items(for: scope) == ClientQuickMessage.defaults) }
        }
    }

    @Test func evictionBoundsMemoryAndPersistentStorage() {
        withCache { _, defaults in
            let cache = ClientQuickMessageCache(defaults: defaults, maximumScopes: 2)
            cache.remember([learned("一")], for: "a")
            cache.remember([learned("二")], for: "b")
            cache.remember([learned("三")], for: "c")
            #expect(cache.items(for: "a") == ClientQuickMessage.defaults)
            #expect(defaults.data(forKey: "a") == nil)
            let recreated = ClientQuickMessageCache(defaults: defaults, maximumScopes: 2)
            #expect(recreated.items(for: "b").first?.text == "二")
            #expect(recreated.items(for: "c").first?.text == "三")
        }
    }

    @Test func repeatedSnapshotReadsStayInMemoryWithoutChangingStoredState() {
        withCache { cache, defaults in
            let stored = cache.remember([learned("检查布局")], for: "a")
            let before = defaults.data(forKey: "a")
            let start = Date.timeIntervalSinceReferenceDate
            for _ in 0..<10000 { #expect(cache.items(for: "a") == stored) }
            let elapsed = Date.timeIntervalSinceReferenceDate - start
            #expect(defaults.data(forKey: "a") == before)
            #expect(elapsed < 1)
            print("quick-message cache: 10000 in-memory reads in \(elapsed * 1000)ms")
        }
    }
}
