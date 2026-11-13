import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// One provider badge for the session header, sidebar rows and reply headers.
/// Inputs are value-only, so native timeline cells never observe the catalog.
struct ProviderBrandLabel: View {
    let iconAsset: String?
    let label: String
    var iconSize: CGFloat = 13
    var spacing: CGFloat = 2
    var foreground: Color = .primary
    var font: Font? = nil
    /// Icon-only variants keep the provider name in the tooltip and accessibility label.
    var showsLabel = true

    var body: some View {
        if showsLabel {
            badge
        } else {
            badge
                .help(label)
                .accessibilityLabel(Text(label))
        }
    }

    private var badge: some View {
        HStack(spacing: spacing) {
            Group {
                if let iconAsset,
                   let icon = ProviderBrandIcon.image(for: iconAsset, providers: []) {
                    Image(nsImage: icon).resizable().interpolation(.high)
                } else {
                    Image(systemName: "cpu")
                }
            }
            .foregroundStyle(foreground)
            .frame(width: iconSize, height: iconSize)
            .accessibilityHidden(showsLabel)
            if showsLabel {
                Text(label)
                    .font(font)
                    .foregroundStyle(foreground)
                    .lineLimit(1)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}

@MainActor
enum ProviderBrandIcon {
    // Bundled local copies of the Codex app icon (Product Hunt listing), the
    // Anthropic-published Claude Code VS Code icon, and OpenClacky's project icon.
    // Decode once per Provider so session-list scrolling does not reload images.
    private static let codex = load("codex")
    private static let claudeCode = load("claude-code")
    private static let openClacky = load("openclacky")

    static func assetName(for identity: String?, providers: [AgentProviderDescriptor]) -> String? {
        let canonical = providers.canonicalProviderId(for: identity)
            ?? identity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch canonical?.lowercased() {
        case "codex-app-server", "codex": return "codex"
        case "claude-sdk", "claude", "claude-code", "claude_code", "claude code": return "claude-code"
        case "openclacky", "clacky", "open-clacky": return "openclacky"
        default: return nil
        }
    }

    static func image(for identity: String?, providers: [AgentProviderDescriptor], resourceBundle: Bundle? = nil) -> NSImage? {
        if let resourceBundle {
            guard let name = assetName(for: identity, providers: providers) else { return nil }
            return load(name, bundle: resourceBundle)
        }
        switch assetName(for: identity, providers: providers) {
        case "codex": return codex
        case "claude-code": return claudeCode
        case "openclacky": return openClacky
        default: return nil
        }
    }

    private static func load(_ name: String, bundle: Bundle = AppResourceBundle.bundle) -> NSImage? {
        guard let url = bundle.url(
            forResource: name,
            withExtension: "png",
            subdirectory: "ProviderIcons"
        ) else { return nil }
        return NSImage(contentsOf: url)
    }
}

func sessionProviderIdentityLabel(
    providerIdentity: String?,
    legacyAgentLabel: String,
    providers: [AgentProviderDescriptor]
) -> String {
    let identity = providerIdentity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !identity.isEmpty else { return legacyAgentLabel }
    return providers.displayName(for: identity) ?? identity
}

