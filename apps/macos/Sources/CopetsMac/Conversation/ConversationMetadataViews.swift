import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct DetailMessagesPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(0..<2, id: \.self) { index in
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(CorptiePalette.primaryText.opacity(index == 1 ? 0.08 : 0.12))
                    .frame(height: index == 1 ? 42 : 26)
                    .frame(maxWidth: index == 1 ? 260 : .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
    }
}

struct ThreadMetaView: View {
    @ObservedObject private var supplementaryData = BackendClient.shared.supplementaryDataController
    @ObservedObject private var restartState = BackendClient.shared.sessionRestartActivityController
    let sessionID: String
    let status: TaskStatus?
    let isReady: Bool
    let notReadyReason: SessionNotReadyReason?
    let activityStatus: String?

    var body: some View {
        ConversationComposerStatusRow(
            isReady: isReady,
            readinessTitle: notReadyReason?.presentationTitle ?? L10n("Session Not Ready"),
            readinessMessage: notReadyReason?.presentationMessage
                ?? L10n("This Session cannot accept messages right now."),
            readinessCode: notReadyReason?.code,
            executionState: status?.sharedExecutionState,
            activity: restartState.activityBySessionID[sessionID]?.text ?? activityStatus
        ) {
            ChatUsageBar(sessionID: sessionID, usage: supplementaryData.selectedSessionID == sessionID ? supplementaryData.selectedSessionUsage?.matching(provider: BackendClient.shared.selectedSession?.external?.provider, model: BackendClient.shared.selectedSession?.external?.currentModel) : nil, loadState: supplementaryData.usageLoadState, accountSupported: BackendClient.shared.modelCatalog.agentProviders.first { $0.id == BackendClient.shared.selectedSession?.external?.provider }?.supports("usage.account.read"),
                contextSupported: BackendClient.shared.modelCatalog.agentProviders.first { $0.id == BackendClient.shared.selectedSession?.external?.provider }?.supports("usage.session.read"))
        }
    }
}

struct SessionActivityStatusText: View {
    @ObservedObject private var restartState = BackendClient.shared.sessionRestartActivityController

    let sessionID: String
    let fallbackText: String?
    let fallbackIsActive: Bool
    let fontSize: CGFloat

    var body: some View {
        if let restartActivity = restartState.activityBySessionID[sessionID] {
            ActivityStatusText(
                text: restartActivity.text,
                isActive: restartActivity.isActive,
                fontSize: fontSize
            )
            .id("restart:\(sessionID)")
        } else if let fallbackText, !fallbackText.isEmpty {
            ActivityStatusText(
                text: fallbackText,
                isActive: fallbackIsActive,
                fontSize: fontSize
            )
            .id("activity:\(sessionID)")
        }
    }
}

struct ConnectionIndicatorLight: View {
    let color: Color
    let size: CGFloat
    let glowSize: CGFloat
    let isBreathing: Bool

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    var body: some View {
        // The pulse is a compositor-side CALayer animation. A SwiftUI
        // An infinite SwiftUI animation on this always-mounted indicator kept the
        // window's display cycle running forever, which made every AppKit
        // layout pass recurse through the whole hosting-view tree.
        StatusLightLayer(
            color: NSColor(color),
            dotSize: size,
            glowSize: glowSize,
            isBreathing: isBreathing,
            reduceMotion: accessibilityReduceMotion,
            duration: 1.25,
            minimumOpacity: 0.28
        )
        .frame(width: glowSize, height: glowSize)
    }
}

struct CopyTextButton: View {
    let text: String
    let isVisible: Bool

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 22)
                .foregroundStyle(CorptiePalette.secondaryText)
        }
        .buttonStyle(.plain)
        .background(copyButtonBackground, in: Circle())
        .overlay(
            Circle()
                .strokeBorder(Color.black.opacity(0.06), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 4, y: 2)
        .opacity(isVisible ? 1 : 0)
        .scaleEffect(isVisible ? 1 : 0.88)
        .animation(.easeOut(duration: 0.12), value: isVisible)
        .help(L10n("Copy"))
        .accessibilityLabel(L10n("Copy message"))
        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var copyButtonBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.16, alpha: 0.92)
                : NSColor(calibratedWhite: 1.0, alpha: 0.92)
        })
    }
}

@discardableResult
func copySessionNameToPasteboard(_ rawName: String?) -> Bool {
    guard let name = rawName?.trimmingCharacters(in: .whitespacesAndNewlines),
          !name.isEmpty else {
        return false
    }
    NSPasteboard.general.clearContents()
    return NSPasteboard.general.setString(name, forType: .string)
}
