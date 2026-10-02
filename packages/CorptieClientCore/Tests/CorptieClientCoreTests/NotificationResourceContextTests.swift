import Testing
@testable import CorptieClientCore

@Suite("Notification resource context")
struct NotificationResourceContextTests {
    private let index = NotificationResourceIndex(
        works: [.init(id: "work:btc", name: "BTC 五分钟反转策略")],
        tasks: [.init(id: "task:live", title: "实盘全链路本地开发", workID: "work:btc")],
        sessions: [.init(id: "session:provider-thread", workID: nil, taskID: "task:live")]
    )

    @Test func resolvesTaskAndItsOwningWork() {
        let context = index.context(forSessionID: "session:provider-thread")
        #expect(context.workName == "BTC 五分钟反转策略")
        #expect(context.taskTitle == "实盘全链路本地开发")
        #expect(context.displayLine() == "Work：BTC 五分钟反转策略 · Task：实盘全链路本地开发")
    }

    @Test func resolvesUniqueLogicalAndProviderSessionAliases() {
        #expect(index.context(forSessionID: "logical:provider-thread").taskTitle == "实盘全链路本地开发")
    }

    @Test func ambiguousAliasesDoNotGuessAResource() {
        let ambiguous = NotificationResourceIndex(sessions: [
            .init(id: "session:same", workID: "work:one", taskID: nil),
            .init(id: "logical:same", workID: "work:two", taskID: nil)
        ])
        #expect(ambiguous.context(forSessionID: "provider:same").isEmpty)
    }
}
