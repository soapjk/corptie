import SwiftUI
import CorptieClientCore
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif

/// Shared visual body for ordinary text messages. TextKit, Markdown parsing,
/// measurement, link handling and clipboard access are injected platform leaves.
/// No workspace observation, network calls, timers or implicit animations.
public struct MessageTextCard<Content: View>: View {
    public enum Role: Sendable { case user, agent }
    private let role: Role
    private let messageID: String
    private let timestamp: String
    private let showsActions: Bool
    private let actionsAlwaysVisible: Bool
    private let cardWidth: CGFloat?
    private let cardHeight: CGFloat?
    private let status: UserMessageStatusPresentation?
    private let copy: () -> Void
    private let content: Content
    @State private var hovering = false
    @State private var showingStatusDetail = false

    public init(messageID: String, role: Role, timestamp: String, showsActions: Bool,
                actionsAlwaysVisible: Bool, cardWidth: CGFloat? = nil, cardHeight: CGFloat? = nil,
                status: UserMessageStatusPresentation? = nil,
                copy: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.messageID = messageID; self.role = role; self.timestamp = timestamp; self.showsActions = showsActions
        self.actionsAlwaysVisible = actionsAlwaysVisible
        self.cardWidth = cardWidth; self.cardHeight = cardHeight
        self.status = status
        self.copy = copy; self.content = content()
    }

    public var body: some View {
        VStack(alignment: role == .user ? .trailing : .leading, spacing: 2) {
            content
                .padding(10)
                .frame(width: cardWidth, height: cardHeight, alignment: .topLeading)
                .background {
                    // Shadow the card silhouette, never the embedded platform text view.
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(background)
                        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 3)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(border, lineWidth: 1)
                }
            if showsActions || status != nil {
                HStack(spacing: 6) {
                    if let status {
                        Button { showingStatusDetail = true } label: {
                            Label {
                                if (cardWidth ?? MessageBubbleWidthPolicy.maximumWidth) >= 120 {
                                    Text(status.shortLabel(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                                        .lineLimit(1)
                                }
                            } icon: {
                                Image(systemName: status.symbolName)
                            }
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(statusColor(status.tone))
                        }
                        .buttonStyle(.plain)
                        .help(status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                        .accessibilityLabel(status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                        .accessibilityIdentifier("message-processing-state")
                        .popover(isPresented: $showingStatusDetail) {
                            Text(status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                                .font(.caption)
                                .padding(12)
                                .frame(maxWidth: 260, alignment: .leading)
                        }
                    }
                    if showsActions {
                        if !timestamp.isEmpty && status == nil {
                            Text(timestamp).font(.system(size: 9, weight: .medium))
                                .foregroundStyle(Color(red: 0.38, green: 0.41, blue: 0.43))
                                .lineLimit(1)
                        }
                        Button(action: copy) {
                            Image(systemName: "doc.on.doc").frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain)
                        .help("复制消息")
                        .accessibilityLabel("复制消息")
                        .accessibilityIdentifier("chat.timeline.copy")
                        .opacity(actionsAlwaysVisible || hovering ? 1 : 0)
                        .accessibilityHidden(!actionsAlwaysVisible && !hovering)
                    }
                }
                .padding(.horizontal, 2)
                .frame(height: 22)
            }
        }
        .frame(idealWidth: cardWidth, maxWidth: cardWidth ?? MessageBubbleWidthPolicy.maximumWidth,
               alignment: role == .user ? .trailing : .leading)
        .onHover { hovering = $0 }
        .onChange(of: messageID) { hovering = false }
    }

    private var background: Color {
        #if canImport(AppKit)
        let surface = Color(nsColor: .controlBackgroundColor)
        #else
        let surface = Color(uiColor: .secondarySystemBackground)
        #endif
        return role == .user ? Color.accentColor.opacity(0.1) : surface
    }
    private var border: Color {
        role == .user ? Color.accentColor.opacity(0.3) : Color.primary.opacity(0.08)
    }

    private func statusColor(_ tone: UserMessageStatusPresentation.Tone) -> Color {
        switch tone {
        case .neutral: .secondary
        case .amber: .orange
        case .green: .green
        case .red: .red
        }
    }
}
