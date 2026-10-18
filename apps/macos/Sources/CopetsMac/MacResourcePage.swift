import SwiftUI
import CorptieClientCore
import CorptieConversation

struct MacResourcePage: View {
    @ObservedObject var router: AppTabRouter
    @ObservedObject private var selection: AppTabSelectionState
    @ObservedObject private var entities = EntityAPIClient.shared
    init(router: AppTabRouter) { self.router = router; selection = router.selectionState }
    var body: some View {
        ResourceBrowser(focus: $router.resourceFocus, active: selection.selectedTab == .resources,
            works: entities.works.map { ($0.id, $0.name) },
            currentWorkId: BackendClient.shared.selectedSession?.workId,
            api: { ClientResourceAPI(transport: CorptieAppEnvironment.backendTransport, route: .desktop) },
            openSession: { router.openSession($0, source: .deepLink) })
            .mainWindowPageCard()
    }
}
