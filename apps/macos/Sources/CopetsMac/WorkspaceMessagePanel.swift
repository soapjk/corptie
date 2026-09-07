import SwiftUI

/// A workspace message panel is a separate surface, not a scaled detail page.
/// Data, composer drafts and viewport ownership stay in the shared session content.
struct WorkspaceMessagePanel: View {
    let session: TaskSession
    let presentationCache: SessionPresentationCache
    let composerDraftRepository: ComposerDraftRepository
    let initialTimelinePosition: AppKitChatTimelinePosition?
    let onTimelinePositionChange: (AppKitChatTimelinePosition) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(session.title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(2)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .help(session.title)

            SessionConversationContent(
                sessionId: session.id,
                presentationCache: presentationCache,
                composerDraftRepository: composerDraftRepository,
                initialTimelinePosition: initialTimelinePosition,
                onTimelinePositionChange: onTimelinePositionChange,
                showsHeader: false,
                allowsModelSwitch: false,
                presentation: .workspaceCard
            )
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        }
        .padding(8)
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        .modifier(DetailRailSurfaceModifier(enabled: true))
    }
}

enum SessionConversationPresentation {
    case standard
    case workspaceCard
}

/// Width supplied by the native timeline column; no desktop bubble minimum or
/// natural text width participates in workspace-card sizing.
enum WorkspaceMessageCardLayout {
    static func cardWidth(in columnWidth: CGFloat) -> CGFloat {
        max(1, columnWidth - 4)
    }
}
