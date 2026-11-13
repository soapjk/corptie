import AppKit
import CorptieClientCore
import CorptieConversation
import SwiftUI

/// Usage/restart observation stays in this footer leaf, away from the native
/// editor. This is a dependency boundary, not a parent view-producing getter.
struct ComposerStatusSurface: View {
    let sessionID: String
    let status: TaskStatus?
    let isReady: Bool
    let notReadyReason: SessionNotReadyReason?
    let activityStatus: String?
    let renderInputs: SessionPageRenderInputs?

    var body: some View {
        if let page = renderInputs {
            ConversationComposerStatusRow(isReady: isReady,
                readinessTitle: notReadyReason?.presentationTitle ?? L10n("Session Not Ready"),
                readinessMessage: notReadyReason?.presentationMessage ?? L10n("This Session cannot accept messages right now."),
                readinessCode: notReadyReason?.code, executionState: status?.sharedExecutionState,
                activity: page.restart?.text ?? activityStatus) {
                    ChatUsageBar(sessionID: sessionID, usage: page.usage?.matching(provider: page.session.external?.provider, model: page.session.external?.currentModel), loadState: page.usageLoadState, accountSupported: page.providers.first { $0.id == page.session.external?.provider }?.supports("usage.account.read"),
                        contextSupported: page.providers.first { $0.id == page.session.external?.provider }?.supports("usage.session.read"))
                }
        } else {
            ThreadMetaView(sessionID: sessionID, status: status, isReady: isReady,
                notReadyReason: notReadyReason, activityStatus: activityStatus)
        }
    }

}

struct ComposerModelSelectionSurface: View {
    let modelCatalog: ProviderCatalogStore
    let backendClient: BackendClient
    let renderInputs: SessionPageRenderInputs?
    let maximumWidth: CGFloat
    let session: TaskSession?

    var body: some View {
        if let page = renderInputs {
            SessionModelMenuSurface(models: page.models, defaultModelID: page.defaultModel,
                defaultReasoningLevel: page.defaultReasoning, loadingModels: page.loadingModels,
                switchingModel: page.switchingModel, switchingReasoning: page.switchingReasoning,
                backendClient: backendClient, maxWidth: maximumWidth, session: session,
                activity: page.activity, renderInputs: page)
        } else { CodexModelMenu(modelCatalog: modelCatalog, maxWidth: maximumWidth, session: session) }
    }

}

struct ComposerAttachmentsSurface: View {
    let images: [ChatImageReference]
    let sessionId: String
    let backendClient: BackendClient
    let onRemove: (ChatImageReference) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: ComposerShellMetrics.attachmentSpacing) {
                ForEach(images) { image in
                    ComposerImageChip(
                        imageURL: backendClient.chatImageURL(sessionID: sessionId, managedPath: image.managedPath),
                        onRemove: { onRemove(image) }
                    )
                }
            }
            .padding(.horizontal, 9)
            .padding(.top, 8)
            .padding(.bottom, 4)
        }
        .frame(height: ComposerShellMetrics.attachmentStripHeight)
    }

}

/// Only the trailing controls observe reduced motion and animate stop-button
/// insertion. Builders are evaluated once per new value, never stored.
struct ComposerActionSurface<Model: View, Stop: View, Send: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let showsModel: Bool
    let showsStop: Bool
    private let model: Model
    private let stop: Stop
    private let send: Send

    init(showsModel: Bool, showsStop: Bool, @ViewBuilder model: () -> Model,
         @ViewBuilder stop: () -> Stop, @ViewBuilder send: () -> Send) {
        self.showsModel = showsModel; self.showsStop = showsStop
        self.model = model(); self.stop = stop(); self.send = send()
    }

    var body: some View {
        HStack(spacing: 6) {
            if showsModel { model }
            if showsStop { stop.transition(.move(edge: .trailing).combined(with: .opacity)) }
            send
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: showsStop)
    }
}

private struct ComposerImageChip: View {
    let imageURL: URL?
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            AsyncImage(url: imageURL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    Image(systemName: phase.error == nil ? "photo" : "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 48, height: 48)
            .background(Color.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.66))
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .help(L10n("Remove image"))
        }
        .padding(.trailing, 3)
    }
}

struct ComposerGlassActionBackground: View {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let tint: Color

    var body: some View {
        if !isLiquidGlass {
            // 原生降级：简洁圆按钮
            Circle()
                .fill(tint.opacity(0.14))
        } else if #available(macOS 26.0, *) {
            Circle()
                .fill(.clear)
                .glassEffect(.clear.tint(tint.opacity(0.11)), in: .circle)
                .overlay {
                    Circle()
                        .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.6)
                }
                .overlay {
                    Circle()
                        .strokeBorder(tint.opacity(0.2), lineWidth: 0.6)
                }
        } else {
            Circle()
                .fill(.ultraThinMaterial)
                .overlay {
                    Circle()
                        .fill(tint.opacity(0.07))
                }
                .overlay {
                    Circle()
                        .strokeBorder(tint.opacity(0.2), lineWidth: 0.6)
                }
        }
    }
}

/// Shared by existing Sessions and the local new-conversation draft.
struct ComposerSendControl: View {
    let disabled: Bool
    let busy: Bool
    var expandedHitArea = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if busy { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold)) }
            }
            .foregroundStyle(disabled ? Color.secondary : Color.white)
            .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
            .background(disabled ? Color.primary.opacity(0.06) : Color.accentColor, in: Circle())
            .contentShape(Circle().inset(by: expandedHitArea ? -8 : 0))
        }
        .buttonStyle(.plain).disabled(disabled)
        .accessibilityLabel(L10n("Send instruction"))
    }
}

/// One stored read per draft scope, cancelled with the leaf. No timer or global observation.
struct DraftComposerUsageSurface: View {
    let provider: String
    let model: String?
    let supported: Bool?
    let baseURL: URL
    @State private var usage: SessionUsageResponse?
    @State private var loadState: UsageLoadState = .loading

    var body: some View {
        ChatUsageBar(sessionID: "", usage: usage, loadState: loadState,
                     isDraft: true, accountSupported: supported)
            .frame(maxWidth: .infinity, alignment: .leading)
            .task {
                guard !provider.isEmpty else { loadState = .ready; return }
                do {
                    let url = baseURL.appending(path: "provider-model-usage").appending(queryItems: [
                        URLQueryItem(name: "provider", value: provider),
                        URLQueryItem(name: "model", value: model)
                    ])
                    let (data, response) = try await URLSession.shared.data(from: url)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        throw URLError(.badServerResponse)
                    }
                    let snapshot = try JSONDecoder().decode(SessionUsageResponse.self, from: data)
                    guard !Task.isCancelled else { return }
                    usage = snapshot.matching(provider: provider, model: model)
                    loadState = .ready
                } catch {
                    if !Task.isCancelled { loadState = .failed }
                }
            }
    }
}
