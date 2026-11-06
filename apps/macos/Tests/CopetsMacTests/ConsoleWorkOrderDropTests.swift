import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class ConsoleWorkOrderDropTests: XCTestCase {
    private struct Entry: Identifiable { let id: String }
    private struct Surface: View {
        @ObservedObject var store: ConsoleOutlineProjectionStore
        var body: some View {
            ConsoleNativeOutline(groups: {
                [ConsoleNativeOutlineGroup<Entry>(id: "assistant", header: AnyView(Text("Chat"))),
                 ConsoleNativeOutlineGroup<Entry>(id: "heading", header: AnyView(Text("Projects")), isSection: true)]
                + store.prepared.works.map { work in
                    ConsoleNativeOutlineGroup(id: work.id, header: AnyView(Text(work.name)),
                        rows: [Entry(id: "task:\(work.id)")], isExpanded: true,
                        workOrderDrop: { source, after in
                            store.moveWork(source, relativeTo: work.id, after: after)
                        })
                }
            }) { entry in Text(entry.id) }
        }
    }

    func testNativeDropCommitsWorkOrderAndRestoresItWithoutRebuildingTasks() async throws {
        _ = NSApplication.shared
        let suite = "ConsoleWorkOrderDropTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConsoleOutlineProjectionStore(defaults: defaults)
        let works = ["a", "b", "c"].map {
            Work(id: $0, workspaceId: "workspace:test", name: $0, description: "", status: "active",
                profile: "", tags: [], contributorRoleIds: [], createdAt: "", updatedAt: "")
        }
        await store.prepare(key: .init(entityRevision: 1, sessionRevision: 0, search: "", sort: .standard),
            tasks: [], works: works, sessions: [])
        let count = store.computationCount
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: Surface(store: store))
        window.contentView = host
        defer { window.contentView = nil }
        host.layoutSubtreeIfNeeded()
        let outline = try XCTUnwrap(findOutline(host))
        XCTAssertTrue(outline.registeredDraggedTypes.contains(.init(ConsoleWorkOrderDragItem.typeIdentifier)))
        let dataSource = try XCTUnwrap(outline.dataSource)
        let first = try XCTUnwrap(outline.item(atRow: 2))
        let last = try XCTUnwrap(outline.item(atRow: 6))
        let info = DragInfo(window: window, sourceID: "c")
        info.draggingLocation = outline.convert(NSPoint(x: 50, y: outline.rect(ofRow: 2).minY + 2), to: nil)
        XCTAssertEqual(dataSource.outlineView?(outline, validateDrop: info,
            proposedItem: first, proposedChildIndex: -1), .move)
        XCTAssertEqual(store.prepared.works.map(\.id), ["a", "b", "c"], "Hover must not commit or persist")
        XCTAssertEqual(dataSource.outlineView?(outline, acceptDrop: info, item: nil, childIndex: 2), true)
        XCTAssertEqual(store.prepared.works.map(\.id), ["c", "a", "b"])
        host.layoutSubtreeIfNeeded()
        // Let SwiftUI submit the published root order to the native outline.
        try await Task.sleep(for: .milliseconds(30))
        host.layoutSubtreeIfNeeded()
        XCTAssertTrue((outline.item(atRow: 2) as AnyObject?) === (last as AnyObject),
            "The native visible root order must change, not only the store")
        XCTAssertTrue(outline.isItemExpanded(first), "Existing Work disclosure state survives the move")
        XCTAssertEqual(store.computationCount, count)

        // Root insertion after the final expanded Work is a valid downward move.
        XCTAssertEqual(dataSource.outlineView?(outline, validateDrop: info, proposedItem: nil, proposedChildIndex: 5), .move)
        XCTAssertEqual(dataSource.outlineView?(outline, acceptDrop: info, item: nil, childIndex: 5), true)
        XCTAssertEqual(store.prepared.works.map(\.id), ["a", "b", "c"])
        let restored = ConsoleOutlineProjectionStore(defaults: defaults)
        await restored.prepare(key: .init(entityRevision: 2, sessionRevision: 0, search: "", sort: .updated),
            tasks: [], works: works.reversed(), sessions: [])
        XCTAssertEqual(restored.prepared.works.map(\.id), ["a", "b", "c"])

        for invalid in [DragInfo(window: window, sourceID: "unknown"), DragInfo(window: window, sourceID: "task:a")] {
            XCTAssertEqual(dataSource.outlineView?(outline, validateDrop: invalid, proposedItem: nil, proposedChildIndex: 2), [])
            XCTAssertEqual(dataSource.outlineView?(outline, acceptDrop: invalid, item: nil, childIndex: 2), false)
        }
        XCTAssertEqual(dataSource.outlineView?(outline, validateDrop: info,
            proposedItem: outline.item(atRow: 0), proposedChildIndex: -1), [])

        // Transferable sources may advertise copy rather than native move.
        info.draggingSourceOperationMask = .copy
        XCTAssertEqual(dataSource.outlineView?(outline, validateDrop: info,
            proposedItem: nil, proposedChildIndex: 2), .copy)
        info.draggingPasteboard.clearContents()
        info.draggingPasteboard.setString("c", forType: .string)
        XCTAssertEqual(dataSource.outlineView?(outline, validateDrop: info,
            proposedItem: nil, proposedChildIndex: 2), [])
        let items = ["a", "c"].map { id in
            let item = NSPasteboardItem()
            item.setData(Data(id.utf8), forType: .init(ConsoleWorkOrderDragItem.typeIdentifier))
            return item
        }
        info.draggingPasteboard.clearContents()
        info.draggingPasteboard.writeObjects(items)
        XCTAssertEqual(dataSource.outlineView?(outline, acceptDrop: info, item: nil, childIndex: 2), false)
    }

    private func findOutline(_ view: NSView) -> NSOutlineView? {
        if let outline = view as? NSOutlineView { return outline }
        return view.subviews.lazy.compactMap(findOutline).first
    }

    @MainActor private final class DragInfo: NSObject, NSDraggingInfo {
        let draggingDestinationWindow: NSWindow?
        let draggingPasteboard = NSPasteboard.withUniqueName()
        var draggingSourceOperationMask: NSDragOperation = [.move, .copy]
        var draggingLocation = NSPoint.zero
        var draggedImageLocation: NSPoint { .zero }
        nonisolated var draggedImage: NSImage? { nil }
        var draggingSource: Any? { draggingDestinationWindow }
        var draggingSequenceNumber: Int { 1 }
        var draggingFormation: NSDraggingFormation = .none
        var animatesToDestination = false
        var numberOfValidItemsForDrop = 1
        var springLoadingHighlight: NSSpringLoadingHighlight { .none }
        init(window: NSWindow, sourceID: String) {
            draggingDestinationWindow = window
            super.init()
            draggingPasteboard.setData(Data(sourceID.utf8), forType: .init(ConsoleWorkOrderDragItem.typeIdentifier))
        }
        func slideDraggedImage(to screenPoint: NSPoint) {}
        func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions, for view: NSView?,
            classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any],
            using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
        func resetSpringLoading() {}
    }
}
