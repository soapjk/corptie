import AppKit
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
            openSession: { router.openSession($0, source: .deepLink) },
            revealFile: { focus in
                guard let version = focus.version, let hash = focus.hash else {
                    throw EntityLaunchError(message: "请选择要打开的文档版本。", code: "RESOURCE_VERSION_INVALID")
                }
                let receipt = try await ArtifactAPIClient.shared.localFile(
                    artifactID: focus.id, version: version, contentHash: hash)
                try Task.checkCancellation()
                guard (receipt.path as NSString).isAbsolutePath else {
                    throw EntityLaunchError(message: "文档位置不是有效的本机文件路径。", code: "ARTIFACT_PATH_INVALID")
                }
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: receipt.path)])
            })
            .mainWindowPageCard()
    }
}
