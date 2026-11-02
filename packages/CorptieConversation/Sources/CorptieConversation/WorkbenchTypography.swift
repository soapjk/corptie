import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Interface text roles. Transcript reading metrics remain in ConversationTypography.
public enum WorkbenchTypography {
    public enum Role: Sendable {
        case pageTitle, sectionTitle, cardTitle, body, help, metadata, technical
        case composerInput, compactComposerInput
        case navigation, navigationHeading, conversationTitle, conversationMetadata
    }

    public static func font(for role: Role) -> Font {
        switch role {
        case .pageTitle: .title2.weight(.semibold)
        case .sectionTitle: .title3.weight(.semibold)
        case .cardTitle: .headline
        case .body: .body
        case .help: .callout
        case .metadata: .subheadline
        case .technical: .system(size: 12, design: .monospaced)
        case .navigation: .system(size: 13, weight: .regular)
        case .navigationHeading: .system(size: 12, weight: .medium)
        case .conversationTitle: .system(size: 14, weight: .medium)
        case .conversationMetadata: .system(size: 12, weight: .regular)
        case .composerInput: .system(size: 14)
        case .compactComposerInput: .system(size: 12)
        }
    }

    #if os(macOS)
    public static func nativeFont(for role: Role) -> NSFont {
        switch role {
        case .navigation: .systemFont(ofSize: 13, weight: .regular)
        case .navigationHeading: .systemFont(ofSize: 12, weight: .medium)
        case .conversationTitle: .systemFont(ofSize: 14, weight: .medium)
        case .conversationMetadata: .systemFont(ofSize: 12, weight: .regular)
        case .composerInput: .systemFont(ofSize: 14, weight: .regular)
        case .compactComposerInput: .systemFont(ofSize: 12, weight: .regular)
        case .technical: .monospacedSystemFont(ofSize: 12, weight: .regular)
        default: .preferredFont(forTextStyle: nativeStyle(for: role), options: [:])
        }
    }

    private static func nativeStyle(for role: Role) -> NSFont.TextStyle {
        switch role {
        case .pageTitle: .title2
        case .sectionTitle: .title3
        case .cardTitle: .headline
        case .help: .callout
        case .metadata: .subheadline
        default: .body
        }
    }
    #endif
}
