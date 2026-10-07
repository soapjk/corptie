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

    @Test func defaultsAreFallbackAndAllEightSlotsCanBeLearned() {
        withCache { cache, _ in
            #expect(ClientQuickMessage.defaults.map(\.text) == ["继续", "开始开发", "给我一个完整方案"])
            let oldDefaults = ClientQuickMessage.defaults + [
                .init(id: "obsolete", text: "检查并运行测试", scope: "default", count: 0)
            ]
            let items = cache.remember((0..<8).map { learned("推荐\($0)") } + oldDefaults, for: "a")
            #expect(items.count == 8)
            #expect(items.allSatisfy { $0.scope == "task" })
            #expect(!items.contains { $0.id == "obsolete" })
            let repeated = cache.remember([learned("推荐0"), learned("推荐0")] + oldDefaults, for: "a")
            #expect(repeated.filter { $0.text == "推荐0" }.count == 1)
            #expect(repeated.count == 4)
            let partial = cache.remember((0..<6).map { learned("推荐\($0)") }, for: "a")
            #expect(partial.count == 8)
            #expect(partial.filter { $0.scope == "default" }.count == 2)
            let capped = cache.remember((0..<10).map { learned("推荐\($0)") }, for: "a")
            #expect(capped.count == 8)
        }
    }

    @Test func snapshotsSurviveRecreationButSuccessfulRefreshReplacesOldRecommendations() {
        withCache { cache, defaults in
            let scope = ClientQuickMessageCache.scope(host: "host", taskID: "a", sessionID: "s1")
            let stored = cache.remember([learned("检查布局")], for: scope)
            let recreated = ClientQuickMessageCache(defaults: defaults)
            #expect(recreated.items(for: scope) == stored)
            let refreshed = recreated.remember([learned("检查接口")], for: scope)
            #expect(refreshed.first?.text == "检查接口")
            #expect(!refreshed.contains { $0.text == "检查布局" })
            #expect(recreated.remember(ClientQuickMessage.defaults, for: scope) == ClientQuickMessage.defaults)
            recreated.remember([learned("检查接口")], for: scope)
            #expect(recreated.remember([], for: scope) == ClientQuickMessage.defaults)
            #expect(ClientQuickMessageCache(defaults: defaults).items(for: scope) == ClientQuickMessage.defaults)
        }
    }

    @Test func defaultPhrasesCanEarnTheirPlaceWithoutLosingUsageOrDuplicatingFallback() {
        withCache { cache, _ in
            let command = ClientQuickMessage(id: "default:继续", text: "继续", scope: "task", count: 12)
            let items = cache.remember([command, learned("Continue"), learned("continue")] + ClientQuickMessage.defaults, for: "a")
            #expect(items.first == command)
            #expect(items.filter { $0.text == "继续" }.count == 1)
            #expect(items.filter { $0.text.lowercased() == "continue" }.count == 1)
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
