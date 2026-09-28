import AppKit
import SwiftUI

struct ArchivedSessionsSettingsTab: View {
    @ObservedObject var backendClient: BackendClient
    @ObservedObject private var archivedSessionState = BackendClient.shared.archivedSessionController
    @Binding var archivedSessionPendingDeletion: TaskSession?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Archived Sessions"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n("Archived sessions are hidden from the main screen until you restore them."))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }

                Spacer()

                if backendClient.isLoadingArchivedSessions {
                    ProgressView()
                        .controlSize(.small)
                }

                Button(L10n("Refresh"), systemImage: "arrow.clockwise") {
                    Task { await backendClient.refreshArchivedSessions(sessionKind: .assistantChat) }
                }
                .disabled(backendClient.isLoadingArchivedSessions)
            }

            if manuallyArchivedSessions.isEmpty {
                ContentUnavailableView(
                    L10n("No archived sessions"),
                    systemImage: "archivebox",
                    description: Text(L10n("Sessions you archive will appear here and can be restored at any time."))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(manuallyArchivedSessions) { session in
                    HStack(spacing: 12) {
                        Image(systemName: "archivebox.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(session.accent.color)
                            .frame(width: 28)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.title)
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(1)
                            HStack(spacing: 7) {
                                Text(session.agent)
                                Text("·")
                                Text(session.executionTaskStatus.label)
                                if !session.summary.isEmpty {
                                    Text("·")
                                    Text(session.summary)
                                        .lineLimit(1)
                                }
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        }

                        Spacer(minLength: 8)

                        Button(L10n("Restore"), systemImage: "tray.and.arrow.up") {
                            backendClient.setArchived(false, session: session)
                        }
                        .buttonStyle(.borderless)

                        Button(L10n("Delete"), systemImage: "trash", role: .destructive) {
                            archivedSessionPendingDeletion = session
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(.vertical, 5)
                }
                .listStyle(.inset)
            }

            if backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedSessionPaginationFooter
            }
        }
        .padding(.top, 8)
    }

    private var archivedSessionPaginationFooter: some View {
        HStack(spacing: 10) {
            if backendClient.isLoadingMoreArchivedSessions {
                ProgressView()
                    .controlSize(.small)
                Text(L10n("Loading more archived sessions…"))
            } else if let error = backendClient.archivedSessionsLoadError {
                Text(L10nFormat("Could not load more archived sessions: %@", error))
                    .foregroundStyle(.red)
                    .lineLimit(2)
                Spacer()
                Button(L10n("Retry")) {
                    Task {
                        if backendClient.archivedSessionsHasMore {
                            await backendClient.loadMoreArchivedSessions()
                        } else {
                            await backendClient.refreshArchivedSessions(sessionKind: .assistantChat)
                        }
                    }
                }
            } else {
                Text(L10n("More archived sessions are available."))
                Spacer()
                Button(L10n("Load More")) {
                    Task { await backendClient.loadMoreArchivedSessions() }
                }
            }
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(CorptiePalette.secondaryText)
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
    }

    private var manuallyArchivedSessions: [TaskSession] {
        backendClient.archivedSessions.filter(\.allowsManualArchive)
    }
}
