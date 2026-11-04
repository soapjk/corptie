import AppKit
import SwiftUI

/// Hide only the disclosure geometry, retaining AppKit's collapse capability.
/// Returning false from shouldShowOutlineCellForItem also disables collapse
/// paths in AppKit; Work headers supply their own folder toggle instead.
final class ConsoleNativeOutlineView: NSOutlineView {
    var showsDisclosure: (Any) -> Bool = { _ in true }
    override func frameOfOutlineCell(atRow row: Int) -> NSRect {
        if row >= 0, row < numberOfRows, let item = item(atRow: row), !showsDisclosure(item) { return .zero }
        return super.frameOfOutlineCell(atRow: row)
    }
}

/// Plain SwiftUI buttons otherwise consume an inactive window's first click
/// just activating the window. Keep row reuse and first-click navigation alike.
private final class ConsoleOutlineHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// AppKit owns row reuse, disclosure geometry and animation. SwiftUI supplies
/// the existing row controls; no animated height or presentation state is kept.
struct ConsoleNativeOutlineGroup<Row: Identifiable> where Row.ID == String {
    let id: String
    let header: AnyView
    var rows: [Row] = []
    var isExpanded = false
    var isSection = false
    var allowsCollapse = true
    var showsDisclosureIndicator = true
    var expansionChanged: (Bool) -> Void = { _ in }
    var structureRevision: Int = 0
    var dataRevision: Int = 0
    var childRows: (Row) -> [Row] = { _ in [] }
    var rowIsExpanded: (Row) -> Bool = { _ in false }
    var rowExpansionChanged: (Row, Bool) -> Void = { _, _ in }
    var rowIsExpandable: (Row) -> Bool = { _ in false }
}

struct ConsoleNativeOutline<Row: Identifiable, Content: View>: View where Row.ID == String {
    let groups: () -> [ConsoleNativeOutlineGroup<Row>]
    @ViewBuilder let rowContent: (Row) -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ConsoleNativeOutlineBridge(groups: groups(), reduceMotion: reduceMotion, rowContent: rowContent)
    }
}

private struct ConsoleNativeOutlineBridge<Row: Identifiable, Content: View>: NSViewRepresentable where Row.ID == String {
    let groups: [ConsoleNativeOutlineGroup<Row>]
    let reduceMotion: Bool
    let rowContent: (Row) -> Content

    @MainActor final class Node: NSObject {
        let id: String
        var group: ConsoleNativeOutlineGroup<Row>?
        var row: Row?
        var children: [Node] = []
        weak var owner: Node?
        var loadedRevision: Int?
        init(id: String) { self.id = id }
    }

    @MainActor final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
        var parent: ConsoleNativeOutlineBridge
        var roots: [Node] = []
        var applyingExpansion = false

        init(_ parent: ConsoleNativeOutlineBridge) { self.parent = parent }

        func update(_ outline: NSOutlineView, initial: Bool = false) {
            let oldRoots = Dictionary(uniqueKeysWithValues: roots.map { ($0.id, $0) })
            let rootIDsChanged = roots.map(\.id) != parent.groups.map(\.id)
            var changedChildren: [Node] = []
            roots = parent.groups.map { group in
                let node = oldRoots[group.id] ?? Node(id: group.id)
                let oldChildren = Dictionary(uniqueKeysWithValues: node.children.map { ($0.id, $0) })
                let children = group.rows.map { row in
                    let child = oldChildren[row.id] ?? Node(id: row.id)
                    child.row = row
                    child.owner = node
                    return child
                }
                if node.children.map(\.id) != children.map(\.id) || node.group?.structureRevision != group.structureRevision { changedChildren.append(node) }
                node.group = group
                node.children = children
                return node
            }
            applyingExpansion = true
            defer { applyingExpansion = false }
            if rootIDsChanged {
                outline.reloadData()
            } else {
                for node in changedChildren where outline.isItemExpanded(node) {
                    outline.reloadItem(node, reloadChildren: true)
                }
            }
            func reconcile(_ node: Node) {
                let group = node.group ?? node.owner?.group
                guard let group, !group.isSection else { return }
                let expanded = node.row.map(group.rowIsExpanded) ?? group.isExpanded
                if outline.isItemExpanded(node) != expanded {
                    let target = initial || rootIDsChanged || parent.reduceMotion ? outline : outline.animator()
                    if expanded { target.expandItem(node) } else { target.collapseItem(node) }
                }
                if expanded {
                    synchronizeChildren(node)
                    for child in node.children where child.row.map(group.rowIsExpandable) == true { reconcile(child) }
                }
            }
            for node in roots { reconcile(node) }
            // Refresh only mounted cells. Updating status never reloads the tree
            // or constructs views for offscreen rows.
            let visible = outline.rows(in: outline.visibleRect)
            guard visible.location != NSNotFound else { return }
            for index in visible.location..<min(outline.numberOfRows, NSMaxRange(visible)) {
                guard let node = outline.item(atRow: index) as? Node,
                      let host = outline.view(atColumn: 0, row: index, makeIfNecessary: false) as? NSHostingView<AnyView> else { continue }
                host.rootView = content(for: node)
            }
        }

        func content(for node: Node) -> AnyView {
            if let group = node.group {
                return AnyView(group.header.id(node.id).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading))
            }
            if let row = node.row {
                return AnyView(parent.rowContent(row).id(node.id).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading))
            }
            return AnyView(EmptyView())
        }

        private func synchronizeChildren(_ node: Node) {
            guard let row = node.row, let owner = node.owner, let group = owner.group else { return }
            guard node.loadedRevision != group.dataRevision else { return }
            node.loadedRevision = group.dataRevision
            let previous = Dictionary(uniqueKeysWithValues: node.children.map { ($0.id, $0) })
            node.children = group.childRows(row).map { row in
                let child = previous[row.id] ?? Node(id: row.id)
                child.row = row
                child.owner = owner
                return child
            }
        }

        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
            guard let node = item as? Node else { return roots.count }
            synchronizeChildren(node)
            return node.children.count
        }

        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
            (item as? Node)?.children[index] ?? roots[index]
        }

        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
            guard let node = item as? Node else { return false }
            if let group = node.group { return !group.isSection }
            guard let row = node.row, let group = node.owner?.group else { return false }
            return group.rowIsExpandable(row)
        }

        func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool {
            (item as? Node)?.group?.isSection == true
        }

        func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { false }

        func outlineView(_ outlineView: NSOutlineView, shouldCollapseItem item: Any) -> Bool {
            (item as? Node)?.group?.allowsCollapse ?? true
        }

        func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
            guard let node = item as? Node else { return nil }
            let identifier = NSUserInterfaceItemIdentifier(node.group == nil ? "row" : "header")
            let host = outlineView.makeView(withIdentifier: identifier, owner: nil) as? NSHostingView<AnyView>
                ?? ConsoleOutlineHostingView(rootView: content(for: node))
            host.identifier = identifier
            host.sizingOptions = []
            host.rootView = content(for: node)
            return host
        }

        func outlineViewItemDidExpand(_ notification: Notification) { expansionChanged(notification, expanded: true) }
        func outlineViewItemDidCollapse(_ notification: Notification) { expansionChanged(notification, expanded: false) }

        private func expansionChanged(_ notification: Notification, expanded: Bool) {
            guard !applyingExpansion,
                  let node = notification.userInfo?["NSObject"] as? Node else { return }
            if let row = node.row { node.owner?.group?.rowExpansionChanged(row, expanded) }
            else { node.group?.expansionChanged(expanded) }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let outline = ConsoleNativeOutlineView()
        outline.showsDisclosure = { ($0 as? Node)?.group?.showsDisclosureIndicator ?? true }
        let column = NSTableColumn(identifier: .init("content"))
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .sourceList
        outline.rowHeight = 30
        outline.intercellSpacing = .init(width: 0, height: 2)
        outline.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        outline.selectionHighlightStyle = .none
        outline.floatsGroupRows = false
        outline.backgroundColor = .clear
        outline.dataSource = context.coordinator
        outline.delegate = context.coordinator
        let scroll = WorkOutlineScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.verticalScroller = WorkOutlineThinScroller()
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.documentView = outline
        (scroll.verticalScroller as? WorkOutlineThinScroller)?.bindScrollActivity(to: scroll)
        context.coordinator.update(outline, initial: true)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let outline = nsView.documentView as? NSOutlineView else { return }
        context.coordinator.update(outline)
    }
}
