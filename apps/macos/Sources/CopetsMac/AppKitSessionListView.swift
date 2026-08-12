import AppKit
import SwiftUI

struct AppKitSessionListRow: Identifiable {
    let id: String
    let sessionID: String?
    let contentRevision: Int
    let content: AnyView
}

/// Native virtualization shell for the session browser. The existing SwiftUI
/// card remains the row content, while NSTableView owns reuse, scrolling and
/// row geometry so off-screen cards do not stay in the active render tree.
struct AppKitSessionListView: NSViewRepresentable {
    let rows: [AppKitSessionListRow]
    let rowSpacing: CGFloat
    let onGeometryChange: ([String: CGRect], CGRect, CGRect, CGFloat) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onGeometryChange: onGeometryChange)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let tableView = IntrinsicSessionListTableView()
        tableView.style = .plain
        tableView.headerView = nil
        tableView.backgroundColor = .clear
        tableView.gridStyleMask = []
        tableView.intercellSpacing = NSSize(width: 0, height: rowSpacing)
        tableView.rowHeight = 88
        tableView.usesAutomaticRowHeights = true
        tableView.selectionHighlightStyle = .none
        tableView.allowsEmptySelection = true
        tableView.focusRingType = .none
        tableView.columnAutoresizingStyle = .noColumnAutoresizing

        let column = NSTableColumn(identifier: Coordinator.columnIdentifier)
        column.resizingMask = []
        tableView.addTableColumn(column)

        let scrollView = SessionListScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .legacy
        scrollView.verticalScroller?.controlSize = .small
        scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: -2)
        scrollView.borderType = .noBorder
        scrollView.documentView = tableView

        context.coordinator.attach(tableView: tableView, scrollView: scrollView)
        context.coordinator.apply(rows: rows, rowSpacing: rowSpacing)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.onGeometryChange = onGeometryChange
        context.coordinator.apply(rows: rows, rowSpacing: rowSpacing)
    }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        static let columnIdentifier = NSUserInterfaceItemIdentifier("session.list.column")
        private static let cellIdentifier = NSUserInterfaceItemIdentifier("session.list.hosting.cell")

        var onGeometryChange: ([String: CGRect], CGRect, CGRect, CGFloat) -> Void
        private weak var tableView: NSTableView?
        private weak var scrollView: NSScrollView?
        private var rows: [AppKitSessionListRow] = []
        private var revisionsByID: [String: Int] = [:]
        private var geometryPublishScheduled = false

        init(onGeometryChange: @escaping ([String: CGRect], CGRect, CGRect, CGFloat) -> Void) {
            self.onGeometryChange = onGeometryChange
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        func attach(tableView: NSTableView, scrollView: NSScrollView) {
            self.tableView = tableView
            self.scrollView = scrollView
            tableView.dataSource = self
            tableView.delegate = self
            tableView.postsFrameChangedNotifications = true
            scrollView.postsFrameChangedNotifications = true
            scrollView.contentView.postsBoundsChangedNotifications = true

            NotificationCenter.default.addObserver(
                self,
                selector: #selector(viewportGeometryDidChange(_:)),
                name: NSView.boundsDidChangeNotification,
                object: scrollView.contentView
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(viewportGeometryDidChange(_:)),
                name: NSView.frameDidChangeNotification,
                object: scrollView
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(tableGeometryDidChange(_:)),
                name: NSView.frameDidChangeNotification,
                object: tableView
            )
            if let table = tableView as? IntrinsicSessionListTableView {
                table.didLayout = { [weak self] in self?.scheduleGeometryPublish() }
            }
            synchronizeTableWidth()
        }

        func numberOfRows(in tableView: NSTableView) -> Int {
            rows.count
        }

        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            -1
        }

        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let cell = (tableView.makeView(withIdentifier: Self.cellIdentifier, owner: nil) as? SessionListHostingCell)
                ?? SessionListHostingCell(identifier: Self.cellIdentifier)
            cell.setContent(rows[row].content)
            return cell
        }

        func apply(rows nextRows: [AppKitSessionListRow], rowSpacing: CGFloat) {
            guard let tableView else {
                rows = nextRows
                revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })
                return
            }
            synchronizeTableWidth()
            let oldIDs = rows.map(\.id)
            let nextIDs = nextRows.map(\.id)
            let oldRevisions = revisionsByID
            rows = nextRows
            revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })

            let spacing = NSSize(width: 0, height: rowSpacing)
            let spacingChanged = tableView.intercellSpacing != spacing
            if spacingChanged { tableView.intercellSpacing = spacing }

            guard oldIDs == nextIDs, !spacingChanged else {
                tableView.reloadData()
                scheduleGeometryPublish()
                return
            }

            let changed = IndexSet(nextRows.indices.filter {
                oldRevisions[nextRows[$0].id] != nextRows[$0].contentRevision
            })
            if !changed.isEmpty {
                tableView.reloadData(
                    forRowIndexes: changed,
                    columnIndexes: IndexSet(integer: 0)
                )
                tableView.noteHeightOfRows(withIndexesChanged: changed)
            }
            scheduleGeometryPublish()
        }

        private func synchronizeTableWidth() {
            guard let tableView, let scrollView, let column = tableView.tableColumns.first else { return }
            let width = max(120, scrollView.contentSize.width)
            guard abs(column.width - width) >= 0.5 else { return }
            column.width = width
            if !rows.isEmpty { tableView.reloadData() }
            scheduleGeometryPublish()
        }

        private func scheduleGeometryPublish() {
            guard !geometryPublishScheduled else { return }
            geometryPublishScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.geometryPublishScheduled = false
                self.publishGeometry()
            }
        }

        private func publishGeometry() {
            guard let tableView, let scrollView else { return }
            var sessionFrames: [String: CGRect] = [:]
            for (index, row) in rows.enumerated() {
                guard let sessionID = row.sessionID, index < tableView.numberOfRows else { continue }
                sessionFrames[sessionID] = scrollView.convert(tableView.rect(ofRow: index), from: tableView)
            }
            let contentRect = scrollView.convert(tableView.bounds, from: tableView)
            let viewportRect = scrollView.bounds
            let contentHeight = tableView.bounds.height
            onGeometryChange(sessionFrames, contentRect, viewportRect, contentHeight)
            updateVerticalScrollerVisibility(contentHeight: contentHeight)
        }

        private func updateVerticalScrollerVisibility(contentHeight: CGFloat) {
            guard let scrollView else { return }
            let shouldShow = contentHeight > scrollView.contentView.bounds.height + 1
            if scrollView.hasVerticalScroller != shouldShow { scrollView.hasVerticalScroller = shouldShow }
            scrollView.verticalScroller?.isHidden = !shouldShow
        }

        @objc private func viewportGeometryDidChange(_ notification: Notification) {
            synchronizeTableWidth()
            scheduleGeometryPublish()
        }

        @objc private func tableGeometryDidChange(_ notification: Notification) {
            scheduleGeometryPublish()
        }
    }
}

@MainActor
private final class SessionListHostingCell: NSTableCellView {
    private let hostingView = IntrinsicSessionListHostingView(rootView: AnyView(EmptyView()))

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.sizingOptions = [.intrinsicContentSize]
        hostingView.setContentHuggingPriority(.required, for: .vertical)
        hostingView.setContentCompressionResistancePriority(.required, for: .vertical)
        addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setContent(_ content: AnyView) {
        hostingView.rootView = AnyView(
            content
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .fixedSize(horizontal: false, vertical: true)
        )
        hostingView.invalidateIntrinsicContentSize()
    }
}

private final class IntrinsicSessionListHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private final class IntrinsicSessionListTableView: NSTableView {
    var didLayout: (() -> Void)?

    override func layout() {
        super.layout()
        didLayout?()
    }
}

private final class SessionListScrollView: NSScrollView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
