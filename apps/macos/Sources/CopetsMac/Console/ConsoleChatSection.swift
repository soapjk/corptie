import SwiftUI

/// One source-list section for both navigation modes, including empty and reveal rows.
@MainActor enum ConsoleChatSection {
    static func group(header: AnyView, rows: [SessionRowModel], showsAll: Bool,
                      searching: Bool = false) -> ConsoleNativeOutlineGroup<ConsoleNativeOutlineEntry> {
        let count = ConsoleChatPreviewPolicy.visibleCount(total: rows.count, showsAll: showsAll || searching)
        var entries = rows.prefix(count).map { ConsoleNativeOutlineEntry.session($0) }
        if entries.isEmpty { entries = [.empty("assistant-empty", L10n("No Assistant Sessions"))] }
        if !searching, rows.count > 5 { entries.append(.moreChats) }
        return .init(id: "assistant", header: header, rows: entries, isExpanded: true,
            usesSectionStyle: true, allowsCollapse: false, showsDisclosureIndicator: false,
            structureRevision: entries.count, chatPreviewExpanded: showsAll)
    }
}

struct ConsoleChatPreviewButton: View {
    let showsAll: Bool
    let toggle: () -> Void
    var body: some View {
        Button(L10n(showsAll ? "收起" : "展示更多"), action: toggle)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
            .buttonStyle(.plain)
            .accessibilityIdentifier("console.chat.show-more")
    }
}
