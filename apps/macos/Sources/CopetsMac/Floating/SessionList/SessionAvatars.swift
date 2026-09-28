import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct AgentAvatarView: View {
    @ObservedObject private var client = EntityAPIClient.shared

    let session: TaskSession
    let size: CGFloat
    var showsChrome = true

    // 会话统一继承其绑定 Agent 的头像：优先使用 Agent 自定义头像，否则用 Agent 级派生渐变+首字母。
    private var boundAgent: Agent? {
        guard let agentId = session.agentId, !agentId.isEmpty else { return nil }
        return client.agents.first { $0.agentId == agentId }
    }

    var body: some View {
        Group {
            if let avatarPath = boundAgent?.avatarPath, !avatarPath.isEmpty {
                AnimatedAvatarImage(path: avatarPath)
                    .background(Color.white.opacity(0.16))
            } else {
                DefaultInitialAvatarView(
                    familySeed: familySeed,
                    variationSeed: variationSeed,
                    initials: initials,
                    size: size
                )
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay {
            if showsChrome {
                Circle().strokeBorder(Color.white.opacity(0.26), lineWidth: 1)
            }
        }
        .shadow(color: Color.black.opacity(showsChrome ? 0.08 : 0), radius: showsChrome ? 6 : 0, y: showsChrome ? 3 : 0)
    }

    // 同一 Agent 下所有会话共用同一种子（familySeed = agent 名，variationSeed = agentId），保证头像一致。
    private var familySeed: String {
        boundAgent?.name ?? session.agent
    }

    private var variationSeed: String {
        boundAgent?.agentId ?? session.agentId ?? session.agent
    }

    private var initials: String {
        if let agent = boundAgent {
            return DefaultAvatarInitials.make(from: agent.name)
        }
        let words = session.agent
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
            .compactMap { $0.first }
        let value = String(words).uppercased()
        return value.isEmpty ? "A" : value
    }
}

struct SessionAvatarView: View {
    let session: TaskSession
    let avatarSize: CGFloat

    private var scale: CGFloat {
        avatarSize / 52
    }

    private var renderSize: CGFloat {
        72 * scale
    }

    var body: some View {
        ZStack {
            StatusHalo(status: session.executionTaskStatus)
                .frame(width: 72, height: 72)
                .scaleEffect(scale)

            AgentAvatarView(session: session, size: avatarSize, showsChrome: false)

            ConnectionIndicatorLight(
                color: session.connectionColor,
                size: 8 * scale,
                glowSize: 17 * scale,
                isBreathing: session.isConnecting
            )
            .offset(x: 21 * scale, y: -21 * scale)
        }
        .frame(width: renderSize, height: renderSize)
        .transaction { transaction in
            transaction.animation = nil
        }
    }
}

struct AnimatedAvatarImage: NSViewRepresentable {
    let path: String

    func makeNSView(context: Context) -> AspectFillAnimatedImageView {
        AspectFillAnimatedImageView()
    }

    func updateNSView(_ imageView: AspectFillAnimatedImageView, context: Context) {
        imageView.image = AvatarImageSupport.loadImage(at: path)
    }

    final class AspectFillAnimatedImageView: NSView {
        private let imageView = NSImageView()
        private var imageSize: CGSize = .zero

        var image: NSImage? {
            didSet {
                imageView.image = image
                imageView.animates = true
                imageSize = image?.size ?? .zero
                needsLayout = true
            }
        }

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            wantsLayer = true
            layer?.masksToBounds = true
            imageView.imageAlignment = .alignCenter
            imageView.imageScaling = .scaleAxesIndependently
            imageView.animates = true
            addSubview(imageView)
        }

        required init?(coder: NSCoder) {
            nil
        }

        override func layout() {
            super.layout()
            guard bounds.width > 0, bounds.height > 0, imageSize.width > 0, imageSize.height > 0 else {
                imageView.frame = bounds
                return
            }

            let scale = max(bounds.width / imageSize.width, bounds.height / imageSize.height)
            let scaledSize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
            imageView.frame = CGRect(
                x: (bounds.width - scaledSize.width) / 2,
                y: (bounds.height - scaledSize.height) / 2,
                width: scaledSize.width,
                height: scaledSize.height
            )
        }
    }
}
