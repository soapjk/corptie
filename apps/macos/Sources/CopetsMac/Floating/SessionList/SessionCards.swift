import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct TaskCardView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    @State private var quickReply = ""
    @State private var lastQuickReplyInteractionAt = Date.distantPast
    @State private var isRenaming = false
    @State private var isShowingUnboundHint = false
    @State private var isHoveringSummary = false
    @State private var hoverPreviewTask: Task<Void, Never>?
    @FocusState private var isQuickReplyFocused: Bool

    private static let iso8601Formatter = ISO8601DateFormatter()

    let session: TaskSession
    var showsProjectName = true
    var hoverPreviewChanged: (String, Bool) -> Void = { _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                SessionAvatarView(session: session, avatarSize: 34)
                    .overlay {
                        connectionIndicatorButton
                            .opacity(0.001)
                            .offset(x: 14, y: -14)
                    }
                    .frame(width: 47, height: 47)

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                    SessionIdentityLine(
                        session: session,
                        showsProjectName: showsProjectName,
                        fontSize: 10
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer()

                if session.pinned == true {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(CorptiePalette.amber)
                        .help(L10n("Pinned"))
                }

                Text(session.executionTaskStatus.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(session.executionTaskStatus.color)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(session.executionTaskStatus.color.opacity(0.14), in: Capsule())
            }

            Text(session.summary)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.cardPreviewText)
                .lineLimit(1)
                .truncationMode(.tail)
                .contentShape(Rectangle())
                .onHover { hovering in
                    handleSummaryHover(hovering)
                }

            HStack(spacing: 10) {
                SessionActivityStatusText(
                    sessionID: session.id,
                    fallbackText: session.executionTaskStatus == .running ? session.activityStatus : nil,
                    fallbackIsActive: session.executionTaskStatus == .running,
                    fontSize: 11
                )
                .frame(height: 14)
                .layoutPriority(-1)

                Text(relativeTime(session.updatedAt))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)

                if session.executionTaskStatus == .running {
                    Spacer()

                    if session.canInterruptNow {
                        Button {
                            backendClient.interrupt(
                                session: session,
                                surface: .sessionListRowControl
                            )
                        } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 9, weight: .bold))
                                .frame(width: 24, height: 24)
                        }
                        .buttonStyle(IconButtonStyle())
                        .help(L10n("Stop current run"))
                    }
                } else if canQuickReply {
                    Spacer(minLength: 6)

                    QuickReplyField(
                        text: $quickReply,
                        isFocused: $isQuickReplyFocused,
                        isSending: backendClient.isSendingMessage,
                        placeholder: L10n("Reply"),
                        onInteract: {
                        lastQuickReplyInteractionAt = Date()
                        },
                        send: {
                            sendQuickReply()
                        }
                    )
                    .frame(width: 132)
                }
            }

            if hasSuggestedOptions {
                suggestedOptionsSummary
            }
        }
        .padding(13)
        .fixedSize(horizontal: false, vertical: true)
        .standardSessionCardSurface()
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture {
            if Date().timeIntervalSince(lastQuickReplyInteractionAt) > 0.25 {
                backendClient.select(session: session, focusComposer: true)
            }
        }
        .contextMenu {
            SessionContextMenuContent(session: session, isRenaming: $isRenaming)
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) {
                isRenaming = false
            }
            .environmentObject(backendClient)
            .presentationBackground(.clear)
        }
    }

    private var hasSuggestedOptions: Bool {
        !(session.suggestedOptions ?? []).isEmpty
    }

    private var canQuickReply: Bool {
        session.canSendNow
    }

    private var visibleSuggestedOptions: [CodexApprovalOption] {
        Array((session.suggestedOptions ?? []).prefix(5))
    }

    private var suggestedOptionsSummary: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 9, weight: .bold))
            Text(visibleSuggestedOptions.first?.label ?? L10n("Choice available"))
                .font(.system(size: 10.5, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            if visibleSuggestedOptions.count > 1 {
                Text("+\(visibleSuggestedOptions.count - 1)")
                    .font(.system(size: 10, weight: .bold))
            }
        }
        .foregroundStyle(CorptiePalette.amber)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(visibleSuggestedOptions.map(\.label).joined(separator: "\n"))
    }

    private var replyPreviewText: String? {
        let trimmed = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var connectionIndicatorHelp: String {
        if session.isUnboundSession {
            return L10n("Session is not bound yet")
        }
        if session.canResumeNow && !session.isConnected {
            return L10n("Reconnect session")
        }
        if !session.usesManualConnection {
            return L10n("Session is available")
        }
        if session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id) {
            return L10n("Switching PTY connection")
        }
        return session.isConnected ? L10n("Disconnect PTY") : L10n("Reconnect PTY")
    }

    private var connectionIndicatorPopoverText: String {
        if session.isUnboundSession {
            return L10n("尚未发送消息的会话，无法切换状态。")
        }
        if session.canResumeNow && !session.isConnected {
            return L10n("点击重新连接这个会话。")
        }
        if !session.usesManualConnection {
            return L10n("这个会话无需手动连接，当前可用。")
        }
        return L10n("正在切换连接状态。")
    }

    private var connectionIndicatorButton: some View {
        Button {
            lastQuickReplyInteractionAt = Date()
            guard !backendClient.connectionTransitionSessionIds.contains(session.id) else {
                return
            }
            if session.isUnboundSession {
                isShowingUnboundHint = true
            } else if session.canResumeNow && !session.isConnected {
                backendClient.reconnect(session: session)
            } else if session.usesManualConnection {
                backendClient.togglePtyConnection(for: session)
            } else {
                isShowingUnboundHint = true
            }
        } label: {
            let isTransitioning = session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id)
            let lightColor = (session.isConnecting || (!session.isConnected && isTransitioning))
                ? CorptiePalette.disconnected
                : session.connectionColor
            ConnectionIndicatorLight(
                color: lightColor,
                size: 9,
                glowSize: 20,
                isBreathing: isTransitioning
            )
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .help(connectionIndicatorHelp)
        .popover(isPresented: $isShowingUnboundHint, arrowEdge: .top) {
            Text(connectionIndicatorPopoverText)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.black)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(width: 220)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func sendQuickReply() {
        let text = quickReply
        backendClient.sendMessage(text, to: session) {
            quickReply = ""
        }
    }

    private func handleSummaryHover(_ hovering: Bool) {
        hoverPreviewTask?.cancel()
        hoverPreviewTask = nil

        if hovering {
            hoverPreviewTask = Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else {
                    return
                }
                await MainActor.run {
                    isHoveringSummary = true
                    if replyPreviewText != nil {
                        hoverPreviewChanged(session.id, true)
                    }
                }
            }
        } else {
            hideHoverPreviewImmediately()
        }
    }

    private func hideHoverPreviewImmediately() {
        hoverPreviewTask?.cancel()
        hoverPreviewTask = nil
        isHoveringSummary = false
        hoverPreviewChanged(session.id, false)
    }

    private func relativeTime(_ value: String) -> String {
        guard let date = Self.iso8601Formatter.date(from: value) else {
            return ""
        }

        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 {
            return L10nFormat("%llds ago", seconds)
        }
        let minutes = seconds / 60
        if minutes < 60 {
            return L10nFormat("%lldm ago", minutes)
        }
        return L10nFormat("%lldh ago", minutes / 60)
    }
}

struct SessionReplyHoverBubble: View {
    let text: String
    var showsArrow = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical, showsIndicators: true) {
                Text(text)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(CorptiePalette.primaryText)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
            .frame(width: 248)
            .frame(maxHeight: 82)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(.regularMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(CorptiePalette.glassVeilFocused.opacity(0.52))
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.24), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.16), radius: 10, y: 5)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            if showsArrow {
                Triangle()
                    .fill(.regularMaterial)
                    .overlay(Triangle().stroke(Color.white.opacity(0.20), lineWidth: 1))
                    .frame(width: 14, height: 8)
                    .rotationEffect(.degrees(180))
                    .offset(x: -86, y: -1)
            }
        }
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct LiquidGlassCardBackground: View {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let cornerRadius: CGFloat
    let fillOpacity: Double

    var body: some View {
        if !isLiquidGlass {
            // 原生降级：简洁卡片背景（Sessions Tab）
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        } else if !SessionListPerformanceFlags.current.glassEffectsEnabled {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        } else if #available(macOS 26.0, *) {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.clear)
                .glassEffect(.clear.tint(Color.white.opacity(0.025)), in: .rect(cornerRadius: cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.regularMaterial)
                        .opacity(0.68)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Color.white.opacity(fillOpacity))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.34),
                                    Color.white.opacity(0.14),
                                    Color.black.opacity(0.20)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1
                        )
                )
                .shadow(color: Color.black.opacity(0.10), radius: 10, y: 5)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.white.opacity(fillOpacity))
        }
    }
}

private struct StandardSessionCardSurface: ViewModifier {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    private let cornerRadius: CGFloat = 18
    private let glassStrength: Double = 0.55

    private var fillOpacity: Double {
        0.12 + glassStrength * 0.12
    }

    private var strokeOpacity: Double {
        0.18 + glassStrength * 0.14
    }

    func body(content: Content) -> some View {
        if isLiquidGlass {
            content
                .background(
                    LiquidGlassCardBackground(cornerRadius: cornerRadius, fillOpacity: fillOpacity)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(strokeOpacity), lineWidth: 1)
                }
        } else {
            // 原生（Sessions Tab）：去掉卡片外壳，退回普通行
            content
        }
    }
}

extension View {
    func standardSessionCardSurface() -> some View {
        modifier(StandardSessionCardSurface())
    }
}
