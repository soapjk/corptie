import SwiftUI

/// One source-list section for both navigation modes, including empty and reveal rows.
@MainActor enum ConsoleChatSection {
    static let rowHeight: CGFloat = 26
    static let headerHeight: CGFloat = 24
    static let leadingInset: CGFloat = 16

    static func group(header: AnyView, rows: [SessionRowModel], showsAll: Bool,
                      searching: Bool = false) -> ConsoleNativeOutlineGroup<ConsoleNativeOutlineEntry> {
        let count = ConsoleChatPreviewPolicy.visibleCount(total: rows.count, showsAll: showsAll || searching)
        var entries = rows.prefix(count).map { ConsoleNativeOutlineEntry.session($0) }
        if entries.isEmpty { entries = [.empty("assistant-empty", L10n("No Assistant Sessions"))] }
        if !searching, rows.count > 5 { entries.append(.moreChats) }
        return .init(id: "assistant", header: header, rows: entries, isExpanded: true,
            usesSectionStyle: true, allowsCollapse: false, showsDisclosureIndicator: false,
            structureRevision: entries.count, chatPreviewExpanded: showsAll,
            rowHeight: { _ in Self.rowHeight }, headerHeight: Self.headerHeight)
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

/// Shared row wrapper so neither navigation mode adds a separate List inset.
struct ConsoleChatSessionRow<MenuContent: View>: View {
    let row: SessionRowModel
    let isActive: Bool
    let isSelected: Bool
    let select: (TaskSession) -> Void
    @ViewBuilder var menuContent: (TaskSession, Binding<Bool>) -> MenuContent
    var body: some View {
        ConsoleSessionRow(showsHoverFeedback: false, isActive: isActive,
            row: row, selectionRequested: select, menuContent: menuContent)
            .consoleOutlineRowSurface(isSelected: isSelected, leadingInset: ConsoleChatSection.leadingInset,
                nativeRowHeight: ConsoleChatSection.rowHeight)
    }
}
