import Testing
import CorptieClientCore
@testable import CorptieMac

@MainActor @Suite struct ResourceNavigationTests {
    @Test func resourceTabIsDirectAndExactVersionRoutingDoesNotRewriteTheSessionRoute() {
        let router = AppTabRouter()
        let focus = ClientResourceFocus(id: "artifact:one", version: 3, hash: String(repeating: "a", count: 64))
        router.openResource(focus)
        #expect(router.selectedTab == .resources)
        #expect(router.resourceFocus == focus)
        #expect(AppTab.resources.index == AppTab.worktrees.index + 1)
        #expect(AppTab.resources.systemImage == "tray.full")
        router.openSession("session:source", source: .deepLink)
        #expect(router.selectedTab == .console)
        #expect(router.pendingSessionId == "session:source")
        #expect(router.resourceFocus == focus)
        router.openResource(.init(id: "", workId: "work:one"))
        #expect(router.resourceFocus?.workId == "work:one")
        #expect(router.selectedTab == .resources)
    }
}
