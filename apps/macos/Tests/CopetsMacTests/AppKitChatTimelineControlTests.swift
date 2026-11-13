import AppKit
import SwiftUI
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class AppKitChatTimelineControlTests: XCTestCase {
    func testProcessToProseGeometryAndSelectionAcrossStreamingCollapseAndBoundaryChanges() async throws {
        for skin in ConversationSkin.allCases {
            for shared in [true, false] {
                let h = makeHarness(followsLatest: false, useSharedTextCards: shared,
                    height: 700, useSharedProcessCards: true)
                h.coordinator.updateSkin(skin)
                var body = row(id: "process-body", text: "我会把锁定页修正打成独立版本。", showsHeader: false)
                body.followsReplyProcess = true
                func process(_ expanded: Bool) -> AppKitChatTimelineRow {
                    var row = AppKitChatTimelineRow(id: "process", contentRevision: expanded ? 1 : 0,
                        nativeText: "Command inProgress", copyText: "Command inProgress", nativeStyle: .process,
                        title: "", metadata: "", expandableTurnId: "turn", isExpanded: expanded,
                        processCount: 5, processDuration: "51s", processState: .running,
                        processCurrentStepTitle: "Command inProgress", showsHeader: false)
                    row.replyIdentity = .init(roleID: "role", name: "梁子", avatarPath: nil)
                    return row
                }
                for expanded in [false, true, false] {
                    h.coordinator.apply(rows: [process(expanded), body])
                    await settlePositionPublication()
                    h.window.layoutIfNeeded()
                    let cell = try XCTUnwrap(h.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true))
                    let text = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
                    let textFrame = text.convert(text.bounds, to: h.tableView)
                    // Process chrome ends one exterior row inset before its row ends.
                    let cardBottom = h.tableView.rect(ofRow: 0).maxY - MessageCardMetrics.rowInset
                    let gap = textFrame.minY - cardBottom
                    XCTAssertEqual(gap, 8, accuracy: 1,
                        "Process and prose retain a compact positive gap")
                    let manager = try XCTUnwrap(text.layoutManager)
                    let container = try XCTUnwrap(text.textContainer)
                    manager.ensureLayout(for: container)
                    let firstGlyph = manager.boundingRect(forGlyphRange: NSRange(location: 0, length: 1), in: container)
                    print("PROCESS_PROSE_GEOMETRY skin=\(skin) shared=\(shared) expanded=\(expanded) frameGap=\(gap) glyphGap=\(gap + firstGlyph.minY + text.textContainerOrigin.y)")
                    text.setSelectedRange(NSRange(location: 1, length: 4))
                    h.coordinator.apply(rows: [process(!expanded), body])
                    await settlePositionPublication()
                    let retainedCell = try XCTUnwrap(h.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true))
                    XCTAssertTrue(textView(in: retainedCell, identifier: "chat.timeline.body") === text)
                    XCTAssertEqual(text.selectedRange(), NSRange(location: 1, length: 4))
                    body.nativeText += "继续处理"
                    body.contentRevision += 1
                    h.coordinator.apply(rows: [process(expanded), body])
                    await settlePositionPublication()
                    XCTAssertEqual(text.string, body.nativeText)
                    XCTAssertTrue(text.isSelectable)
                }
                // Same content revision, different reply boundary: restore ordinary spacing.
                body.followsReplyProcess = false
                h.coordinator.apply(rows: [process(false), body])
                await settlePositionPublication()
                let cell = try XCTUnwrap(h.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true))
                let text = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
                let restored = text.convert(text.bounds, to: h.tableView).minY
                    - (h.tableView.rect(ofRow: 0).maxY - MessageCardMetrics.rowInset)
                XCTAssertEqual(restored, 2 + skin.typography(for: .assistant).rowInset + 10, accuracy: 1)
            }
        }
    }

    func testPlainStreamingAppendRetainsContainerMenuAndCoalescesLayout() async throws {
        let h = makeHarness(followsLatest: true, useSharedTextCards: true)
        var text = "A streaming reply"
        h.coordinator.apply(rows: [row(id: "plain-stream", text: text, showsHeader: false)])
        await settlePositionPublication()
        let cell = try XCTUnwrap(h.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
        let menu = try XCTUnwrap(cell.menu)
        let resets = h.coordinator.sdkRowResetCount
        let layouts = h.coordinator.documentHeightSyncCount
        for revision in 1...20 {
            text += " more words"
            h.coordinator.apply(rows: [row(id: "plain-stream", revision: revision, text: text, showsHeader: false)])
        }
        XCTAssertEqual(h.coordinator.sdkRowResetCount, resets)
        XCTAssertEqual(h.coordinator.documentHeightSyncCount, layouts,
            "A streaming burst must not synchronously force layout for every update")
        await settlePositionPublication()
        let mounted = try XCTUnwrap(h.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
        XCTAssertTrue(mounted === cell)
        XCTAssertTrue(mounted.menu === menu, "Body changes do not rebuild identical menu actions")
        XCTAssertLessThanOrEqual(h.coordinator.documentHeightSyncCount - layouts, 3)
        h.coordinator.apply(rows: [row(id: "plain-stream", revision: 21, text: "Short", showsHeader: false)])
        await settlePositionPublication()
        XCTAssertGreaterThan(h.coordinator.sdkRowResetCount, resets, "Replacement keeps the shrink repair")
    }

    func testAppendPolicyKeepsRichAndDisclosureChangesOnResetPath() {
        let plain = row(id: "policy", text: "Plain", showsHeader: false)
        XCTAssertTrue(SDKRowContainerResetPolicy.canRetainForAppend(previous: plain,
            next: row(id: "policy", revision: 1, text: "Plain 中文 letters", showsHeader: false)))
        for text in ["Short", "Plain **bold**", "Plain\nnext", "Plain `code`", "Plain | table"] {
            XCTAssertFalse(SDKRowContainerResetPolicy.canRetainForAppend(previous: plain,
                next: row(id: "policy", revision: 1, text: text, showsHeader: false)))
        }
        var expanded = row(id: "policy", revision: 1, text: "Plain more", showsHeader: false)
        expanded.isExpanded = true
        XCTAssertFalse(SDKRowContainerResetPolicy.canRetainForAppend(previous: plain, next: expanded))
    }

    func testSharedTextLayoutDoesNotOverwriteProposalWidth() {
        let view = NativeTimelineTextView()
        view.textStorage?.setAttributedString(NSAttributedString(string: String(repeating: "Long text ", count: 100)))
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.containerSize = NSSize(width: 160, height: CGFloat.greatestFiniteMagnitude)
        view.frame = NSRect(x: 0, y: 0, width: 320, height: 100)
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.textContainer?.containerSize.width, 160,
            "SwiftUI measurement owns this text container, not the previous frame")
        view.usesIntrinsicHeight = true
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.textContainer?.containerSize.width, 320,
            "The separate native renderer retains bounds-based layout")
    }

    func testNativeIdentityChangesPreserveBodyConfigurationSelectionAndStorage() async throws {
        for skin in ConversationSkin.allCases {
            let harness = makeHarness(followsLatest: false, useSharedTextCards: false)
            harness.coordinator.updateSkin(skin)
            var model = row(id: "native-identity-isolation", text: String(repeating: "Cached reply with **bold** text. ", count: 40), showsHeader: false)
            model.replyIdentity = .init(roleID: "role", name: "Original", avatarPath: nil)
            harness.coordinator.apply(rows: [model])
            await settleMainQueue()
            let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell)
            let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
            let storage = try XCTUnwrap(body.textStorage)
            body.setSelectedRange(NSRange(location: 2, length: 8))
            let configurations = cell.contentConfigurationCount
            for name in ["Renamed", "Avatar changed"] {
                model.replyIdentity = .init(roleID: "role", name: name, avatarPath: "/tmp/missing-avatar.png")
                harness.coordinator.apply(rows: [model])
                await settleMainQueue()
                XCTAssertTrue(body.textStorage === storage)
                XCTAssertEqual(body.selectedRange(), NSRange(location: 2, length: 8))
                XCTAssertEqual(cell.contentConfigurationCount, configurations)
            }
            model.replyIdentity = nil
            harness.coordinator.apply(rows: [model])
            await settleMainQueue()
            XCTAssertEqual(body.selectedRange(), NSRange(location: 2, length: 8))
            XCTAssertEqual(cell.contentConfigurationCount, configurations)
        }
    }

    func testResizeGeometryCommitsImmediatelyWithoutDelayedReplay() {
        let h = makeHarness(followsLatest: false)
        let baseline = h.coordinator.resizeLayoutCommitCount
        h.coordinator.containerGeometryDidChange(isResizing: true)
        XCTAssertEqual(h.coordinator.resizeLayoutCommitCount, baseline + 1)
        let immediate = h.coordinator.resizeLayoutCommitCount
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(h.coordinator.resizeLayoutCommitCount, immediate)
    }

    func testCoordinatorWidthChangesNeverReloadWholeHistory() async throws {
        let h = makeHarness(followsLatest: true, height: 300)
        h.coordinator.apply(rows: (0..<300).map {
            row(id: "resize-\($0)", text: String(repeating: "Wrapped history text. ", count: 20), showsHeader: false)
        })
        await settlePositionPublication()
        let table = try XCTUnwrap(h.tableView as? IntrinsicHeightTableView)
        let baseline = table.fullReloadCount
        for width in [380.0, 520, 400, 600, 420] {
            h.window.setContentSize(NSSize(width: width, height: 300))
            h.window.layoutIfNeeded()
            NotificationCenter.default.post(name: NSView.frameDidChangeNotification, object: h.scrollView)
            await settleMainQueue()
        }
        XCTAssertEqual(table.fullReloadCount, baseline)
    }

    func testProductionCoordinatorDefaultsToSDKRowHeightOwner() {
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineCoordinator(followsLatest: .constant(true), onToggleExpansion: { _ in })
        coordinator.attach(tableView: table, scrollView: scroll)
        coordinator.apply(rows: [row(id: "production-sdk", text: "Natural body", showsHeader: false)])
        XCTAssertTrue(table.usesAutomaticRowHeights)
        XCTAssertFalse(coordinator.responds(to: #selector(NSTableViewDelegate.tableView(_:heightOfRow:))))
    }

    func testSDKCoordinatorMixedHistoryJumpPrependStreamingAndCollapse() async throws {
        for skin in ConversationSkin.allCases {
            for count in [1_000, 5_000] {
                let harness = makeHarness(followsLatest: false, height: 300, useSharedProcessCards: true)
                harness.coordinator.updateSkin(skin)
                var rows = (0..<count).map { index -> AppKitChatTimelineRow in
                    let text = String(repeating: "Mixed visible Markdown **text** with 中文 and a long paragraph that wraps naturally.\n\n", count: index % 3 + 1)
                    if index.isMultiple(of: 7) {
                        return .init(id: "sdk-history-\(index)", contentRevision: 0, nativeText: text, copyText: text,
                            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn-\(index)",
                            isExpanded: index.isMultiple(of: 14), processCount: 3, showsHeader: false)
                    }
                    var value = row(id: "sdk-history-\(index)", text: text,
                        nativeStyle: index.isMultiple(of: 5) ? .user : .agent, showsHeader: false)
                    if index.isMultiple(of: 11) && value.nativeStyle == .agent {
                        value.scheduledTrigger = .init(text: text, isExpanded: false, expansionID: "trigger-\(index)")
                    }
                    return value
                }
                harness.coordinator.apply(rows: rows)
                harness.window.layoutIfNeeded(); await settleMainQueue()
                XCTAssertTrue(harness.tableView.usesAutomaticRowHeights)
                XCTAssertFalse(harness.coordinator.responds(to: #selector(NSTableViewDelegate.tableView(_:heightOfRow:))))
                let target = count - 8
                harness.coordinator.scrollToTurn(rows[target].id)
                await settlePositionPublication()
                let visible = harness.tableView.rows(in: harness.tableView.visibleRect)
                XCTAssertTrue(NSLocationInRange(target, visible), "skin=\(skin) count=\(count) target=\(target) visible=\(visible)")
                let before = visibleAnchor(in: harness.tableView, rows: rows)
                let earlier = (0..<12).map { row(id: "sdk-previous-\($0)", text: "Earlier message", showsHeader: false) }
                rows = earlier + rows
                harness.coordinator.apply(rows: rows)
                await settlePositionPublication()
                let after = visibleAnchor(in: harness.tableView, rows: rows)
                XCTAssertEqual(after.id, before.id)
                XCTAssertEqual(after.offset, before.offset, accuracy: 4)
                harness.coordinator.jumpToLatest()
                await settlePositionPublication()
                func bottomGap() -> CGFloat {
                    (harness.scrollView.documentView?.frame.height ?? 0) - harness.scrollView.contentView.bounds.maxY
                }
                XCTAssertEqual(bottomGap(), 0, accuracy: 3)
                for revision in 1...3 {
                    let last = rows.count - 1
                    rows[last] = row(id: rows[last].id, revision: revision,
                        text: String(repeating: "Streaming a longer final reply that wraps with the window.\n", count: revision * 10), showsHeader: false)
                    harness.coordinator.apply(rows: rows)
                    await settlePositionPublication()
                    XCTAssertEqual(bottomGap(), 0, accuracy: 3)
                }
                func process(_ expanded: Bool) -> AppKitChatTimelineRow {
                    .init(id: "sdk-final-process", contentRevision: expanded ? 0 : 1,
                        nativeText: String(repeating: "Execution detail\n", count: 100), copyText: "detail",
                        nativeStyle: .process, title: "", metadata: "", expandableTurnId: "sdk-turn",
                        isExpanded: expanded, processCount: 100, showsHeader: false)
                }
                rows.insert(process(true), at: rows.count - 1)
                harness.coordinator.apply(rows: rows)
                await settlePositionPublication()
                rows[rows.count - 2] = process(false)
                harness.coordinator.apply(rows: rows)
                await settlePositionPublication()
                XCTAssertEqual(bottomGap(), 0, accuracy: 3)
                XCTAssertTrue(harness.coordinator.followsLatest)
            }
        }
    }

    func testSDKFloatingCollapseAndLateImageGeometryKeepLatestAtBottom() async throws {
        for skin in ConversationSkin.allCases {
            var toggled: String?
            let harness = makeHarness(followsLatest: false, height: 300, useSharedProcessCards: true,
                onToggle: { toggled = $0 })
            harness.coordinator.updateSkin(skin)
            let history = row(id: "sdk-earlier", text: String(repeating: "Earlier message\n", count: 40), showsHeader: false)
            let latest = row(id: "sdk-latest", text: "Latest reply", showsHeader: false)
            func process(_ expanded: Bool) -> AppKitChatTimelineRow {
                .init(id: "sdk-long-process", contentRevision: expanded ? 0 : 1,
                    nativeText: String(repeating: "Long execution detail\n", count: 150), copyText: "detail",
                    nativeStyle: .process, title: "", metadata: "", expandableTurnId: "sdk-collapse-turn",
                    isExpanded: expanded, processCount: 150, showsHeader: false)
            }
            harness.coordinator.apply(rows: [history, process(true), latest])
            harness.coordinator.scrollToTurn("sdk-collapse-turn")
            await settlePositionPublication()
            let clip = harness.scrollView.contentView
            clip.scroll(to: .init(x: 0, y: harness.tableView.rect(ofRow: 1).minY + 200))
            harness.scrollView.reflectScrolledClipView(clip)
            await settleMainQueue()
            let collapse = try XCTUnwrap(button(in: harness.scrollView, identifier: "chat.timeline.process-follow-collapse"))
            XCTAssertFalse(collapse.isHidden)
            collapse.performClick(nil)
            XCTAssertEqual(toggled, "sdk-collapse-turn")
            harness.coordinator.apply(rows: [history, process(false), latest])
            await settlePositionPublication()
            let document = try XCTUnwrap(harness.scrollView.documentView)
            XCTAssertEqual(clip.bounds.minY, max(0, document.frame.height - clip.bounds.height), accuracy: 3)
            XCTAssertTrue(harness.coordinator.followsLatest)

            let images = makeHarness(followsLatest: true, height: 300, useSharedProcessCards: true)
            images.coordinator.updateSkin(skin)
            var image = row(id: "sdk-late-image", text: "", nativeStyle: .user, showsHeader: false)
            image.images = [.init(managedPath: "sdk-local-placeholder", displayURL: nil, originalPath: nil,
                geometry: .init(pixelWidth: 600, pixelHeight: 100))]
            let earlier = (0..<50).map { row(id: "sdk-image-earlier-\($0)", text: "Earlier message", showsHeader: false) }
            images.coordinator.apply(rows: earlier + [image])
            images.coordinator.jumpToLatest()
            await settlePositionPublication()
            let initial = images.tableView.rect(ofRow: earlier.count).height
            image.images[0].geometry = .init(pixelWidth: 600, pixelHeight: 900)
            image.contentRevision += 1
            images.coordinator.apply(rows: earlier + [image])
            await settlePositionPublication()
            XCTAssertGreaterThan(images.tableView.rect(ofRow: earlier.count).height, initial)
            let imageDocument = try XCTUnwrap(images.scrollView.documentView)
            XCTAssertEqual(imageDocument.frame.height - images.scrollView.contentView.bounds.maxY, 0, accuracy: 3)
        }
    }

    func testSDKProseTriggerAndImageShrinkDoNotKeepFormerRowHeight() async throws {
        for skin in ConversationSkin.allCases {
            let history = row(id: "shrink-history", text: String(repeating: "Earlier message\n", count: 40), showsHeader: false)
            let latest = row(id: "shrink-latest", text: "Latest reply", showsHeader: false)
            let long = String(repeating: "A long paragraph that wraps with the window and occupies enough space to cover the viewport.\n", count: 30)
            for kind in 0..<4 {
                let harness = makeHarness(followsLatest: true, height: 300, useSharedProcessCards: true)
                harness.coordinator.updateSkin(skin)
                var before = row(id: "shrink-body", text: kind == 0 ? long : "", nativeStyle: kind == 3 ? .user : .agent, showsHeader: false)
                var after = row(id: "shrink-body", revision: 1, text: kind == 0 ? "Short final text" : "", nativeStyle: kind == 3 ? .user : .agent, showsHeader: false)
                if kind == 1 {
                    before.scheduledTrigger = .init(text: long, isExpanded: true, expansionID: "shrink-trigger")
                    after.scheduledTrigger = .init(text: long, isExpanded: false, expansionID: "shrink-trigger")
                } else if kind >= 2 {
                    before.images = [.init(managedPath: "shrink-image", displayURL: nil, originalPath: nil,
                        geometry: .init(pixelWidth: 600, pixelHeight: 900))]
                    after.images = [.init(managedPath: "shrink-image", displayURL: nil, originalPath: nil,
                        geometry: .init(pixelWidth: 600, pixelHeight: 100))]
                }
                harness.coordinator.apply(rows: [history, before, latest])
                harness.coordinator.jumpToLatest()
                await settlePositionPublication()
                let oldHeight = harness.tableView.rect(ofRow: 1).height
                harness.coordinator.apply(rows: [history, after, latest])
                await settlePositionPublication()
                XCTAssertLessThan(harness.tableView.rect(ofRow: 1).height, oldHeight, "kind=\(kind) skin=\(skin)")
                let document = try XCTUnwrap(harness.scrollView.documentView)
                XCTAssertEqual(document.frame.height - harness.scrollView.contentView.bounds.maxY, 0, accuracy: 3,
                    "kind=\(kind) skin=\(skin)")
            }
        }
    }

    func testSDKRepeatedProcessChangesRetainContentCellsSelectionAndFocus() async throws {
        for skin in ConversationSkin.allCases {
            let harness = makeHarness(followsLatest: true, height: 300, useSharedProcessCards: true)
            harness.coordinator.updateSkin(skin)
            let history = row(id: "cycle-history", text: "History", showsHeader: false)
            let answer = row(id: "cycle-answer", text: "Reply with a [link](https://example.com) and a stable selection", showsHeader: false)
            func process(_ expanded: Bool, revision: Int) -> AppKitChatTimelineRow {
                .init(id: "cycle-process", contentRevision: revision,
                    nativeText: String(repeating: "Execution detail\n", count: 80), copyText: "detail",
                    nativeStyle: .process, title: "", metadata: "", expandableTurnId: "cycle-turn",
                    isExpanded: expanded, processCount: 80, showsHeader: false)
            }
            harness.coordinator.apply(rows: [history, process(true, revision: 0), answer])
            harness.coordinator.jumpToLatest()
            await settlePositionPublication()
            let processCell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true))
            let answerCell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 2, makeIfNecessary: true))
            let body = try XCTUnwrap(textView(in: answerCell, identifier: "chat.timeline.body"))
            body.setSelectedRange(.init(location: 2, length: 5))
            XCTAssertTrue(harness.window.makeFirstResponder(body))
            for revision in 1...12 {
                harness.coordinator.apply(rows: [history, process(revision.isMultiple(of: 2), revision: revision), answer])
                await settlePositionPublication()
                XCTAssertTrue(harness.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true) === processCell)
                XCTAssertTrue(harness.tableView.view(atColumn: 0, row: 2, makeIfNecessary: true) === answerCell)
                XCTAssertEqual(body.selectedRange(), NSRange(location: 2, length: 5))
                XCTAssertTrue(harness.window.firstResponder === body)
                let document = try XCTUnwrap(harness.scrollView.documentView)
                // A collapsed short conversation stays at origin; a document
                // shorter than the viewport cannot have a zero bottom gap.
                XCTAssertEqual(harness.scrollView.contentView.bounds.minY,
                    max(0, document.frame.height - harness.scrollView.contentView.bounds.height), accuracy: 3)
            }
            // Collapse and append in the same source update: the survivor goes
            // through the structural-difference path instead of the in-place one.
            harness.coordinator.apply(rows: [history, process(false, revision: 13), answer,
                row(id: "cycle-appended", text: "New final reply", showsHeader: false)])
            await settlePositionPublication()
            XCTAssertLessThan(harness.tableView.rect(ofRow: 1).height, 100)
            XCTAssertEqual(body.selectedRange(), NSRange(location: 2, length: 5))
        }
    }

    func testReplyLeadingGeometryMatchesBodyAndIdentityInBothRenderers() async throws {
        for shared in [false, true] {
            let harness = makeHarness(followsLatest: false, useSharedTextCards: shared)
            for skin in [ConversationSkin.classic, .codexFlat] {
                harness.coordinator.updateSkin(skin)
                var answer = row(id: "leading-answer", text: "Reply body", showsHeader: false,
                                 contextTimestamp: "10:20")
                answer.replyIdentity = .init(roleID: "agent:one", name: "Developer", avatarPath: nil)
                answer.showsReplyActions = true
                harness.coordinator.apply(rows: [answer])
                await settleMainQueue()
                harness.window.layoutIfNeeded()
                harness.tableView.layoutSubtreeIfNeeded()
                let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true))
                cell.layoutSubtreeIfNeeded()
                let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
                let copy = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.reply-actions.copy"))
                let bodyX = cell.convert(body.bounds, from: body).minX
                let image = try XCTUnwrap(copy.cell).imageRect(forBounds: copy.bounds)
                let cardX: CGFloat = skin == .classic ? 12 : 2
                XCTAssertEqual(bodyX, cardX + 10, accuracy: 0.5, "shared=\(shared), skin=\(skin)")
                XCTAssertEqual(cell.convert(image, from: copy).minX, bodyX, accuracy: 0.5)
                XCTAssertEqual(copy.bounds.width, 22, accuracy: 0.5)
                if !shared {
                    let header = try XCTUnwrap(cell.subviews.first { $0 is NSHostingView<MacReplyIdentityHeader> })
                    XCTAssertEqual(cell.convert(header.bounds, from: header).minX, 12, accuracy: 0.5)
                    let card = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.card"))
                    XCTAssertEqual(cell.convert(card.bounds, from: card).minX, cardX, accuracy: 0.5)
                }
            }
        }
    }

    func testProcessLeadingGeometryAndNarrowExpandedWidth() throws {
        let harness = makeHarness(followsLatest: false, useSharedTextCards: false)
        for skin in [ConversationSkin.classic, .codexFlat] {
            harness.coordinator.updateSkin(skin)
            for expanded in [false, true] {
                let process = AppKitChatTimelineRow(id: "leading-process", contentRevision: expanded ? 2 : 1,
                    nativeText: "Execution details", copyText: "Execution details", nativeStyle: .process,
                    title: "", metadata: "", expandableTurnId: "turn", isExpanded: expanded, processCount: 3)
                harness.coordinator.apply(rows: [process])
                harness.window.layoutIfNeeded()
                harness.tableView.layoutSubtreeIfNeeded()
                let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true))
                let card = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.card"))
                XCTAssertEqual(cell.convert(card.bounds, from: card).minX, 12, accuracy: 0.5)
                if expanded {
                    for width: CGFloat in [240, 420, 900] {
                        let layout = LegacyTimelineLayoutReference.shared.layout(for: process, columnWidth: width,
                            typography: skin.typography(for: .assistant), skin: skin)
                        XCTAssertLessThanOrEqual(12 + layout.cardWidth, width - 2)
                        XCTAssertLessThanOrEqual(layout.cardWidth, 480)
                    }
                }
            }
            harness.coordinator.apply(rows: [row(id: "leading-process", revision: 3, text: "Normal body", showsHeader: false)])
            harness.window.layoutIfNeeded()
            let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true))
            let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
            XCTAssertEqual(cell.convert(body.bounds, from: body).minX, skin == .classic ? 22 : 12, accuracy: 0.5)
        }
    }

    func testPaintedReplyCardsReserveTheirLeadingInsetWithoutMovingUserCards() {
        for functional in [false, true] {
            let answer = row(id: "wide-answer", text: String(repeating: "Wide reply body ", count: 120), showsHeader: functional)
            for skin in [ConversationSkin.classic, .codexFlat] {
                for width: CGFloat in [240, 420, 900] {
                    let layout = LegacyTimelineLayoutReference.shared.layout(for: answer, columnWidth: width,
                        typography: skin.typography(for: .assistant), skin: skin)
                    let leading = ReplyLeadingLayout.cardLeading(for: answer, skin: skin)
                    XCTAssertLessThanOrEqual(leading + layout.cardWidth, width - 2)
                }
            }
        }
        let user = AppKitChatTimelineRow(id: "user-edge", contentRevision: 1, nativeText: "User", copyText: "User",
            nativeStyle: .user, title: "", metadata: "", expandableTurnId: nil, isExpanded: false)
        for skin in [ConversationSkin.classic, .codexFlat] {
            XCTAssertEqual(ReplyLeadingLayout.cardLeading(for: user, skin: skin), 2)
            XCTAssertEqual(ReplyLeadingLayout.additionalCardInset(for: user, skin: skin), 0)
            XCTAssertEqual(ChatBubbleWidthPolicy.userTrailingInset, 2)
        }
    }

    func testReplyIdentityMovesDuringPrependWithoutChangingContentRevision() throws {
        let harness = makeHarness(followsLatest: false, useSharedTextCards: false)
        let identity = ConversationReplyIdentity(roleID: "agent:one", name: "Developer", avatarPath: nil)
        var answer = row(id: "identity-answer", text: "Answer", showsHeader: false)
        answer.replyIdentity = identity
        harness.coordinator.apply(rows: [answer])
        let originalHeight = harness.tableView.rect(ofRow: 0).height
        let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true))
        XCTAssertTrue(cell.subviews.contains { $0 is NSHostingView<MacReplyIdentityHeader> })
        var earlier = row(id: "identity-earlier", text: "Earlier commentary", showsHeader: false)
        earlier.replyIdentity = identity
        answer.replyIdentity = nil
        harness.coordinator.apply(rows: [earlier, answer])
        XCTAssertEqual(harness.tableView.rect(ofRow: 1).height, originalHeight - 44)
        let surviving = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true))
        XCTAssertFalse(surviving.subviews.contains { $0 is NSHostingView<MacReplyIdentityHeader> })
        let inserted = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true))
        XCTAssertTrue(inserted.subviews.contains { $0 is NSHostingView<MacReplyIdentityHeader> })
    }

    func testSDKReadingTypographyPreservesCharacterAnchorAndSearchIntent() async throws {
        try await assertReadingTypographyPreservesCharacterAnchorAndSearchIntent()
    }

    private func assertReadingTypographyPreservesCharacterAnchorAndSearchIntent() async throws {
        for shared in [false, true] {
            let harness = makeHarness(followsLatest: false, useSharedTextCards: shared, height: 240, useSharedProcessCards: true)
            let long = String(repeating: "Reading 中文 😀 text with stable character anchors. ", count: 140)
            let rows = (0..<24).map { row(id: "reading-\($0)", text: $0 == 10 ? long : "Message \($0)", showsHeader: false) }
            harness.coordinator.apply(rows: rows)
            await settleMainQueue()
            harness.coordinator.restore(position: .init(rowID: "reading-10", offset: 400, absoluteScrollY: 0, followsLatest: false))
            await settleMainQueue()
            harness.tableView.layoutSubtreeIfNeeded()
            func leaves(_ view: NSView) -> [NativeTimelineTextView] {
                (view as? NativeTimelineTextView).map { [$0] } ?? view.subviews.flatMap(leaves)
            }
            let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 10, makeIfNecessary: true))
            let text = try XCTUnwrap(leaves(cell).first)
            let manager = try XCTUnwrap(text.layoutManager)
            let container = try XCTUnwrap(text.textContainer)
            manager.ensureLayout(for: container)
            let top = harness.tableView.convert(text.bounds, from: text).minY
            let point = NSPoint(x: 0, y: harness.scrollView.contentView.bounds.minY - top)
            let glyph = manager.glyphIndex(for: point, in: container)
            let character = manager.characterIndexForGlyph(at: glyph)
            func characterY() -> CGFloat {
                manager.ensureLayout(for: container)
                let rect = manager.lineFragmentRect(forGlyphAt: manager.glyphIndexForCharacter(at: character), effectiveRange: nil)
                return harness.tableView.convert(rect.origin, from: text).y - harness.scrollView.contentView.bounds.minY
            }
            text.setSelectedRange(NSRange(location: 10, length: 12))
            let originalY = characterY()
            let classicHeight = harness.tableView.rect(ofRow: 10).height
            for skin in [ConversationSkin.codexFlat, .classic] {
                harness.coordinator.updateSkin(skin)
                await settleMainQueue()
                harness.tableView.layoutSubtreeIfNeeded()
                XCTAssertTrue(leaves(cell).first === text)
                XCTAssertEqual(text.string, long, "A cached message view must not be rebound to a neighbouring row")
                XCTAssertEqual(text.selectedRange(), NSRange(location: 10, length: 12))
                XCTAssertEqual(characterY(), originalY, accuracy: 3, "shared=\(shared)")
                if skin == .codexFlat { XCTAssertGreaterThan(harness.tableView.rect(ofRow: 10).height, classicHeight) }
                else { XCTAssertEqual(harness.tableView.rect(ofRow: 10).height, classicHeight) }
            }
            harness.coordinator.updateSkin(.codexFlat)
            harness.coordinator.applySearchTarget(rowID: "reading-20", revision: 1)
            await settleMainQueue()
            XCTAssertEqual(harness.tableView.selectedRow, 20)
            XCTAssertEqual(harness.scrollView.contentView.bounds.minY,
                harness.tableView.rect(ofRow: 20).minY - 10, accuracy: 1)
        }
    }

    func testHiddenReadingTypographyDefersReflowAndLatestStillFollows() async throws {
        let harness = makeHarness(followsLatest: true, height: 240)
        let rows = (0..<60).map { row(id: "hidden-reading-\($0)", text: "中文 Reading response \($0)", showsHeader: false) }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        let before = harness.tableView.rect(ofRow: 59).height
        harness.coordinator.setPresentationActive(false)
        harness.coordinator.updateSkin(.codexFlat)
        XCTAssertEqual(harness.tableView.rect(ofRow: 59).height, before)
        harness.coordinator.setPresentationActive(true)
        await settleMainQueue()
        XCTAssertGreaterThan(harness.tableView.rect(ofRow: 59).height, before)
        XCTAssertTrue(isNearBottom(harness))
        var streamed = rows
        streamed[59] = row(id: rows[59].id, revision: 1, text: String(repeating: "streaming 中文 ", count: 100), showsHeader: false)
        harness.coordinator.apply(rows: streamed)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))
    }

    func testCollapsedExecutionSummaryNeverWrapsOrAddsHeight() throws {
        let row = AppKitChatTimelineRow(
            id: "single-line-process", contentRevision: 1, nativeText: "details", copyText: "details",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn",
            isExpanded: false, processCount: 123456, processDuration: "123456.78s",
            processState: .completed, showsHeader: false
        )
        for width: CGFloat in [100, 160, 320] {
            XCTAssertEqual(LegacyTimelineLayoutReference.processSummaryExtraHeight(for: row, cardWidth: width), 0)
            XCTAssertEqual(LegacyTimelineLayoutReference.shared.layout(for: row, columnWidth: width).rowHeight, 32)
            let summaryWidth = ceil((row.processPrimarySummary as NSString).size(withAttributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
            ]).width)
            XCTAssertGreaterThanOrEqual(ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: width), summaryWidth + 66)
        }
        let cell = AppKitChatNativeTextCell(identifier: .init("single-line-process"))
        cell.setContent(row, availableWidth: 160, onToggleExpansion: { _ in })
        let summary = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))
        XCTAssertFalse(summary.cell?.wraps ?? true)
        XCTAssertEqual(summary.cell?.lineBreakMode, .byClipping)
        let paragraph = try XCTUnwrap(summary.attributedTitle.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(paragraph.lineBreakMode, .byClipping)
    }

    func testForkMovesIntoContextMenuWithoutChangingMessageHeight() throws {
        let plain = AppKitChatTimelineRow(
            id: "answer", contentRevision: 1, nativeText: "好", copyText: "好",
            nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false
        )
        let cell = AppKitChatNativeTextCell(identifier: .init("fork-control"))
        cell.setContent(plain, availableWidth: 400, onToggleExpansion: { _ in })
        XCTAssertNil(menuItem(in: cell.menu, identifier: "chat.timeline.context.fork"))
        var unavailable = plain
        unavailable.forkUnavailableReason = "This provider does not support conversation forks."
        unavailable.contentRevision = 2
        cell.setContent(unavailable, availableWidth: 400, onToggleExpansion: { _ in })
        let unavailableControl = try XCTUnwrap(menuItem(in: cell.menu, identifier: "chat.timeline.context.fork"))
        XCTAssertFalse(unavailableControl.isEnabled)
        XCTAssertEqual(
            menuItem(in: cell.menu, identifier: "chat.timeline.context.fork-reason")?.title,
            unavailable.forkUnavailableReason
        )
        var forkable = plain
        forkable.forkItemID = "answer"
        forkable.contentRevision = 3
        cell.setContent(forkable, availableWidth: 400, onToggleExpansion: { _ in })
        let control = try XCTUnwrap(menuItem(in: cell.menu, identifier: "chat.timeline.context.fork"))
        XCTAssertTrue(control.isEnabled)
        XCTAssertEqual(
            LegacyTimelineLayoutReference.shared.layout(for: forkable, columnWidth: 400).rowHeight,
            LegacyTimelineLayoutReference.shared.layout(for: plain, columnWidth: 400).rowHeight
        )
        cell.setContent(plain, availableWidth: 400, onToggleExpansion: { _ in })
        XCTAssertNil(menuItem(in: cell.menu, identifier: "chat.timeline.context.fork"))
    }

    func testMessageBodyUsesSystemMenuForDirectTextSelection() throws {
        let first = AppKitChatTimelineRow(
            id: "answer", contentRevision: 1, nativeText: "Selectable answer", copyText: "Selectable answer",
            nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false, contextTimestamp: "09/28 21:05:12"
        )
        let cell = AppKitChatNativeTextCell(identifier: .init("context-menu-routing"))
        cell.frame = NSRect(x: 0, y: 0, width: 420, height: 80)
        cell.setContent(first, availableWidth: 420, onToggleExpansion: { _ in })
        cell.layoutSubtreeIfNeeded()

        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
        let rightClick = try XCTUnwrap(NSEvent.mouseEvent(
            with: .rightMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1
        ))
        XCTAssertTrue(body.cardContextMenu === cell.menu)
        XCTAssertTrue(body.menu(for: rightClick) === cell.menu)
        XCTAssertFalse(body.usesNativeTextMenu)
        XCTAssertNil(menuItem(in: cell.menu, identifier: "chat.timeline.context.select-text"))
        body.setSelectedRange(NSRange(location: 0, length: 10))
        XCTAssertTrue(body.usesNativeTextMenu)
        let systemMenu = try XCTUnwrap(body.menu(for: rightClick))
        XCTAssertFalse(systemMenu === cell.menu)
        XCTAssertTrue(systemMenu.items.contains { $0.action == NSSelectorFromString("copy:") })
        body.copy(nil)
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "Selectable")
        body.cancelOperation(nil)
        XCTAssertFalse(body.usesNativeTextMenu)
        XCTAssertTrue(body.menu(for: rightClick) === cell.menu)
        body.setSelectedRange(NSRange(location: 4, length: 6))
        XCTAssertTrue(body.usesNativeTextMenu)
        body.setSelectedRange(NSRange(location: 4, length: 0))
        XCTAssertTrue(body.menu(for: rightClick) === cell.menu)
        body.setSelectedRange(NSRange(location: 0, length: 10))

        let reused = AppKitChatTimelineRow(
            id: "answer", contentRevision: 2, nativeText: "Updated answer", copyText: "Updated answer",
            nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false, contextTimestamp: "09/28 21:05:12"
        )
        cell.setContent(reused, availableWidth: 420, onToggleExpansion: { _ in })
        XCTAssertFalse(body.usesNativeTextMenu)
        XCTAssertTrue(body.cardContextMenu === cell.menu)
        XCTAssertTrue(body.menu(for: rightClick) === cell.menu)
    }

    func testMessageStatusUsesGlowWithoutChangingBodyHeight() throws {
        let queued = try XCTUnwrap(UserMessageStatusPresentation(
            authoritativeStatus: "queued", legacyStatus: nil, queuePosition: 2
        ))
        let plain = AppKitChatTimelineRow(
            id: "user", contentRevision: 1, nativeText: "Hello", copyText: "Hello",
            nativeStyle: .user, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false
        )
        let withStatus = AppKitChatTimelineRow(
            id: "user", contentRevision: 2, nativeText: "Hello", copyText: "Hello",
            nativeStyle: .user, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false, messageStatus: queued
        )
        XCTAssertTrue(withStatus.showsMessageStatusBar)
        XCTAssertEqual(withStatus.copyText, plain.copyText)
        XCTAssertEqual(withStatus.nativeText, plain.nativeText)
        XCTAssertEqual(
            LegacyTimelineLayoutReference.shared.layout(for: withStatus, columnWidth: 400).rowHeight,
            LegacyTimelineLayoutReference.shared.layout(for: plain, columnWidth: 400).rowHeight
        )
    }

    func testShortNativeUserMessageKeepsStatusDetailWithoutASeparateFooter() throws {
        let status = try XCTUnwrap(UserMessageStatusPresentation(
            authoritativeStatus: "processing", legacyStatus: nil
        ))
        let message = AppKitChatTimelineRow(
            id: "short-user", contentRevision: 1, nativeText: "好", copyText: "好",
            nativeStyle: .user, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false, messageStatus: status
        )
        let cell = AppKitChatNativeTextCell(identifier: .init("short-status"))
        cell.frame = .init(x: 0, y: 0, width: 400, height: 70)
        cell.setContent(message, availableWidth: 400, onToggleExpansion: { _ in })
        cell.layoutSubtreeIfNeeded()
        let card = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.card"))
        XCTAssertEqual(card.toolTip, status.detail(
            languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
        XCTAssertNil(button(in: cell, identifier: "chat.timeline.message-status"))
    }

    func testImageMessageReservesStableNativeRowGeometry() {
        let plain = AppKitChatTimelineRow(
            id: "plain", contentRevision: 1, nativeText: "Image", copyText: "Image",
            nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false
        )
        let image = AppKitChatTimelineRow(
            id: "image", contentRevision: 1, nativeText: "Image", copyText: "Image",
            nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false,
            images: [ChatTimelineImage(
                managedPath: "chat-resources/sessions/one/images/a.png",
                displayURL: URL(string: "http://127.0.0.1/image"),
                originalPath: "/tmp/original.png"
            )]
        )

        let plainLayout = LegacyTimelineLayoutReference.shared.layout(for: plain, columnWidth: 500)
        let imageLayout = LegacyTimelineLayoutReference.shared.layout(for: image, columnWidth: 500)
        XCTAssertEqual(imageLayout.rowHeight - plainLayout.rowHeight, 96)
        XCTAssertGreaterThanOrEqual(imageLayout.cardWidth, 108)
    }

    func testAsyncImageGeometryPreservesHistoryAnchorIncludingDuringScroll() async throws {
        for duringScroll in [false, true] {
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 600, pixelsHigh: 1000,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("anchor-image-\(UUID()).png")
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            let harness = makeHarness(followsLatest: false, height: 180)
            var rows = (0..<60).map { row(id: "image-anchor-\($0)", text: "Row \($0)") }
            rows[20] = AppKitChatTimelineRow(id: "image-anchor-20", contentRevision: 0, nativeText: "",
                copyText: "", nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
                isExpanded: false, showsHeader: false, images: [ChatTimelineImage(
                    managedPath: url.path, displayURL: url, originalPath: nil)])
            harness.coordinator.apply(rows: rows)
            await settleMainQueue()
            harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: harness.tableView.rect(ofRow: 35).minY + 5))
            harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
            harness.coordinator.userScrollEventWillBegin()
            harness.coordinator.userScrollEventDidEnd()
            let before = visibleAnchor(in: harness.tableView, rows: rows)
            if duringScroll { harness.coordinator.userScrollEventWillBegin() }
            _ = harness.tableView.view(atColumn: 0, row: 20, makeIfNecessary: true)
            let _: NSImage? = await withCheckedContinuation { continuation in
                ChatTimelineImageLoader.shared.load(url) { continuation.resume(returning: $0) }
            }
            await settleMainQueue()
            if duringScroll { harness.coordinator.userScrollEventDidEnd(); await settleMainQueue() }
            let after = visibleAnchor(in: harness.tableView, rows: rows)
            XCTAssertEqual(after.id, before.id)
            XCTAssertEqual(after.offset, before.offset, accuracy: 2)
            XCTAssertFalse(harness.coordinator.followsLatest)
        }
    }

    func testLiveResizeReflowsOnlyVisibleRowsThenExactReflowCoversAllRows() {
        let visible = NSRange(location: 40, length: 12)

        XCTAssertEqual(
            LiveResizeRowReflowPolicy.indexes(
                rowCount: 500,
                visibleRows: visible,
                isLiveResize: true
            ),
            IndexSet(integersIn: 40..<52)
        )
        XCTAssertEqual(
            LiveResizeRowReflowPolicy.indexes(
                rowCount: 500,
                visibleRows: visible,
                isLiveResize: false
            ),
            IndexSet(integersIn: 0..<500)
        )
    }

    func testNativeReadingLaneTracksWindowWithoutWidthBucketsOrNarrowInsetSwitch() {
        let h = makeHarness(followsLatest: false)
        for compact in [false, true] {
            h.coordinator.setReservesVerticalScrollerGutter(!compact)
            for width: CGFloat in [1100, 650, 499, 403, 404, 403.25] {
                h.window.setContentSize(NSSize(width: width, height: 320))
                h.window.layoutIfNeeded()
                h.scrollView.layoutSubtreeIfNeeded()
                let viewport = h.scrollView.contentView.bounds.width
                let expected = viewport
                XCTAssertEqual(h.tableView.frame.width, expected, accuracy: 0.5)
                XCTAssertEqual(h.tableView.frame.minX, (viewport - expected) / 2, accuracy: 0.5)
                XCTAssertEqual(h.tableView.tableColumns[0].width, expected, accuracy: 0.5)
            }
        }
    }

    func testContinuousLongReplyResizePreservesContentConfigurationAndSelection() {
        let cell = AppKitChatNativeTextCell(identifier: .init("long-reply-resize"))
        let text = String(repeating: "### 长正文\n\n窗口缩放保持原来的文本和选择。Mixed English words for wrapping.\n\n", count: 80)
        let tableText = "| 项目 | 说明 |\n| --- | --- |\n"
            + (0..<30).map { "| 行 \($0) | 中文和 English 描述需要随宽度换行 |\n" }.joined()
        let item = row(id: "long-reply-resize", text: text, showsHeader: false)
        let tableItem = row(id: "table-resize", text: tableText, showsHeader: false)
        cell.setContent(item, availableWidth: 560, baseDirectory: nil, onToggleExpansion: { _ in }, onAction: { _ in })
        let configurations = cell.contentConfigurationCount
        let body = textView(in: cell, identifier: "chat.timeline.body")
        let selected = NSRange(location: 3, length: 5)
        body?.setSelectedRange(selected)
        var costs: [Double] = []
        var previousWidth: CGFloat = 560
        var distinctWidthChanges = 0
        for index in 0..<120 {
            let width = CGFloat(480 + index * 2)
            let started = ProcessInfo.processInfo.systemUptime
            if previousWidth != width { distinctWidthChanges += 1; previousWidth = width }
            XCTAssertTrue(cell.updateLayoutIfContentUnchanged(item, availableWidth: width))
            _ = LegacyTimelineLayoutReference.shared.layout(for: tableItem, columnWidth: width)
            costs.append((ProcessInfo.processInfo.systemUptime - started) * 1_000)
        }
        XCTAssertEqual(cell.contentConfigurationCount, configurations)
        XCTAssertEqual(cell.widthLayoutUpdateCount, distinctWidthChanges,
            "Unchanged quantized widths must not invalidate intrinsic text layout")
        XCTAssertNotNil(body)
        XCTAssertEqual(body?.selectedRange(), selected)
        costs.sort()
        print("Long reply resize CPU layout: median=\(costs[60])ms P95=\(costs[114])ms; excludes screen presentation")
    }

    func testWidthOnlyCellUpdateDoesNotRepeatContentConfiguration() {
        let cell = AppKitChatNativeTextCell(
            identifier: NSUserInterfaceItemIdentifier("width-update-test")
        )
        let original = row(id: "row", revision: 1, text: "A wrapped timeline message")
        cell.setContent(original, availableWidth: 400, onToggleExpansion: { _ in })

        XCTAssertEqual(cell.contentConfigurationCount, 1)
        XCTAssertTrue(cell.updateLayoutIfContentUnchanged(original, availableWidth: 408))
        XCTAssertEqual(cell.contentConfigurationCount, 1)
        XCTAssertEqual(cell.widthLayoutUpdateCount, 1)

        let revised = row(id: "row", revision: 2, text: "Changed")
        XCTAssertFalse(cell.updateLayoutIfContentUnchanged(revised, availableWidth: 408))
        XCTAssertEqual(cell.contentConfigurationCount, 1)
    }

    func testDuplicateRowsAreCollapsedBeforeBuildingRevisionIndex() {
        let rows = [
            row(id: "same", revision: 1, text: "old"),
            row(id: "other", revision: 1, text: "other"),
            row(id: "same", revision: 2, text: "new")
        ]

        let unique = AppKitChatTimelineView.Coordinator.uniquedRows(rows)

        XCTAssertEqual(unique.map(\.id), ["same", "other"])
        XCTAssertEqual(unique.first?.contentRevision, 2)
        XCTAssertEqual(unique.first?.nativeText, "new")
    }

    private final class FollowState {
        var value: Bool

        init(_ value: Bool) {
            self.value = value
        }
    }

    func testConfiguresNativeRowsWithDeterministicDynamicHeights() {
        let harness = makeHarness(followsLatest: true)
        let short = row(id: "short", text: "short")
        let long = row(id: "long", text: String(repeating: "long wrapped content ", count: 80))

        harness.coordinator.apply(rows: [short, long])
        harness.tableView.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.tableView.numberOfRows, 2)
        XCTAssertLessThan(
            harness.tableView.rect(ofRow: 0).height,
            harness.tableView.rect(ofRow: 1).height
        )
        XCTAssertTrue(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                is AppKitChatNativeTextCell
        )
    }

    func testDisclosureCallbackAndCopyUseOriginalUnmodifiedText() throws {
        var toggledTurnID: String?
        let harness = makeHarness(followsLatest: true) { toggledTurnID = $0 }
        let source = "Open docs/file.swift"
        let rendered = "Open [docs/file.swift](<file:///tmp/docs/file.swift>)"
        let item = row(
            id: "expandable",
            text: rendered,
            copyText: source,
            expandableTurnId: "turn-42"
        )
        harness.coordinator.apply(rows: [item])

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        let disclosure = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.disclosure"))
        let copy = try XCTUnwrap(menuItem(in: cell.menu, identifier: "chat.timeline.context.copy"))

        disclosure.performClick(self)
        NSApp.sendAction(try XCTUnwrap(copy.action), to: copy.target, from: copy)

        XCTAssertEqual(toggledTurnID, "turn-42")
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), source)
    }

    func testNativeTextViewRoutesLocalLinkThroughInjectedClickHandler() throws {
        let textView = NativeTimelineTextView()
        textView.linkBaseDirectory = "/tmp/session workspace"
        var capturedURL: URL?
        var capturedBaseDirectory: String?
        textView.linkHandler = { url, baseDirectory in
            capturedURL = url
            capturedBaseDirectory = baseDirectory
            return true
        }
        let link = try XCTUnwrap(URL(string: "/tmp/session%20workspace/File.swift:12"))

        let handled = textView.textView(textView, clickedOnLink: link, at: 0)

        XCTAssertTrue(handled)
        XCTAssertEqual(capturedURL, link)
        XCTAssertEqual(capturedBaseDirectory, "/tmp/session workspace")
    }

    func testUpdatingLinkWorkspaceDoesNotReconfigureCachedRowContent() throws {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.apply(rows: [row(id: "link", text: "[file](/tmp/file.swift)")])
        let cell = try XCTUnwrap(
            harness.coordinator.tableView(
                harness.tableView,
                viewFor: harness.tableView.tableColumns[0],
                row: 0
            ) as? AppKitChatNativeTextCell
        )
        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
        let configurationsBeforeUpdate = cell.contentConfigurationCount

        harness.coordinator.updateBaseDirectory(" /tmp/new-workspace ")

        XCTAssertEqual(body.linkBaseDirectory, "/tmp/new-workspace")
        XCTAssertEqual(cell.contentConfigurationCount, configurationsBeforeUpdate)
    }

    func testNativeCardUsesCommunityStyleCompactExecutionSummary() throws {
        let harness = makeHarness(followsLatest: true)
        let message = row(id: "message", text: "Ready")
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 0,
            nativeText: "",
            copyText: "command",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: false,
            processCount: 3,
            processDuration: "1.2s",
            processState: .completed
        )
        harness.coordinator.apply(rows: [message, process])

        let messageCell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        let card = try XCTUnwrap(view(in: messageCell, identifier: "chat.timeline.card"))
        XCTAssertEqual(card.layer?.cornerRadius, 14)
        XCTAssertEqual(card.layer?.borderWidth, NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 1 : 0.5)
        XCTAssertEqual(card.layer?.shadowOpacity, 0) // Shadows are clipped by reused timeline rows.
        let messageActions = try XCTUnwrap(view(in: messageCell, identifier: "chat.timeline.message-actions"))
        XCTAssertTrue(messageActions.isHidden)

        let processRowHeight = harness.tableView.rect(ofRow: 1).height
        XCTAssertGreaterThanOrEqual(processRowHeight, 32)
        let processCell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 1)
                as? AppKitChatNativeTextCell
        )
        let processButton = try XCTUnwrap(button(in: processCell, identifier: "chat.timeline.process"))
        let processCard = try XCTUnwrap(view(in: processCell, identifier: "chat.timeline.card"))
        XCTAssertEqual(processCard.layer?.borderWidth, NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 1 : 0.5)
        XCTAssertEqual(processCard.layer?.shadowOpacity, 0)
        let expected = ConversationProcessPresentation(state: .completed, count: 3, duration: "1.2s")
            .summary
        XCTAssertTrue(processButton.attributedTitle.string.contains(expected))
        XCTAssertLessThan(processCell.subviews[0].frame.width, harness.tableView.tableColumns[0].width)
    }

    func testPinnedProcessCollapseHandleStaysAtProcessEndAcrossScrolling() throws {
        var toggledTurnID: String?
        let harness = makeHarness(followsLatest: false, height: 240,
                                  onToggle: { toggledTurnID = $0 })
        let longText = Array(repeating: "Execution detail with a long result that wraps inside the card.",
                             count: 100).joined(separator: "\n")
        let process = AppKitChatTimelineRow(id: "long-process", contentRevision: 1,
            nativeText: longText, copyText: longText, nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "long-turn", isExpanded: true,
            processCount: 100, processDuration: "2m")
        harness.coordinator.apply(rows: [process])
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(harness.tableView.rect(ofRow: 0).height, 600)

        let collapse = try XCTUnwrap(button(in: harness.scrollView,
            identifier: "chat.timeline.process-follow-collapse"))
        XCTAssertFalse(collapse.isHidden)
        // The handle is pinned to the card's bottom edge, in document coordinates.
        let handleInTable = harness.tableView.convert(collapse.frame, from: collapse.superview)
        let cardBottom = harness.tableView.rect(ofRow: 0).maxY
        XCTAssertLessThan(handleInTable.maxY, cardBottom)
        XCTAssertEqual(handleInTable.maxY, cardBottom - 10, accuracy: 1)

        // Scrolling and live-resize geometry must never move the pinned handle.
        let pinnedFrame = collapse.frame
        let clip = harness.scrollView.contentView
        clip.scroll(to: NSPoint(x: 0, y: 200))
        harness.scrollView.reflectScrolledClipView(clip)
        XCTAssertEqual(collapse.frame, pinnedFrame)
        harness.coordinator.containerGeometryDidChange(isResizing: true)
        XCTAssertEqual(collapse.frame, pinnedFrame)

        collapse.performClick(nil)
        XCTAssertEqual(toggledTurnID, "long-turn")

        let compact = AppKitChatTimelineRow(id: "long-process", contentRevision: 2,
            nativeText: longText, copyText: longText, nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "long-turn", isExpanded: false,
            processCount: 100, processDuration: "2m")
        harness.coordinator.apply(rows: [compact])
        XCTAssertTrue(collapse.isHidden)
        XCTAssertLessThanOrEqual(clip.bounds.minY, 10)
    }

    func testProcessCollapseHandleIsHostedByTheMessageDocument() throws {
        let harness = makeHarness(followsLatest: false, height: 240)
        let collapse = try XCTUnwrap(button(in: harness.scrollView,
            identifier: "chat.timeline.process-follow-collapse"))
        XCTAssertTrue(collapse.superview === harness.scrollView.documentView,
            "the handle must scroll with the document, not float over the viewport")
        XCTAssertFalse(collapse.superview === harness.scrollView)
    }

    func testFloatingCollapseClampsToNewBottomAndResumesFollowingLatest() throws {
        let harness = makeHarness(followsLatest: false, height: 300)
        let history = row(id: "history", text: String(repeating: "Earlier message\n", count: 40))
        let latest = row(id: "latest", text: "Latest reply")
        let text = String(repeating: "Long execution detail\n", count: 150)
        func process(_ expanded: Bool) -> AppKitChatTimelineRow {
            AppKitChatTimelineRow(id: "process", contentRevision: expanded ? 1 : 2,
                nativeText: text, copyText: text, nativeStyle: .process, title: "", metadata: "",
                expandableTurnId: "turn", isExpanded: expanded, processCount: 150)
        }
        harness.coordinator.apply(rows: [history, process(true), latest])
        harness.window.layoutIfNeeded()
        let clip = harness.scrollView.contentView
        _ = harness.tableView.rowView(atRow: 1, makeIfNecessary: true)
        harness.tableView.noteHeightOfRows(withIndexesChanged: IndexSet(integer: 1))
        harness.tableView.layoutSubtreeIfNeeded()
        clip.scroll(to: NSPoint(x: 0, y: harness.tableView.rect(ofRow: 1).minY + 200))
        harness.scrollView.reflectScrolledClipView(clip)
        let collapse = try XCTUnwrap(button(in: harness.scrollView, identifier: "chat.timeline.process-follow-collapse"))
        XCTAssertFalse(collapse.isHidden)
        collapse.performClick(nil)
        harness.coordinator.apply(rows: [history, process(false), latest])
        harness.window.layoutIfNeeded()
        let document = try XCTUnwrap(harness.scrollView.documentView)
        XCTAssertGreaterThan(document.frame.height, clip.bounds.height)
        XCTAssertEqual(clip.bounds.minY, max(0, document.frame.height - clip.bounds.height), accuracy: 0.5)
        XCTAssertLessThanOrEqual(harness.tableView.rect(ofRow: 2).maxY + harness.tableView.frame.minY,
                                 clip.bounds.maxY + 0.5)
        XCTAssertTrue(harness.coordinator.followsLatest)
    }

    func testCollaborationCardShowsHeaderMetadataAndDistinctVisualTreatment() throws {
        let harness = makeHarness(followsLatest: true)
        let collaboration = AppKitChatTimelineRow(
            id: "collaboration",
            contentRevision: 1,
            nativeText: "**Message**\nPlease review this change.",
            copyText: "Please review this change.",
            nativeStyle: .agent,
            title: "Cross-session collaboration · Change request",
            metadata: "Processing · 08/20, 14:30",
            isCollaboration: true,
            collaborationRoute: NativeCollaborationRoutePresentation(
                destinationKind: .newCorptieTask,
                routeLabel: "A new CorptieTask will be created",
                sourceLabel: "Source",
                sourceSession: "Session · Platform planning",
                sourceWork: "Work · Platform",
                targetLabel: "Target",
                targetName: "CorptieTask · Review API",
                targetWork: "Work · macOS"
            ),
            expandableTurnId: nil,
            isExpanded: false,
            showsHeader: true
        )
        harness.coordinator.apply(rows: [collaboration])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let title = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.title"))
        let metadata = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.metadata"))
        let card = try XCTUnwrap(cell.subviews.first)

        XCTAssertFalse(title.isHidden)
        XCTAssertEqual(title.stringValue, "Cross-session collaboration · Change request")
        XCTAssertEqual(metadata.stringValue, "Processing · 08/20, 14:30")
        let route = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.collaboration-route"))
        XCTAssertFalse(route.isHidden)
        XCTAssertEqual(route.frame.height, NativeCollaborationRouteSummaryView.height)
        XCTAssertNotEqual(card.layer?.backgroundColor, NSColor.white.cgColor)
        XCTAssertLessThanOrEqual(card.frame.midX, cell.bounds.midX)
        XCTAssertGreaterThan(harness.tableView.rect(ofRow: 0).height, 130)
    }

    func testConfirmedCollaborationCardAcknowledgesConfirmationNotDelivery() throws {
        let harness = makeHarness(followsLatest: true)
        let pending = AppKitChatTimelineRow(
            id: "collaboration-confirmation",
            contentRevision: 1,
            nativeText: "**Message**\nPlease review this change.",
            copyText: "Please review this change.",
            nativeStyle: .agent,
            title: "Cross-session collaboration",
            metadata: "等待确认",
            isCollaboration: true,
            expandableTurnId: nil,
            isExpanded: false,
            showsHeader: true,
            actions: [.init(
                id: "confirm",
                label: L10n("确认发送"),
                isDestructive: false,
                kind: .collaborationConfirmation(id: "confirmation:one", approve: true)
            )]
        )
        let sent = AppKitChatTimelineRow(
            id: "collaboration-confirmation",
            contentRevision: 2,
            nativeText: "**Message**\nPlease review this change.",
            copyText: "Please review this change.",
            nativeStyle: .agent,
            title: "Cross-session collaboration",
            metadata: "已确认",
            isCollaboration: true,
            expandableTurnId: nil,
            isExpanded: false,
            showsHeader: true,
            actions: [],
            showsCollaborationSentStatus: true
        )
        harness.coordinator.apply(rows: [pending])
        harness.window.contentView?.layoutSubtreeIfNeeded()
        let pendingCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        XCTAssertNotNil(button(in: pendingCell, identifier: "chat.timeline.action.confirm"))

        harness.coordinator.apply(rows: [sent])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let status = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.collaboration-sent"))
        let icon = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.collaboration-sent-icon") as? NSImageView)
        let label = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.collaboration-sent-label"))

        XCTAssertFalse(status.isHidden)
        XCTAssertEqual(icon.contentTintColor, .systemGreen)
        XCTAssertEqual(label.stringValue, L10n("已确认"))
        XCTAssertEqual(label.textColor, .systemGreen)
        XCTAssertNil(button(in: cell, identifier: "chat.timeline.action.confirm"))
    }

    func testRunningExecutionSummaryIncludesElapsedDurationWhenAvailable() throws {
        let harness = makeHarness(followsLatest: true)
        let process = AppKitChatTimelineRow(
            id: "running-process",
            contentRevision: 0,
            nativeText: "",
            copyText: "command",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: false,
            processCount: 2,
            processDuration: "1m 12s",
            processState: .running
        )
        harness.coordinator.apply(rows: [process])

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let processButton = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))

        XCTAssertTrue(processButton.attributedTitle.string.contains("Working for 1m 12s"))
        XCTAssertTrue(processButton.attributedTitle.string.contains("2 steps"))
    }

    func testRunningProcessClockUpdatesOnlyVisibleCellWithoutReloadOrScroll() throws {
        let harness = makeHarness(followsLatest: false)
        let startedAt = Date(timeIntervalSince1970: 1_000)
        let process = AppKitChatTimelineRow(
            id: "running-clock", contentRevision: 1, nativeText: "", copyText: "",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn",
            isExpanded: false, processCount: 1, processDuration: "4.0s",
            processStartedAt: startedAt, processState: .running
        )
        harness.coordinator.apply(rows: [process])
        XCTAssertFalse(harness.coordinator.isProcessClockScheduled)
        harness.coordinator.setProcessClockEnabled(true)
        XCTAssertTrue(harness.coordinator.isProcessClockScheduled)

        let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0,
            makeIfNecessary: true) as? AppKitChatNativeTextCell)
        let button = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))
        let configurations = cell.contentConfigurationCount
        let rowHeight = harness.tableView.rect(ofRow: 0).height
        let scrollY = harness.scrollView.contentView.bounds.minY
        cell.refreshProcessElapsed(now: startedAt.addingTimeInterval(5))
        XCTAssertTrue(button.attributedTitle.string.contains("Working for 5s"))
        cell.refreshProcessElapsed(now: startedAt.addingTimeInterval(6))
        XCTAssertTrue(button.attributedTitle.string.contains("Working for 6s"))
        XCTAssertEqual(cell.contentConfigurationCount, configurations)
        XCTAssertEqual(harness.tableView.rect(ofRow: 0).height, rowHeight)
        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, scrollY)

        harness.coordinator.setProcessClockEnabled(false)
        XCTAssertFalse(harness.coordinator.isProcessClockScheduled)
        let final = AppKitChatTimelineRow(
            id: "running-clock", contentRevision: 2, nativeText: "", copyText: "",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn",
            isExpanded: false, processCount: 1, processDuration: "6.00s",
            processStartedAt: startedAt, processState: .completed
        )
        harness.coordinator.apply(rows: [final])
        harness.coordinator.setProcessClockEnabled(true)
        XCTAssertFalse(harness.coordinator.isProcessClockScheduled)
    }

    func testRunningProcessClockAdvancesWithoutAnyNewServerRows() async throws {
        let harness = makeHarness(followsLatest: false)
        let start = Date().addingTimeInterval(-4)
        let process = AppKitChatTimelineRow(
            id: "idle-stream-clock", contentRevision: 1, nativeText: "", copyText: "",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn",
            isExpanded: false, processCount: 1, processDuration: "4.0s",
            processStartedAt: start, processState: .running
        )
        harness.coordinator.apply(rows: [process])
        harness.window.layoutIfNeeded()
        let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0,
            makeIfNecessary: true) as? AppKitChatNativeTextCell)
        let button = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))
        let originalTitle = button.attributedTitle.string
        let originalConfigurations = cell.contentConfigurationCount
        harness.coordinator.setProcessClockEnabled(true)
        // The live clock ticks once per second; wait past one full cadence
        // rather than the old 100 ms sub-second interval.
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertNotEqual(button.attributedTitle.string, originalTitle)
        XCTAssertEqual(cell.contentConfigurationCount, originalConfigurations)
        harness.coordinator.setProcessClockEnabled(false)
    }

    func testStoppedProcessClockLeavesNoQueuedTick() async throws {
        let harness = makeHarness(followsLatest: false)
        let start = Date().addingTimeInterval(-4)
        let process = AppKitChatTimelineRow(
            id: "stopped-clock", contentRevision: 1, nativeText: "", copyText: "",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn",
            isExpanded: false, processCount: 1, processDuration: "4.0s",
            processStartedAt: start, processState: .running
        )
        harness.coordinator.apply(rows: [process])
        harness.window.layoutIfNeeded()
        let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0,
            makeIfNecessary: true) as? AppKitChatNativeTextCell)
        let button = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))
        harness.coordinator.setProcessClockEnabled(true)
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertTrue(harness.coordinator.isProcessClockScheduled)
        harness.coordinator.setProcessClockEnabled(false)
        XCTAssertFalse(harness.coordinator.isProcessClockScheduled)
        let stoppedTitle = button.attributedTitle.string
        // A tick queued before the stop must neither write to the cell nor
        // reschedule itself: ending a turn leaves nothing running behind.
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertEqual(button.attributedTitle.string, stoppedTitle)
    }

    func testTerminalExecutionSummariesKeepElapsedDurationAcrossOutcomes() {
        let failed = AppKitChatTimelineRow(
            id: "failed",
            contentRevision: 0,
            nativeText: "",
            copyText: "",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "failed-turn",
            isExpanded: false,
            processCount: 1,
            processDuration: "17s",
            processState: .failed
        )
        let cancelled = AppKitChatTimelineRow(
            id: "cancelled",
            contentRevision: 0,
            nativeText: "",
            copyText: "",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "cancelled-turn",
            isExpanded: false,
            processCount: 3,
            processDuration: "1m 4s",
            processState: .cancelled
        )

        XCTAssertEqual(failed.processSummaryText(languageCode: "en"), "Execution failed after 17s · 1 step")
        XCTAssertEqual(cancelled.processSummaryText(languageCode: "en"), "Execution stopped after 1m 4s · 3 steps")
    }

    func testExpandedExecutionPlacesSummaryBeforeStepDetails() throws {
        let harness = makeHarness(followsLatest: true)
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 1,
            nativeText: "⌘  **Ran tests**\n    swift test",
            copyText: "swift test",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: 1,
            processDuration: "4.2s",
            processState: .running,
            showsHeader: false
        )
        harness.coordinator.apply(rows: [process])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let summary = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))
        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))

        XCTAssertTrue(summary.attributedTitle.string.contains("Working for 4.2s"))
        XCTAssertGreaterThan(summary.frame.minY, body.frame.maxY)
        XCTAssertGreaterThan(harness.tableView.rect(ofRow: 0).height, 54)
    }

    func testExpandedExecutionShowsRawStatusInBoundedScrollableArea() throws {
        let harness = makeHarness(followsLatest: true, height: 520)
        let rawStatus = "Raw status\n" + String(repeating: "{\"event\":\"tool\",\"status\":\"running\"}\n", count: 80)
        let process = AppKitChatTimelineRow(
            id: "process-with-raw-status",
            contentRevision: 1,
            nativeText: "⌘  Running command",
            rawStatusText: rawStatus,
            copyText: "Running command\n\n\(rawStatus)",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: 1,
            processState: .running,
            showsHeader: false
        )
        harness.coordinator.apply(rows: [process])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let rawArea = try XCTUnwrap(
            view(in: cell, identifier: "chat.timeline.raw-status") as? NSScrollView
        )
        let rawTextView = try XCTUnwrap(rawArea.documentView as? NSTextView)

        XCTAssertFalse(rawArea.isHidden)
        XCTAssertTrue(rawArea.hasVerticalScroller)
        XCTAssertEqual(
            LegacyTimelineLayoutReference.shared.layout(
                for: process,
                columnWidth: harness.tableView.tableColumns[0].width
            ).rawStatusHeight,
            160
        )
        XCTAssertLessThanOrEqual(rawArea.frame.height, 164)
        XCTAssertEqual(rawTextView.string, rawStatus)
        XCTAssertTrue(rawTextView.font.map { NSFontManager.shared.traits(of: $0).contains(.fixedPitchFontMask) } == true)
    }

    func testOrdinaryNativeMessageMovesTimestampAndCopyIntoContextMenu() throws {
        // Keep the legacy renderer baseline while shared-card coverage lives
        // in MessageTextCardMigrationTests.
        let harness = makeHarness(followsLatest: true, useSharedTextCards: false)
        let message = row(
            id: "ordinary-message",
            text: "Ready",
            showsHeader: false,
            contextTimestamp: "08/17 20:30"
        )
        harness.coordinator.apply(rows: [message])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let title = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.title"))
        let metadata = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.metadata"))
        let messageActions = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.message-actions"))
        let timestamp = try XCTUnwrap(menuItem(in: cell.menu, identifier: "chat.timeline.context.timestamp"))
        let copy = try XCTUnwrap(menuItem(in: cell.menu, identifier: "chat.timeline.context.copy"))

        XCTAssertTrue(title.isHidden)
        XCTAssertTrue(metadata.isHidden)
        XCTAssertTrue(messageActions.isHidden)
        XCTAssertTrue(timestamp.title.contains("08/17 20:30"))
        XCTAssertEqual(copy.title, L10n("Copy Message"))
        XCTAssertLessThan(
            harness.tableView.rect(ofRow: 0).height - harness.tableView.intercellSpacing.height,
            40
        )
    }

    func testOrdinaryMessageContextMenusAreExcludedFromExecutionRows() throws {
        let harness = makeHarness(followsLatest: true, useSharedTextCards: false)
        let agent = row(
            id: "agent-message",
            text: "First line\nSecond line",
            copyText: "First line\nSecond line",
            showsHeader: false,
            contextTimestamp: "08/17 20:30"
        )
        let user = row(
            id: "user-message",
            text: "Question",
            nativeStyle: .user,
            showsHeader: false,
            contextTimestamp: "08/17 20:31"
        )
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 0,
            nativeText: "swift test",
            copyText: "swift test",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: 1,
            processDuration: "2s",
            processState: .completed,
            showsHeader: false
        )
        harness.coordinator.apply(rows: [agent, user, process])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let agentCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        agentCell.layoutSubtreeIfNeeded()
        let roleCard = try XCTUnwrap(view(in: agentCell, identifier: "chat.timeline.card"))
        let agentActions = try XCTUnwrap(view(in: agentCell, identifier: "chat.timeline.message-actions"))
        let copy = try XCTUnwrap(menuItem(in: agentCell.menu, identifier: "chat.timeline.context.copy"))
        XCTAssertTrue(agentActions.isHidden)

        NSApp.sendAction(try XCTUnwrap(copy.action), to: copy.target, from: copy)
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "First line\nSecond line")

        let userCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        userCell.layoutSubtreeIfNeeded()
        let userCard = try XCTUnwrap(view(in: userCell, identifier: "chat.timeline.card"))
        let userActions = try XCTUnwrap(view(in: userCell, identifier: "chat.timeline.message-actions"))
        XCTAssertTrue(userActions.isHidden)
        XCTAssertNotNil(menuItem(in: userCell.menu, identifier: "chat.timeline.context.timestamp"))
        XCTAssertFalse(
            try XCTUnwrap(NSColor(cgColor: userCard.layer?.backgroundColor ?? CGColor.clear))
                .isEqual(try XCTUnwrap(NSColor(cgColor: roleCard.layer?.backgroundColor ?? CGColor.clear)))
        )

        let processCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 2, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let processActions = try XCTUnwrap(view(in: processCell, identifier: "chat.timeline.message-actions"))
        XCTAssertTrue(processActions.isHidden)
        XCTAssertNil(processCell.menu)
    }

    func testTimeSeparatorMetadataDoesNotAddASecondTimestampRow() {
        let start = Date(timeIntervalSince1970: 1_000)
        let rows = [
            row(id: "first", messageDate: start),
            row(id: "short-gap", messageDate: start.addingTimeInterval(299)),
            row(id: "long-gap", messageDate: start.addingTimeInterval(599))
        ]

        let decorated = ConversationTimeSeparatorPolicy.applying(
            to: rows, now: start.addingTimeInterval(600)
        )

        XCTAssertNil(decorated[0].timeSeparatorText)
        XCTAssertNil(decorated[1].timeSeparatorText)
        XCTAssertNotNil(decorated[2].timeSeparatorText)
        XCTAssertEqual(decorated.filter { $0.timeSeparatorText != nil }.count, 1)
        XCTAssertEqual(
            LegacyTimelineLayoutReference.shared.layout(for: decorated[2], columnWidth: 400).rowHeight,
            LegacyTimelineLayoutReference.shared.layout(for: rows[2], columnWidth: 400).rowHeight
        )
    }

    func testTimeSeparatorIncludesDateAcrossCalendarDays() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let locale = Locale(identifier: "en_US_POSIX")
        let first = calendar.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 23, minute: 58))!
        let second = calendar.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 0, minute: 5))!

        let decorated = ConversationTimeSeparatorPolicy.applying(
            to: [row(id: "first", messageDate: first), row(id: "second", messageDate: second)],
            now: second.addingTimeInterval(60), calendar: calendar, locale: locale
        )

        XCTAssertTrue(decorated[1].timeSeparatorText?.contains("2026") == true)
    }

    func testPrependingHistoryRecomputesOnlyTheNewGapBoundary() {
        let start = Date(timeIntervalSince1970: 1_000)
        let later = row(id: "later", messageDate: start.addingTimeInterval(301))

        let initial = ConversationTimeSeparatorPolicy.applying(to: [later], now: later.messageDate!)
        let prepended = ConversationTimeSeparatorPolicy.applying(
            to: [row(id: "earlier", messageDate: start), later],
            now: later.messageDate!
        )

        XCTAssertNil(initial[0].timeSeparatorText)
        XCTAssertNil(prepended[0].timeSeparatorText)
        XCTAssertNotNil(prepended[1].timeSeparatorText)
        XCTAssertEqual(prepended.filter { $0.timeSeparatorText != nil }.count, 1)
        XCTAssertNotEqual(initial[0].contentRevision, prepended[1].contentRevision)
    }

    func testNativeTimelineHidesCenteredSeparatorsAtTheGapBoundary() throws {
        let harness = makeHarness(followsLatest: true, useSharedTextCards: false)
        let start = Date(timeIntervalSince1970: 1_000)
        harness.coordinator.apply(rows: [
            row(id: "first", messageDate: start),
            row(id: "second", messageDate: start.addingTimeInterval(301))
        ])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let first = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let second = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let firstSeparator = try XCTUnwrap(textField(in: first, identifier: "chat.timeline.time-separator"))
        let secondSeparator = try XCTUnwrap(textField(in: second, identifier: "chat.timeline.time-separator"))
        XCTAssertTrue(firstSeparator.isHidden)
        XCTAssertTrue(secondSeparator.isHidden)
        XCTAssertEqual(secondSeparator.alignment, .center)
    }

    func testSingleColumnUsesViewportWidthWithoutAnUnusedScrollerGutter() async {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.apply(rows: [row(id: "message", text: "Ready")])
        harness.window.setContentSize(NSSize(width: 620, height: 320))
        harness.window.layoutIfNeeded()
        NotificationCenter.default.post(
            name: NSView.frameDidChangeNotification,
            object: harness.scrollView
        )
        await settleMainQueue()

        harness.scrollView.scrollerStyle = .legacy
        XCTAssertEqual(harness.scrollView.scrollerStyle, .overlay)
        XCTAssertEqual(harness.scrollView.contentView.bounds.width, harness.scrollView.bounds.width, accuracy: 1)
        XCTAssertFalse(harness.scrollView.drawsBackground)
        XCTAssertFalse(harness.scrollView.contentView.drawsBackground)
        let expectedWidth = harness.scrollView.bounds.width
        XCTAssertEqual(harness.tableView.tableColumns[0].width, expectedWidth, accuracy: 1)
        harness.scrollView.verticalScroller?.isHidden = true
        XCTAssertEqual(harness.tableView.tableColumns[0].width, expectedWidth, accuracy: 1)
        harness.scrollView.verticalScroller?.isHidden = false
        XCTAssertEqual(harness.tableView.tableColumns[0].width, expectedWidth, accuracy: 1)
        XCTAssertEqual(harness.tableView.style, .plain)
        XCTAssertEqual(harness.tableView.rect(ofColumn: 0).minX, 0, accuracy: 0.5)
    }

    func testUserCardsReachViewportTrailingEdgeInBothRenderers() throws {
        for shared in [false, true] {
            let harness = makeHarness(followsLatest: false, useSharedTextCards: shared)
            for skin in [ConversationSkin.classic, .codexFlat] {
                harness.coordinator.updateSkin(skin)
                let user = row(id: "right-aligned-user", text: "A short user message", nativeStyle: .user, showsHeader: false)
                harness.coordinator.apply(rows: [user])
                harness.window.layoutIfNeeded()
                let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true))
                cell.layoutSubtreeIfNeeded()
                let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
                let bodyFrame = body.convert(body.bounds, to: harness.scrollView.contentView)
                // The main-window skin has a reading-lane gutter; the card
                // itself keeps the same 10pt padding plus 2pt trailing inset.
                let viewportWidth = harness.scrollView.contentView.bounds.width
                let lane = CGRect(x: 0, y: 0, width: viewportWidth, height: 0)
                XCTAssertEqual(harness.scrollView.contentView.bounds.maxX - bodyFrame.maxX,
                    viewportWidth - lane.maxX + 12, accuracy: 1)
                XCTAssertEqual(harness.tableView.tableColumns[0].width, lane.width, accuracy: 1)
            }
        }
    }

    func testCompactTimelineUsesFullWidthAcrossResizeAndScrollerVisibility() async {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.setReservesVerticalScrollerGutter(false)
        // Simulate AppKit restoring the system preference while tiling.
        harness.scrollView.scrollerStyle = .legacy
        XCTAssertEqual(harness.scrollView.scrollerStyle, .overlay)
        for width: CGFloat in [220, 560, 800] {
            harness.window.setContentSize(NSSize(width: width, height: 320))
            for count in [1, 40, 1] {
                harness.coordinator.apply(rows: (0..<count).map {
                    row(id: "message-\($0)", text: "A user message that wraps in a narrow floating window", nativeStyle: .user)
                })
                harness.window.layoutIfNeeded()
                NotificationCenter.default.post(name: NSView.frameDidChangeNotification, object: harness.scrollView)
                await settleMainQueue()
                XCTAssertEqual(harness.tableView.tableColumns[0].width, harness.scrollView.bounds.width, accuracy: 1)
                XCTAssertEqual(harness.scrollView.scrollerStyle, .overlay)
                XCTAssertEqual(harness.scrollView.contentView.bounds.width, harness.scrollView.bounds.width, accuracy: 1)
            }
        }
    }

    func testUnbrokenModelTextWrapsInsideTheCardBoundary() throws {
        let harness = makeHarness(followsLatest: false, height: 320)
        let token = String(repeating: "https://example.com/very-long-path-without-breaks-0123456789", count: 12)
        harness.coordinator.apply(rows: [row(id: "long-token", text: token, showsHeader: false)])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let card = try XCTUnwrap(cell.subviews.first)
        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
        let bodyFrame = body.convert(body.bounds, to: cell)
        let cardFrame = card.convert(card.bounds, to: cell)

        XCTAssertLessThanOrEqual(bodyFrame.maxX, cardFrame.maxX + 1)
        XCTAssertLessThanOrEqual(bodyFrame.maxY, cardFrame.maxY + 1)
        XCTAssertEqual(body.laidOutCharacterRange, NSRange(location: 0, length: body.string.utf16.count))
        XCTAssertGreaterThan(body.textContainer?.containerSize.height ?? 0, body.bounds.height)
        XCTAssertTrue(hasVisiblePixels(in: body), "The message body must draw visible text pixels")
        XCTAssertGreaterThan(harness.tableView.rect(ofRow: 0).height, 60)
    }

    func testStructuralPrependRestoresStableVisibleAnchor() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<30).map { row(id: "old-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.layoutSubtreeIfNeeded()
        harness.tableView.scrollRowToVisible(14)
        await settleMainQueue()

        let before = visibleAnchor(in: harness.tableView, rows: original)
        let prepended = (0..<8).map { row(id: "new-\($0)", text: "Earlier row \($0)") } + original
        harness.coordinator.apply(rows: prepended)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: prepended)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)
    }

    func testHistoryPrependCompensatesBeforeNextWheelEvent() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "atomic-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: harness.tableView.rect(ofRow: 12).minY + 7))
        let before = visibleAnchor(in: harness.tableView, rows: original)
        let prepended = (0..<25).map { row(id: "earlier-atomic-\($0)", text: "Earlier row \($0)") } + original
        harness.coordinator.apply(rows: prepended)
        // No run-loop turn: the next input must see the compensated geometry.
        let inserted = visibleAnchor(in: harness.tableView, rows: prepended)
        XCTAssertEqual(inserted.id, before.id)
        XCTAssertEqual(inserted.offset, before.offset, accuracy: 1)
        harness.coordinator.userScrollEventWillBegin()
        let targetY = harness.scrollView.contentView.bounds.minY - 20
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: targetY))
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()
        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, targetY, accuracy: 1)
    }

    func testHistoryPrependDuringScrollbarTrackingPreservesMessage() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "tracking-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: harness.tableView.rect(ofRow: 10).minY + 4))
        harness.coordinator.userScrollEventWillBegin()
        let before = visibleAnchor(in: harness.tableView, rows: original)
        let prepended = (0..<20).map { row(id: "earlier-tracking-\($0)", text: "Earlier row \($0)") } + original
        harness.coordinator.apply(rows: prepended)
        let after = visibleAnchor(in: harness.tableView, rows: prepended)
        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 1)
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()
        XCTAssertEqual(visibleAnchor(in: harness.tableView, rows: prepended).id, before.id)
    }

    func testHistoryPrependPreservesAnchorAtInterRowGapWithStaleFollowFlag() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let original = (0..<40).map { row(id: "gap-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        await settleMainQueue()
        let y = harness.tableView.rect(ofRow: 10).maxY + 2
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        XCTAssertEqual(harness.tableView.row(at: NSPoint(x: 1, y: y)), 11)
        let relativeY = y - harness.tableView.rect(ofRow: 11).minY
        let prepended = (0..<20).map { row(id: "earlier-gap-\($0)", text: "Earlier row \($0)") } + original
        harness.coordinator.apply(rows: prepended)
        XCTAssertEqual(harness.scrollView.contentView.bounds.minY - harness.tableView.rect(ofRow: 31).minY,
                       relativeY, accuracy: 1)
        await settleMainQueue()
        XCTAssertEqual(harness.scrollView.contentView.bounds.minY - harness.tableView.rect(ofRow: 31).minY,
                       relativeY, accuracy: 1)
        XCTAssertFalse(harness.coordinator.followsLatest)
    }

    func testConsecutiveHistoryPagesPreserveOffsetInsideLongMessageImmediately() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        harness.coordinator.setTopClearance(54)
        let original = (0..<30).map {
            row(id: "long-history-\($0)", text: String(repeating: "Long historical message. ", count: 100))
        }
        harness.coordinator.apply(rows: original)
        await settleMainQueue()
        harness.coordinator.restore(position: .init(rowID: "long-history-7", offset: 230,
            absoluteScrollY: 0, followsLatest: false))
        await settleMainQueue()
        var rows = original
        for page in 0..<3 {
            rows = (0..<200).map {
                row(id: "page-\(page)-\($0)", text: "Earlier message \($0)")
            } + rows
            harness.coordinator.apply(rows: rows)
            let index = (page + 1) * 200 + 7
            XCTAssertEqual(harness.scrollView.contentView.bounds.minY - harness.tableView.rect(ofRow: index).minY,
                           230, accuracy: 1)
        }
        await settleMainQueue()
        XCTAssertEqual(harness.scrollView.contentView.bounds.minY - harness.tableView.rect(ofRow: 607).minY,
                       230, accuracy: 1)
    }

    func testTransientEmptyProjectionPreservesReaderAcrossStreamedRowReturn() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "transient-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.layoutSubtreeIfNeeded()
        harness.tableView.scrollRowToVisible(18)
        await settleMainQueue()
        let before = visibleAnchor(in: harness.tableView, rows: original)

        // Reproduce an async display projection replacing the current cache:
        // one empty publication is followed by the same semantic rows with a
        // streamed tail revision.
        harness.coordinator.apply(rows: [])
        let streamed = Array(original.dropLast()) + [
            row(id: "transient-39", revision: 1, text: "Streamed tail update")
        ]
        harness.coordinator.apply(rows: streamed)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: streamed)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
        XCTAssertNotEqual(after.id, streamed.first?.id)
    }

    func testTransientEmptyProjectionPreservesLatestFollowMode() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let original = (0..<40).map { row(id: "empty-follow-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: original)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        harness.coordinator.apply(rows: [])
        harness.coordinator.apply(rows: original + [row(id: "empty-follow-40", text: "New message")])
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
    }

    func testTransientEmptyProjectionWithReplacedWindowDegradesToLatestNotOldest() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "removed-\($0)", text: "Old row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.scrollRowToVisible(18)
        await settleMainQueue()

        harness.coordinator.apply(rows: [])
        let replacement = (0..<40).map { row(id: "replacement-\($0)", text: "New row \($0)") }
        harness.coordinator.apply(rows: replacement)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testExplicitJumpToLatestWinsDuringTransientEmptyProjection() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "empty-jump-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.scrollRowToVisible(18)
        await settleMainQueue()

        harness.coordinator.apply(rows: [])
        harness.coordinator.scrollToBottom()
        harness.coordinator.apply(rows: original + [row(id: "empty-jump-40", text: "Newest")])
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
    }

    func testSafeAreaComposerReservesNativeTimelineViewport() async throws {
        let rows = (0..<30).map { row(id: "safe-area-\($0)", text: "Message \($0)") }
        let timeline = AppKitChatTimelineView(
            sessionID: "safe-area-test", rows: rows, scrollToBottomRevision: 0,
            followsLatest: .constant(true), onToggleExpansion: { _ in }
        )
        let host = NSHostingView(rootView: timeline
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: 96)
            }
            .frame(width: 420, height: 320))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 320),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = host
        window.layoutIfNeeded()
        await settleMainQueue()

        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let scroll = try XCTUnwrap(descendants(host).compactMap { $0 as? FirstLayoutRestoringScrollView }.first)
        let document = try XCTUnwrap(scroll.documentView)
        let table = try XCTUnwrap(document.subviews.compactMap { $0 as? NSTableView }.first)
        XCTAssertEqual(scroll.frame.height, 224, accuracy: 2)
        XCTAssertEqual(table.frame.height, table.rect(ofRow: rows.count - 1).maxY, accuracy: 1)
        XCTAssertEqual(scroll.contentView.documentRect.height, document.frame.height, accuracy: 1)
    }

    func testNativeDocumentClearanceKeepsLatestRowAboveGlassWithoutShrinkingViewport() async {
        let harness = makeHarness(followsLatest: true, height: 320)
        let rows = (0..<30).map { row(id: "glass-clearance-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setBottomClearance(96)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let lastRowBottom = harness.tableView.rect(ofRow: rows.count - 1).maxY
        XCTAssertEqual(harness.scrollView.contentView.bounds.height, 320, accuracy: 2)
        XCTAssertEqual(harness.scrollView.contentInsets.bottom, 0, accuracy: 1)
        XCTAssertEqual(harness.tableView.frame.height, lastRowBottom, accuracy: 1)
        XCTAssertEqual(harness.scrollView.documentView?.frame.height ?? 0, lastRowBottom + 96, accuracy: 1)
        XCTAssertLessThanOrEqual(lastRowBottom,
                                 harness.scrollView.contentView.bounds.maxY - 96 + 2)
    }

    func testNativeScrollRangeIncludesComposerClearance() async {
        let harness = makeHarness(followsLatest: false, height: 320)
        let rows = (0..<30).map { row(id: "native-end-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setBottomClearance(96)
        await settleMainQueue()

        let lastRowBottom = harness.tableView.rect(ofRow: rows.count - 1).maxY
        let naturalBottom = (harness.scrollView.documentView?.frame.height ?? 0)
            - harness.scrollView.contentView.bounds.height
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: naturalBottom))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        XCTAssertLessThanOrEqual(lastRowBottom,
                                 harness.scrollView.contentView.bounds.maxY - 96 + 2)
    }

    func testNormalFlowEditorBoundsViewportAndOnlyQuickActionsReserveDocumentSpace() async throws {
        let rows = (0..<30).map { row(id: "flow-\($0)", text: "Message \($0)") }
        for (width, editorHeight) in [(CGFloat(420), CGFloat(96)), (680, 180), (1000, 96)] {
            let host = NSHostingView(rootView: NormalFlowComposerFixture(rows: rows, editorHeight: editorHeight)
                .frame(width: width, height: 600))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 600),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            window.layoutIfNeeded()
            await settleMainQueue()
            window.layoutIfNeeded()
            await settleMainQueue()
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            let scroll = try XCTUnwrap(descendants(host).compactMap { $0 as? FirstLayoutRestoringScrollView }.first)
            let document = try XCTUnwrap(scroll.documentView)
            let table = try XCTUnwrap(document.subviews.compactMap { $0 as? NSTableView }.first)
            let editor = try XCTUnwrap(view(in: host, identifier: "test.flow.editor"))
            let actions = try XCTUnwrap(view(in: host, identifier: "test.flow.actions"))
            let editorFrame = editor.convert(editor.bounds, to: host)
            let viewportFrame = scroll.convert(scroll.bounds, to: host)
            let actionsFrame = actions.convert(actions.bounds, to: host)
            XCTAssertEqual(viewportFrame.maxY, editorFrame.minY, accuracy: 1)
            XCTAssertEqual(viewportFrame.height, 600 - 48 - editorHeight, accuracy: 1)
            XCTAssertEqual(document.frame.height - table.frame.maxY, 40, accuracy: 1)
            let bottomY = max(0, document.frame.height - scroll.contentView.bounds.height)
            scroll.contentView.scroll(to: NSPoint(x: 0, y: bottomY))
            scroll.reflectScrolledClipView(scroll.contentView)
            let lastRow = table.convert(table.rect(ofRow: rows.count - 1), to: host)
            XCTAssertLessThanOrEqual(lastRow.maxY, actionsFrame.minY - 5)
            // History uses the full viewport, including the space behind the chips.
            scroll.contentView.scroll(to: NSPoint(x: 0, y: bottomY / 2))
            scroll.reflectScrolledClipView(scroll.contentView)
            XCTAssertTrue(table.convert(table.bounds, to: host).intersects(actionsFrame))
        }
    }

    func testNativeDocumentKeepsBothEndpointRowsOutsideChrome() async {
        let harness = makeHarness(followsLatest: true, height: 320)
        let rows = (0..<30).map { row(id: "two-sided-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setTopClearance(82)
        harness.coordinator.setBottomClearance(106)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()

        let lastRowBottom = harness.tableView.frame.minY
            + harness.tableView.rect(ofRow: rows.count - 1).maxY
        XCTAssertEqual(harness.tableView.frame.minY, 82, accuracy: 1)
        XCTAssertEqual(harness.scrollView.documentView?.frame.height ?? 0,
                       lastRowBottom + 106, accuracy: 1)
        XCTAssertLessThanOrEqual(lastRowBottom,
                                 harness.scrollView.contentView.bounds.maxY - 106 + 2)

        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        XCTAssertGreaterThanOrEqual(harness.tableView.frame.minY
                                    + harness.tableView.rect(ofRow: 0).minY,
                                    harness.scrollView.contentView.bounds.minY + 82 - 2)
    }

    func testHeaderHeightChangeKeepsHistoryReaderOnSameMessage() async {
        var published: AppKitChatTimelinePosition?
        let harness = makeHarness(
            followsLatest: false,
            height: 320,
            onPositionChange: { published = $0 }
        )
        let rows = (0..<40).map { row(id: "header-resize-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setTopClearance(82)
        harness.coordinator.setBottomClearance(106)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: harness.tableView.rect(ofRow: 15).minY + 5))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.publishPositionImmediately()
        let before = published

        harness.coordinator.setTopClearance(124)
        await settleMainQueue()
        harness.coordinator.publishPositionImmediately()
        XCTAssertEqual(published?.rowID, before?.rowID)
        XCTAssertEqual(published?.offset ?? -1, before?.offset ?? -2, accuracy: 2)
    }

    func testMeasuredSwiftUIComposerInsetReachesNativeTimeline() async throws {
        let rows = (0..<30).map { row(id: "measured-glass-\($0)", text: "Message \($0)") }
        let host = NSHostingView(rootView: MeasuredComposerTimelineFixture(rows: rows)
            .frame(width: 420, height: 320))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 320),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = host
        window.layoutIfNeeded()
        await settleMainQueue()
        window.layoutIfNeeded()
        await settleMainQueue()

        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let scroll = try XCTUnwrap(descendants(host).compactMap { $0 as? FirstLayoutRestoringScrollView }.first)
        let document = try XCTUnwrap(scroll.documentView)
        let table = try XCTUnwrap(document.subviews.compactMap { $0 as? NSTableView }.first)
        let lastRowBottom = table.rect(ofRow: rows.count - 1).maxY
        XCTAssertEqual(scroll.frame.height, 320, accuracy: 2)
        XCTAssertEqual(scroll.contentInsets.bottom, 0, accuracy: 2)
        XCTAssertEqual(table.frame.height, lastRowBottom, accuracy: 2)
        XCTAssertEqual(document.frame.height, lastRowBottom + 96, accuracy: 2)
        XCTAssertLessThanOrEqual(lastRowBottom, scroll.contentView.bounds.maxY - 96 + 2)
    }

    func testGrowingComposerInsetAndAppendingMessagePreservesLatestFollow() async {
        let harness = makeHarness(followsLatest: true, height: 320)
        var rows = (0..<30).map { row(id: "growing-glass-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setBottomClearance(48)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()

        rows.append(row(id: "growing-glass-newest", text: "Newest message"))
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setBottomClearance(112)
        await settleMainQueue()

        let lastRowBottom = harness.tableView.rect(ofRow: rows.count - 1).maxY
        XCTAssertTrue(harness.followState.value)
        XCTAssertLessThanOrEqual(lastRowBottom,
                                 harness.scrollView.contentView.bounds.maxY - 112 + 2)
    }

    func testComposerInsetGrowthPreservesHistoryReaderAnchor() async {
        let harness = makeHarness(followsLatest: false, height: 320)
        let rows = (0..<40).map { row(id: "history-glass-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.setBottomClearance(48)
        harness.tableView.scrollRowToVisible(15)
        await settleMainQueue()
        let before = visibleAnchor(in: harness.tableView, rows: rows)

        harness.coordinator.setBottomClearance(112)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: rows)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 2)
        XCTAssertFalse(harness.followState.value)
    }

    func testDirectScrollbarJumpMaterializesTheLastMessageWithoutIntermediatePrewarming() async throws {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<40).map { index in
            row(
                id: "direct-jump-\(index)",
                text: index == 39
                    ? String(repeating: "Final message remains visible. ", count: 18)
                    : "Message \(index)"
            )
        }
        harness.coordinator.apply(rows: rows)
        XCTAssertTrue(harness.tableView.usesAutomaticRowHeights)

        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let lastIndex = rows.count - 1
        let lastRect = harness.tableView.rect(ofRow: lastIndex)
        XCTAssertTrue(harness.tableView.visibleRect.intersects(lastRect))
        XCTAssertNotNil(
            harness.tableView.view(atColumn: 0, row: lastIndex, makeIfNecessary: false),
            "A direct scrollbar jump must materialize the destination cell"
        )
        XCTAssertLessThanOrEqual(
            max(0, harness.tableView.visibleRect.maxY - lastRect.maxY),
            harness.tableView.intercellSpacing.height + 2
        )
    }

    func testExplicitTurnJumpIsAnAuthoritativeProgrammaticScroll() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<40).map { index in
            row(
                id: "turn-jump-row-\(index)",
                text: "Message \(index)",
                expandableTurnId: "turn-\(index)"
            )
        }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.scrollToTurn("turn-18")
        await settleMainQueue()

        XCTAssertTrue(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: 18)))
        XCTAssertFalse(harness.followState.value)
    }

    func testDocumentAndScrollerShareTheLastMessageAsTheirNaturalBottom() async throws {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<20).map { row(id: "bounded-scroll-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.window.contentView?.layoutSubtreeIfNeeded()

        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        let lastRowRect = harness.tableView.rect(ofRow: rows.count - 1)

        XCTAssertEqual(harness.tableView.frame.height, lastRowRect.maxY, accuracy: 1)
        XCTAssertEqual(harness.scrollView.documentVisibleRect.maxY, lastRowRect.maxY, accuracy: 2)
        XCTAssertEqual(
            harness.scrollView.contentView.bounds.maxY,
            lastRowRect.maxY,
            accuracy: 2
        )
        XCTAssertTrue(harness.tableView.visibleRect.intersects(lastRowRect))
        let scroller = try XCTUnwrap(harness.scrollView.verticalScroller)
        XCTAssertEqual(scroller.floatValue, 1, accuracy: 0.01)
    }

    func testFollowBindingTracksWhetherViewportIsAtBottom() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<24).map { row(id: "follow-state-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        XCTAssertTrue(harness.followState.value)

        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()

        XCTAssertFalse(harness.followState.value)

        harness.coordinator.scrollToBottom()
        await settleMainQueue()

        XCTAssertTrue(harness.followState.value)
    }

    func testSavedSessionPositionRestoresMessageAnchorAndFollowMode() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "session-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()

        harness.coordinator.restore(position: AppKitChatTimelinePosition(
            rowID: "session-row-12",
            offset: 6,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        await settlePositionPublication()

        let anchor = visibleAnchor(in: harness.tableView, rows: rows)
        XCTAssertEqual(anchor.id, "session-row-12")
        XCTAssertEqual(anchor.offset, 6, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
    }

    func testMissingSemanticAnchorIgnoresStaleAbsoluteYAndDegradesToLatest() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "fallback-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()

        harness.coordinator.restore(position: AppKitChatTimelinePosition(
            rowID: "message-no-longer-loaded",
            offset: 6,
            absoluteScrollY: 240,
            followsLatest: false
        ))
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertNotEqual(harness.scrollView.contentView.bounds.minY, 240, accuracy: 2)
        XCTAssertTrue(harness.followState.value)
    }

    func testPendingSessionRestoreSurvivesAProjectionChangeBeforeLayoutCompletes() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "pending-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()

        harness.coordinator.restore(position: AppKitChatTimelinePosition(
            rowID: "pending-row-12",
            offset: 5,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        let prepended = [row(id: "pending-history", text: "Earlier history")] + rows
        harness.coordinator.apply(rows: prepended)
        await settlePositionPublication()

        let anchor = visibleAnchor(in: harness.tableView, rows: prepended)
        XCTAssertEqual(anchor.id, "pending-row-12")
        XCTAssertEqual(anchor.offset, 5, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
    }

    func testInitialSessionPositionIsRestoredInsideTheFirstLayoutPass() {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "first-frame-row-\($0)", text: "Row \($0)") }
        harness.coordinator.prepareInitialPosition(AppKitChatTimelinePosition(
            rowID: "first-frame-row-12",
            offset: 4,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        harness.coordinator.apply(rows: rows)

        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()

        let anchor = visibleAnchor(in: harness.tableView, rows: rows)
        XCTAssertEqual(anchor.id, "first-frame-row-12")
        XCTAssertEqual(anchor.offset, 4, accuracy: 4)
        XCTAssertFalse(harness.coordinator.followsLatest)
    }

    func testInitialLatestPositionIsAtBottomInsideTheFirstLayoutPass() {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<30).map { row(id: "first-bottom-row-\($0)", text: "Row \($0)") }
        harness.coordinator.prepareInitialScrollToBottom()
        harness.coordinator.apply(rows: rows)

        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.coordinator.followsLatest)
    }

    func testFirstOpenOfSessionWithoutSavedPositionDefaultsToLatestMessage() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<80).map { row(id: "unseen-row-\($0)", text: "Row \($0)") }

        harness.coordinator.switchSessionIfNeeded(
            to: "never-opened-session",
            initialPosition: nil
        )
        harness.coordinator.apply(rows: rows)
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        await settlePositionPublication()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testLatestSavedPositionCannotRestoreItsStaleRowAnchor() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<80).map { row(id: "latest-row-\($0)", text: "Row \($0)") }
        let latestPosition = AppKitChatTimelinePosition(
            rowID: "latest-row-5",
            offset: 3,
            absoluteScrollY: 0,
            followsLatest: true
        )

        harness.coordinator.switchSessionIfNeeded(
            to: "latest-session",
            initialPosition: latestPosition
        )
        harness.coordinator.apply(rows: rows)
        // Mirrors the position feedback that updateNSView applies after the
        // Session switch and must not reinterpret the stale row as history.
        harness.coordinator.restoreIfNeeded(position: latestPosition)
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        await settlePositionPublication()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testImmediatePositionPublishFlushesTheLastViewportBeforeSessionUnmount() async throws {
        var savedPosition: AppKitChatTimelinePosition?
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onPositionChange: { savedPosition = $0 }
        )
        let rows = (0..<30).map { row(id: "flush-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()
        let targetY: CGFloat = 260
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: targetY))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)

        harness.coordinator.publishPositionImmediately()

        let position = try XCTUnwrap(savedPosition)
        XCTAssertEqual(position.absoluteScrollY, Double(targetY), accuracy: 2)
        XCTAssertFalse(position.followsLatest)
    }

    func testTailRevisionFollowsLatestButHistoryReadingDoesNot() async {
        let followHarness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "row-\($0)", revision: 0, text: "Row \($0)") }
        followHarness.coordinator.apply(rows: rows)
        await settleMainQueue()
        let updated = Array(rows.dropLast()) + [row(id: "row-29", revision: 1, text: "Updated tail")]
        followHarness.coordinator.apply(rows: updated)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(followHarness))

        let historyHarness = makeHarness(followsLatest: false, height: 180)
        historyHarness.coordinator.apply(rows: rows)
        historyHarness.scrollView.contentView.scroll(to: .zero)
        historyHarness.scrollView.reflectScrolledClipView(historyHarness.scrollView.contentView)
        let yBefore = historyHarness.scrollView.contentView.bounds.minY
        historyHarness.coordinator.apply(rows: updated)
        await settleMainQueue()
        XCTAssertEqual(historyHarness.scrollView.contentView.bounds.minY, yBefore, accuracy: 1)
    }

    func testExpandedPlanGrowthPreservesReaderAnchorAndLatestIntent() async throws {
        func planRow(revision: Int, stepCount: Int) throws -> AppKitChatTimelineRow {
            let source: [String: Any] = [
                "id": "plan:one", "turnId": "turn:plan", "turnStatus": "inProgress",
                "type": "executionPlan", "title": "Execution plan", "text": "Plan update", "status": "running",
                "executionPlan": [
                    "schemaVersion": 1, "planId": "plan:one", "revision": revision,
                    "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                    "steps": (0..<stepCount).map { index in [
                        "stepId": "step:\(index)", "ordinal": index,
                        "text": "Inspect source file \(index)", "status": index == 0 ? "completed" : "pending"
                    ] as [String: Any] }
                ]
            ]
            let item = try JSONDecoder().decode(CodexThreadItem.self,
                from: JSONSerialization.data(withJSONObject: source))
            return AppKitChatTimelineRow(
                id: "process:turn:plan", contentRevision: revision,
                nativeText: "", copyText: "", nativeStyle: .process,
                title: "", metadata: "", expandableTurnId: "turn:plan",
                isExpanded: true, processCount: 1, processState: .running,
                processSteps: NativeExecutionTimelineProjection.steps(for: [item]),
                showsHeader: false
            )
        }
        let ordinary = (0..<30).map { row(id: "plan-neighbor-\($0)", text: "Message \($0)") }
        let initial = Array(ordinary.prefix(10)) + [try planRow(revision: 1, stepCount: 1)]
            + Array(ordinary.dropFirst(10))
        let updated = Array(ordinary.prefix(10)) + [try planRow(revision: 2, stepCount: 120)]
            + Array(ordinary.dropFirst(10))

        let historyHarness = makeHarness(followsLatest: false, height: 180)
        historyHarness.coordinator.apply(rows: initial)
        historyHarness.tableView.layoutSubtreeIfNeeded()
        historyHarness.tableView.scrollRowToVisible(23)
        await settleMainQueue()
        let before = visibleAnchor(in: historyHarness.tableView, rows: initial)
        historyHarness.coordinator.apply(rows: updated)
        await settleMainQueue()
        let after = visibleAnchor(in: historyHarness.tableView, rows: updated)
        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)

        let followHarness = makeHarness(followsLatest: true, height: 180)
        followHarness.coordinator.apply(rows: initial)
        await settleMainQueue()
        followHarness.coordinator.apply(rows: updated)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(followHarness))
        XCTAssertTrue(followHarness.followState.value)
    }

    func testGrowingStreamingTailCannotLoseLatestFollowToLayoutBoundsFeedback() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "growing-tail-\($0)", revision: 0, text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        let longReply = (0..<120).map { "Streaming reply line \($0)" }.joined(separator: "\n")
        let updated = Array(rows.dropLast()) + [
            row(id: "growing-tail-29", revision: 1, text: longReply)
        ]
        harness.coordinator.apply(rows: updated)

        // Deterministically model the layout-driven bounds callback arriving
        // after the row became much taller but before the queued bottom
        // correction. This is not a user scroll and must not revoke follow.
        harness.coordinator.viewportDidScroll(userInitiated: false)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        let visibleRows = harness.tableView.rows(in: harness.tableView.visibleRect)
        XCTAssertTrue(visibleRows.contains(updated.count - 1))
    }

    func testInlineChartTailGrowthKeepsLatestVisibleWithoutRemeasuringChart() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let history = (0..<30).map { row(id: "chart-history-\($0)", text: "Message \($0)") }
        let chart = """
        ```corptie-chart
        {"version":1,"type":"bar","title":"Progress","data":[{"label":"Done","value":2}]}
        ```
        """
        let first = row(id: "chart-tail", revision: 1, text: chart, showsHeader: false)
        harness.coordinator.apply(rows: history + [first])
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        let measurements = LegacyTimelineLayoutReference.shared.chartMeasurementCount
        let updated = row(id: "chart-tail", revision: 2,
            text: chart + "\n" + String(repeating: "Streaming explanation follows. ", count: 60),
            showsHeader: false)
        harness.coordinator.apply(rows: history + [updated])
        harness.coordinator.viewportDidScroll(userInitiated: false)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertTrue(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: history.count)))
        XCTAssertEqual(LegacyTimelineLayoutReference.shared.chartMeasurementCount, measurements)
    }

    func testClampedWheelAtBottomKeepsFollowingForUserMessageAppend() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "send-follow-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        // At the lower boundary AppKit may clamp the entire gesture and emit
        // no bounds-change notification between willBegin/didEnd.
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertTrue(harness.followState.value)

        let appended = rows + [row(id: "send-follow-user", text: "New user message")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        let visibleRows = harness.tableView.rows(in: harness.tableView.visibleRect)
        XCTAssertTrue(visibleRows.contains(appended.count - 1))
    }

    func testPhysicalBottomWinsOverStaleFollowStateWhenFinalReplyArrives() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "stale-follow-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        // SwiftUI binding publication can lag behind AppKit geometry. The
        // viewport is already at the lower boundary, so a stale semantic flag
        // must not strand the completed reply below the visible document.
        harness.coordinator.followsLatest = false
        harness.followState.value = false
        let completed = rows + [row(
            id: "stale-follow-final",
            text: (0..<20).map { "Completed reply line \($0)" }.joined(separator: "\n")
        )]

        harness.coordinator.apply(rows: completed)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertTrue(harness.tableView.rows(in: harness.tableView.visibleRect).contains(completed.count - 1))
    }

    func testCompletedWheelAwayFromBottomPreservesReaderAnchorOnAppend() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "history-follow-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 260))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        let anchorBefore = visibleAnchor(in: harness.tableView, rows: rows)
        XCTAssertFalse(harness.followState.value)

        let appended = rows + [row(id: "history-follow-user", text: "New user message")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()

        let anchorAfter = visibleAnchor(in: harness.tableView, rows: appended)
        XCTAssertEqual(anchorAfter.id, anchorBefore.id)
        XCTAssertEqual(anchorAfter.offset, anchorBefore.offset, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testGoalTailRefreshUsesViewportGeometryInsteadOfStaleFollowInput() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "goal-row-\($0)", revision: 0, text: "Goal row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()
        XCTAssertFalse(harness.followState.value)

        // Reproduce SwiftUI feeding the coordinator the previous frame's
        // value while Goal progress keeps revising the final card.
        harness.coordinator.followsLatest = true
        let refreshed = Array(rows.dropLast()) + [
            row(id: "goal-row-29", revision: 1, text: "Goal progress streamed again")
        ]
        harness.coordinator.apply(rows: refreshed)
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(isNearBottom(harness))
    }

    func testGoalMessageAppendPreservesReaderAnchorWithStaleFollowInput() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "goal-message-\($0)", text: "Goal message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.coordinator.userScrollEventWillBegin()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 240))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()
        XCTAssertFalse(isNearBottom(harness), "The reader must actually reach history before simulating stale follow input")
        let before = visibleAnchor(in: harness.tableView, rows: rows)

        harness.coordinator.followsLatest = true
        let appended = rows + [row(id: "goal-message-30", text: "New user message")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: appended)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)
        XCTAssertFalse(isNearBottom(harness))
    }

    func testUserScrollAwayCancelsQueuedGoalFollowCommand() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "queued-goal-row-\($0)", revision: 0, text: "Goal row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        let refreshed = Array(rows.dropLast()) + [
            row(id: "queued-goal-row-29", revision: 1, text: "A taller streamed Goal update\n\nwith more content")
        ]
        harness.coordinator.apply(rows: refreshed)
        harness.coordinator.userDidBeginScrolling()
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
        XCTAssertFalse(isNearBottom(harness))
    }

    func testUserGestureCancelsQueuedProgrammaticScrollBeforeItRuns() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<30).map { row(id: "gesture-authority-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.scrollView.contentView.scroll(to: .zero)
        harness.coordinator.scrollToBottom()
        harness.coordinator.userDidBeginScrolling()
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testUserGestureRejectsLaterSwiftUIPositionFeedback() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<40).map { row(id: "feedback-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.restore(position: .init(
            rowID: "feedback-row-20",
            offset: 4,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: .zero)
        harness.coordinator.userDidBeginScrolling()
        harness.coordinator.restoreIfNeeded(position: .init(
            rowID: "feedback-row-25",
            offset: 6,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testRowReflowCannotQueueAnchorRestoreInsideWheelEvent() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        var rows = (0..<50).map { row(id: "wheel-reflow-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 420))

        // The Binding update caused by wheel ownership can synchronously
        // re-enter updateNSView before NSScrollView applies the wheel delta.
        // A row reflow in that window must not enqueue a later anchor restore.
        harness.coordinator.userScrollEventWillBegin()
        rows[0] = row(
            id: "wheel-reflow-0",
            revision: 1,
            text: String(repeating: "A much taller row above the viewport. ", count: 80)
        )
        harness.coordinator.apply(rows: rows)
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 360))
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 360, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testHistoryLoadingRequiresAnActiveUserScrollEvent() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<40).map { row(id: "history-gate-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        // A layout/restore bounds notification at y=0 is not user intent.
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        XCTAssertEqual(historyRequests, 0)

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 120))
        harness.coordinator.userScrollEventWillBegin()
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertEqual(historyRequests, 1)
    }

    func testUnderfilledViewportRequestsHistoryWithoutUserGestureWhenHistoryExists() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 520,
            hasMoreHistory: true,
            onUnderfilledHistory: { historyRequests += 1 }
        )

        harness.coordinator.apply(rows: [
            row(id: "underfilled-user", text: "Question"),
            row(id: "underfilled-process", text: "Collapsed execution")
        ])
        await settleMainQueue()

        XCTAssertEqual(historyRequests, 1)
        harness.coordinator.apply(rows: [
            row(id: "underfilled-user", text: "Question"),
            row(id: "underfilled-process", text: "Collapsed execution")
        ])
        await settleMainQueue()
        XCTAssertEqual(historyRequests, 1, "The same underfilled projection must not loop")
    }

    func testUnderfilledViewportDoesNotRequestWhenHistoryIsExhausted() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 520,
            hasMoreHistory: false,
            onUnderfilledHistory: { historyRequests += 1 }
        )
        harness.coordinator.apply(rows: [row(id: "only-row", text: "Latest")])
        await settleMainQueue()

        XCTAssertEqual(historyRequests, 0)
    }

    func testScrollableViewportDoesNotUseUnderfilledHistoryPath() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 180,
            hasMoreHistory: true,
            onUnderfilledHistory: { historyRequests += 1 }
        )
        harness.coordinator.apply(rows: (0..<40).map { row(id: "scrollable-\($0)", text: "Row \($0)") })
        await settleMainQueue()

        XCTAssertEqual(historyRequests, 0)
    }

    func testGrowingViewportDoesNotReadHistoryFromResize() async {
        var historyRequests = 0
        let harness = makeHarness(followsLatest: true, height: 180, hasMoreHistory: true,
            onUnderfilledHistory: { historyRequests += 1 })
        harness.coordinator.apply(rows: (0..<10).map { row(id: "resize-history-\($0)", text: "Row \($0)") })
        await settleMainQueue()
        XCTAssertEqual(historyRequests, 0)
        harness.window.setContentSize(NSSize(width: 420, height: 2000))
        harness.window.layoutIfNeeded()
        harness.tableView.layoutSubtreeIfNeeded()
        await settleMainQueue()
        XCTAssertEqual(historyRequests, 0, "Window geometry must not start history loading")
    }

    func testDirectScrollbarDragToTopRequestsHistory() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<40).map { row(id: "scrollbar-history-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 120))
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        XCTAssertEqual(historyRequests, 0, "Programmatic bounds changes remain suppressed")

        harness.coordinator.viewportDidScroll(userInitiated: true)
        XCTAssertEqual(historyRequests, 1, "A scrollbar drag is explicit user intent")
    }

    func testConsecutiveScrollsToTopRequestSuccessiveHistoryPagesWithoutLosingAnchor() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let initial = (0..<40).map { row(id: "history-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: initial)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 120))
        harness.coordinator.userScrollEventWillBegin()
        harness.scrollView.contentView.scroll(to: .zero)
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertEqual(historyRequests, 1)

        let prepended = (0..<8).map { row(id: "older-\($0)", text: "Earlier \($0)") } + initial
        harness.coordinator.apply(rows: prepended)
        await settleMainQueue()
        XCTAssertEqual(visibleAnchor(in: harness.tableView, rows: prepended).id, initial[0].id)

        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.viewportDidScroll(userInitiated: true)
        harness.scrollView.contentView.scroll(to: .zero)
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertEqual(historyRequests, 2, "A second upward gesture must load the next page")
    }

    func testFailedHistoryRequestCanBeRearmedWhileViewportRemainsAtTop() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<40).map { row(id: "retry-history-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: .zero)

        harness.coordinator.viewportDidScroll(userInitiated: true)
        harness.coordinator.viewportDidScroll(userInitiated: true)
        XCTAssertEqual(historyRequests, 1, "Repeated bounds notifications are coalesced")

        harness.coordinator.rearmHistoryRequest()
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertEqual(historyRequests, 2, "Retry does not require leaving the clamped top edge")
    }

    func testSmallWheelMoveNearLatestCannotJumpToOldestDuringTailAppend() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<60).map { row(id: "small-wheel-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        let bottomY = harness.scrollView.contentView.bounds.minY

        harness.coordinator.userScrollEventWillBegin()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: max(0, bottomY - 4)))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventDidEnd()

        let appended = rows + [row(id: "small-wheel-60", text: "Completed reply")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: appended)

        XCTAssertTrue(
            Set(appended.suffix(5).map(\.id)).contains(after.id),
            "A small gesture in the latest region may resume bottom following, but must not jump into history"
        )
        XCTAssertNotEqual(after.id, appended.first?.id)
        XCTAssertEqual(historyRequests, 0)
    }

    func testExplicitTurnJumpCancelsQueuedInitialRestore() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<40).map { index in
            row(
                id: "jump-cancel-row-\(index)",
                text: "Row \(index)",
                expandableTurnId: "jump-cancel-turn-\(index)"
            )
        }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.restore(position: .init(
            rowID: "jump-cancel-row-30",
            offset: 4,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        harness.coordinator.scrollToTurn("jump-cancel-turn-8")
        await settleMainQueue()

        XCTAssertTrue(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: 8)))
        XCTAssertFalse(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: 30)))
    }

    func testVirtualSixtySecondContinuousScrollHasZeroReverseDisplacement() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        var rows = (0..<160).map { row(id: "continuous-scroll-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.window.layoutIfNeeded()
        harness.scrollView.contentView.scroll(to: .zero)
        var reverseDisplacement: CGFloat = 0

        // 600 deterministic 100 ms gesture ticks model one minute of continuous
        // wheel/trackpad ownership without making the test wait for wall clock.
        for tick in 0..<600 {
            let before = harness.scrollView.contentView.bounds.minY
            let maximumY = max(0, harness.tableView.bounds.height - harness.scrollView.contentView.bounds.height)
            let intendedY = min(maximumY, before + 1)
            harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: intendedY))
            harness.coordinator.scrollToBottom()
            harness.coordinator.userDidBeginScrolling()
            if tick.isMultiple(of: 20) {
                rows[rows.count - 1] = row(
                    id: "continuous-scroll-159",
                    revision: tick + 1,
                    text: "Tail status update \(tick)\n\nwithout viewport authority"
                )
                harness.coordinator.apply(rows: rows)
            }
            await settleMainQueue()
            reverseDisplacement += max(0, intendedY - harness.scrollView.contentView.bounds.minY)
        }

        XCTAssertEqual(reverseDisplacement, 0, accuracy: 0.5)
        XCTAssertFalse(harness.followState.value)
    }

    func testGoalAndRegularTimelineFollowStateRemainCoordinatorLocal() async {
        let goalHarness = makeHarness(followsLatest: true, height: 180)
        let regularHarness = makeHarness(followsLatest: true, height: 180)
        let goalRows = (0..<24).map { row(id: "goal-mode-\($0)", text: "Goal \($0)") }
        let regularRows = (0..<24).map { row(id: "regular-mode-\($0)", text: "Regular \($0)") }
        goalHarness.coordinator.apply(rows: goalRows)
        regularHarness.coordinator.apply(rows: regularRows)
        await settleMainQueue()

        goalHarness.scrollView.contentView.scroll(to: .zero)
        goalHarness.scrollView.reflectScrolledClipView(goalHarness.scrollView.contentView)
        goalHarness.coordinator.userScrollEventWillBegin()
        goalHarness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()

        XCTAssertFalse(goalHarness.followState.value)
        XCTAssertTrue(regularHarness.followState.value)
        XCTAssertTrue(isNearBottom(regularHarness))
    }

    func testOffscreenRenderingProducesVisibleTimelineArtifact() throws {
        let harness = makeHarness(followsLatest: false, height: 460)
        let rows = [
            row(id: "heading", text: "# Native AppKit Timeline\n\nA paragraph with **bold**, *italic*, and [a link](https://example.com)."),
            row(id: "list", text: "- first item\n- second item\n\n> quoted explanation"),
            AppKitChatTimelineRow(
                id: "process",
                contentRevision: 0,
                nativeText: "",
                copyText: "swift test",
                nativeStyle: .process,
                title: "",
                metadata: "",
                expandableTurnId: "turn",
                isExpanded: false,
                processCount: 4,
                processDuration: "12s",
                processState: .completed,
                showsHeader: false
            ),
            row(id: "action", text: "Native AppKit action row", actions: [
                .init(
                    id: "action:continue",
                    label: "Continue",
                    isDestructive: false,
                    kind: .sendMessage("continue")
                )
            ])
        ]
        harness.coordinator.apply(rows: rows)
        harness.tableView.reloadData()
        harness.window.contentView?.layoutSubtreeIfNeeded()
        harness.tableView.layoutSubtreeIfNeeded()
        harness.scrollView.displayIfNeeded()

        let bounds = harness.scrollView.bounds
        let bitmap = try XCTUnwrap(harness.scrollView.bitmapImageRepForCachingDisplay(in: bounds))
        harness.scrollView.cacheDisplay(in: bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, 4_000)

        if let path = ProcessInfo.processInfo.environment["CORPTIE_TIMELINE_SNAPSHOT_PATH"] {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }

    func testNativeActionRowDispatchesApprovalWithoutHostingSwiftUI() throws {
        let option = CodexApprovalOption(
            id: "approve",
            label: "Approve",
            role: "approve",
            index: 0,
            selected: false
        )
        var receivedActionID: String?
        let harness = makeHarness(
            followsLatest: true,
            onToggle: { _ in },
            onAction: { action in receivedActionID = action.id }
        )
        harness.coordinator.apply(rows: [row(
            id: "approval",
            text: "Allow this operation?",
            actions: [
                .init(
                    id: "approval:approve",
                    label: "Approve",
                    isDestructive: false,
                    kind: .codexApproval(option)
                )
            ]
        )])
        harness.tableView.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let actionButton = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.action.approval:approve"))
        actionButton.performClick(nil)

        XCTAssertEqual(receivedActionID, "approval:approve")
    }

    func testUserMessageNavigationWaitsForItsRowWithoutSearchSelectionAndIsolatesSessions() {
        let harness = makeHarness(followsLatest: true, height: 180)
        harness.coordinator.apply(rows: [row(id: "message:other", text: "Other")])
        harness.coordinator.applyMessageNavigation(rowID: "message:target", revision: 1)
        XCTAssertTrue(harness.followState.value)
        harness.coordinator.apply(rows: [row(id: "message:other", text: "Other"), row(id: "message:target", text: "Target")])
        harness.coordinator.applyMessageNavigation(rowID: "message:target", revision: 1)
        XCTAssertFalse(harness.followState.value)
        XCTAssertEqual(harness.tableView.selectedRow, -1)
        XCTAssertEqual(harness.tableView.selectionHighlightStyle, .none)
        harness.coordinator.switchSessionIfNeeded(to: "different-session", initialPosition: nil)
        harness.coordinator.applyMessageNavigation(rowID: nil, revision: 0)
        harness.coordinator.apply(rows: [row(id: "message:target", text: "Different Session")])
        harness.coordinator.applyMessageNavigation(rowID: nil, revision: 0)
        XCTAssertEqual(harness.tableView.selectedRow, -1)
    }

    func testSearchTargetWaitsForItsMessageAndNeverSelectsAnUnrelatedRow() {
        let harness = makeHarness(followsLatest: true, height: 180)
        harness.coordinator.apply(rows: [row(id: "message:other", text: "Other")])
        harness.coordinator.applySearchTarget(rowID: "message:target", revision: 1)
        XCTAssertEqual(harness.tableView.selectedRow, -1)
        harness.coordinator.apply(rows: [row(id: "message:other", text: "Other"), row(id: "message:target", text: "Target")])
        harness.coordinator.applySearchTarget(rowID: "message:target", revision: 1)
        XCTAssertEqual(harness.tableView.selectedRow, 1)
        XCTAssertFalse(harness.followState.value)
        harness.coordinator.switchSessionIfNeeded(to: "different-session", initialPosition: nil)
        harness.coordinator.apply(rows: [row(id: "message:unrelated", text: "Unrelated")])
        harness.coordinator.applySearchTarget(rowID: nil, revision: 0)
        XCTAssertEqual(harness.tableView.selectionHighlightStyle, .none)
        XCTAssertEqual(harness.tableView.selectedRow, -1)
    }

    func testWarmSessionSwitchPreservesCachedNativeCells() throws {
        let harness = makeHarness(followsLatest: false, useSharedTextCards: true, height: 360)
        let first = (0..<40).map { row(id: "cached-first-\($0)", text: "First \($0)") }
        let second = (0..<40).map { row(id: "cached-second-\($0)", text: "Second \($0)") }
        func install(_ session: String, _ rows: [AppKitChatTimelineRow]) {
            harness.coordinator.switchSessionIfNeeded(to: session, initialPosition: .init(
                rowID: rows[24].id, offset: 4, absoluteScrollY: 0, followsLatest: false))
            harness.coordinator.apply(rows: rows)
            harness.window.layoutIfNeeded()
            harness.scrollView.layoutSubtreeIfNeeded()
        }
        install("first", first)
        let cell = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 24, makeIfNecessary: true) as? AppKitChatNativeTextCell)
        let configurations = cell.contentConfigurationCount
        install("second", second)
        install("first", first)
        let returned = try XCTUnwrap(harness.tableView.view(atColumn: 0, row: 24, makeIfNecessary: true) as? AppKitChatNativeTextCell)
        XCTAssertTrue(returned === cell)
        XCTAssertEqual(returned.contentConfigurationCount, configurations)
    }

    func testRetainedProjectionRevisionSkipsApplyButAcceptsNewRowsAndSessionIdentity() throws {
        guard CorptieAppEnvironment.isDevelopment,
              ProcessInfo.processInfo.environment["CORPTIE_SESSION_SWITCH_TRACE"] == "1" else {
            throw XCTSkip("Trace counters require CORPTIE_SESSION_SWITCH_TRACE=1; UI semantics have independent tests")
        }

        let harness = makeHarness(followsLatest: false, useSharedTextCards: false, height: 360)
        defer { harness.window.contentView = nil; harness.window.close() }
        let initial = [row(id: "retained-row", text: "Initial")]
        SessionSwitchTrace.shared.begin(sessionID: "test-session")
        defer { SessionSwitchTrace.shared.end(reason: "test-finished") }
        harness.coordinator.apply(rows: initial, contentRevision: 1)
        let before = SessionSwitchTrace.shared.snapshot?.metrics[.timelineApply]?.count ?? 0
        XCTAssertGreaterThan(before, 0)
        for _ in 0..<200 { harness.coordinator.apply(rows: initial, contentRevision: 1) }
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.timelineApply]?.count, before)
        harness.coordinator.apply(rows: [row(id: "retained-row", revision: 2, text: "Changed")], contentRevision: 2)
        let changed = try XCTUnwrap(harness.coordinator.tableView(harness.tableView, viewFor: nil, row: 0))
        XCTAssertEqual(try XCTUnwrap(textView(in: changed, identifier: "chat.timeline.body")).string, "Changed")
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.timelineApply]?.count, before + 1)
        harness.coordinator.switchSessionIfNeeded(to: "another", initialPosition: nil)
        SessionSwitchTrace.shared.begin(sessionID: "another")
        harness.coordinator.apply(rows: [row(id: "other-row", text: "Other Session")], contentRevision: 2)
        let other = try XCTUnwrap(harness.coordinator.tableView(harness.tableView, viewFor: nil, row: 0))
        XCTAssertEqual(try XCTUnwrap(textView(in: other, identifier: "chat.timeline.body")).string, "Other Session")
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.timelineApply]?.count, 1)
        harness.coordinator.updateBaseDirectory("/tmp/another-workspace")
        harness.coordinator.apply(rows: [row(id: "other-row", text: "Other Session")], contentRevision: 2)
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.timelineApply]?.count, 2)
    }

    func testWarmSessionHostSwitchStaysWithinOneFrame() async {
        let rowsBySession = (0..<3).map { sessionIndex in
            (0..<40).map { index in
                row(
                    id: "switch-\(sessionIndex)-row-\(index)",
                    text: String(repeating: "Message \(sessionIndex)-\(index) ", count: 8)
                )
            }
        }
        var coldSamples: [Double] = []
        for _ in 0..<8 {
            let start = DispatchTime.now().uptimeNanoseconds
            let harness = makeHarness(followsLatest: false, height: 360)
            harness.coordinator.prepareInitialPosition(.init(
                rowID: "switch-0-row-24",
                offset: 4,
                absoluteScrollY: 0,
                followsLatest: false
            ))
            harness.coordinator.apply(rows: rowsBySession[0])
            harness.window.layoutIfNeeded()
            harness.scrollView.layoutSubtreeIfNeeded()
            coldSamples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
            harness.window.close()
            harness.window.contentView = nil
            await settleMainQueue()
        }

        let host = makeHarness(followsLatest: false, height: 360)
        let stableScrollView = host.scrollView
        let warmupStartCreated = ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated]
        var warmupCreated: [Int64] = []
        for _ in 0..<6 {
            let before = ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated]
            for sessionIndex in rowsBySession.indices {
                host.coordinator.switchSessionIfNeeded(
                    to: "session-\(sessionIndex)",
                    initialPosition: .init(
                        rowID: "switch-\(sessionIndex)-row-24",
                        offset: 4,
                        absoluteScrollY: 0,
                        followsLatest: false
                    ),
                    deferReloadUntilRowsArrive: true
                )
                host.coordinator.apply(rows: rowsBySession[sessionIndex])
                host.window.layoutIfNeeded()
                host.scrollView.layoutSubtreeIfNeeded()
                await settleMainQueue()
            }
            let created = ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated] - before
            warmupCreated.append(created)
            if created == 0 { break }
        }
        print("[perf] warmup cells-created per complete rotation=\(warmupCreated); total=\(ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated] - warmupStartCreated)")
        XCTAssertEqual(warmupCreated.last, 0, "A warm benchmark needs a stable renderer working set")
        func processCPUMilliseconds() -> Double {
            var usage = rusage()
            getrusage(RUSAGE_SELF, &usage)
            return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1_000
                + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000
        }
        var warmSamples: [Double] = []
        var warmDiagnostics: [(wall: Double, cpu: Double, rebind: Double, apply: Double, layout: Double, created: Int64, configured: Int64)] = []
        for index in 0..<60 {
            let sessionIndex = index % rowsBySession.count
            let createdBefore = ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated]
            let configuredBefore = ChatPerformanceRecorder.shared.snapshot()[.appKitRowsConfigured]
            let cpuStart = processCPUMilliseconds()
            let start = DispatchTime.now().uptimeNanoseconds
            host.coordinator.switchSessionIfNeeded(
                to: "session-\(sessionIndex)",
                initialPosition: .init(
                    rowID: "switch-\(sessionIndex)-row-24",
                    offset: 4,
                    absoluteScrollY: 0,
                    followsLatest: false
                ),
                deferReloadUntilRowsArrive: true
            )
            let rebound = DispatchTime.now().uptimeNanoseconds
            host.coordinator.apply(rows: rowsBySession[sessionIndex])
            let applied = DispatchTime.now().uptimeNanoseconds
            host.window.layoutIfNeeded()
            host.scrollView.layoutSubtreeIfNeeded()
            let wall = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            warmSamples.append(wall)
            warmDiagnostics.append((wall, processCPUMilliseconds() - cpuStart, Double(rebound - start) / 1_000_000, Double(applied - rebound) / 1_000_000, wall - Double(applied - start) / 1_000_000,
                ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated] - createdBefore,
                ChatPerformanceRecorder.shared.snapshot()[.appKitRowsConfigured] - configuredBefore))
            // Distinct clicks are distinct main-loop events. Let SDK layout
            // notifications and retired cold hosts settle between samples.
            await settleMainQueue()
        }
        coldSamples.sort()
        warmSamples.sort()
        let coldP50 = coldSamples[coldSamples.count / 2]
        let warmP50 = warmSamples[warmSamples.count / 2]
        let warmP95 = warmSamples[Int(Double(warmSamples.count - 1) * 0.95)]
        let warmHitches = warmSamples.filter { $0 > 16.67 }.count
        let cpuHitches = warmDiagnostics.filter { $0.cpu > 16.67 }.count
        print("[perf] session switch cold-p50=\(String(format: "%.2f", coldP50))ms warm-p50=\(String(format: "%.2f", warmP50))ms warm-p95=\(String(format: "%.2f", warmP95))ms warm-wall-hitches=\(warmHitches)/\(warmSamples.count) cpu-over-budget=\(cpuHitches)/\(warmSamples.count)")

        for sample in warmDiagnostics.sorted(by: { $0.wall > $1.wall }).prefix(3) {
            print("[perf] slow switch wall=\(String(format: "%.2f", sample.wall))ms process-cpu=\(String(format: "%.2f", sample.cpu))ms rebind=\(String(format: "%.2f", sample.rebind))ms apply=\(String(format: "%.2f", sample.apply))ms layout=\(String(format: "%.2f", sample.layout))ms cells-created=\(sample.created) configured=\(sample.configured)")
        }

        XCTAssertLessThan(warmP95, 16)
        // Keep the wall P95 budget above. A single OS scheduling pause is
        // reported as a wall hitch, rather than attributed to synchronous UI
        // code whose process CPU remained inside the frame budget. Neither
        // metric substitutes for the later real-window presentation acceptance.
        XCTAssertEqual(cpuHitches, 0)
        XCTAssertLessThan(warmP50, coldP50)
        XCTAssertTrue(host.scrollView === stableScrollView)
    }

    func testSessionRebindPublishesOldViewportBeforeInstallingNewCallback() async throws {
        var oldPosition: AppKitChatTimelinePosition?
        var newPosition: AppKitChatTimelinePosition?
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onPositionChange: { oldPosition = $0 }
        )
        let oldRows = (0..<30).map { row(id: "old-\($0)", text: "Old \($0)") }
        let newRows = (0..<30).map { row(id: "new-\($0)", text: "New \($0)") }
        harness.coordinator.apply(rows: oldRows)
        harness.tableView.scrollRowToVisible(12)
        await settleMainQueue()

        harness.coordinator.switchSessionIfNeeded(
            to: "new-session",
            initialPosition: .init(
                rowID: "new-8",
                offset: 5,
                absoluteScrollY: 0,
                followsLatest: false
            )
        )
        harness.coordinator.onPositionChange = { newPosition = $0 }
        harness.coordinator.apply(rows: newRows)
        await settleMainQueue()

        XCTAssertTrue(try XCTUnwrap(oldPosition).rowID.hasPrefix("old-"))
        XCTAssertTrue(newPosition.map { $0.rowID.hasPrefix("new-") } ?? true)
        let anchor = visibleAnchor(in: harness.tableView, rows: newRows)
        XCTAssertEqual(anchor.id, "new-8")
        XCTAssertEqual(anchor.offset, 5, accuracy: 4)
    }

    func testFirstWheelAfterReturningToLatestCannotCancelPendingBottomRestore() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let firstRows = (0..<40).map { row(id: "first-\($0)", text: "First \($0)") }
        let secondRows = (0..<40).map { row(id: "second-\($0)", text: "Second \($0)") }
        harness.coordinator.apply(rows: firstRows)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        harness.coordinator.switchSessionIfNeeded(to: "second", initialPosition: nil)
        harness.coordinator.apply(rows: secondRows)
        await settleMainQueue()

        // Returning while the host has no usable height models the frame
        // between Session rebinding and its first SwiftUI layout pass.
        harness.scrollView.frame.size.height = 0
        harness.coordinator.switchSessionIfNeeded(
            to: "first",
            initialPosition: .init(
                rowID: "first-39",
                offset: 0,
                absoluteScrollY: 0,
                followsLatest: true
            )
        )
        harness.coordinator.apply(rows: firstRows)
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()

        harness.scrollView.frame.size.height = 180
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testSemanticPositionRestorationSucceedsAcrossOneHundredSwitches() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<160).map { row(id: "accuracy-row-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()
        var successes = 0

        for iteration in 0..<100 {
            let targetIndex = 10 + (iteration * 37) % 130
            let targetID = "accuracy-row-\(targetIndex)"
            harness.coordinator.restore(position: .init(
                rowID: targetID,
                offset: 5,
                absoluteScrollY: 0,
                followsLatest: false
            ))
            await settleMainQueue()
            let anchor = visibleAnchor(in: harness.tableView, rows: rows)
            if anchor.id == targetID, abs(anchor.offset - 5) <= 4 {
                successes += 1
            }
        }
        print("[perf] semantic position restoration success=\(successes)/100")
        XCTAssertEqual(successes, 100)
    }

    func testSuspendedTimelineDefersWidthReflowUntilResumed() async throws {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.apply(rows: (0..<30).map {
            row(id: "suspended-\($0)", text: String(repeating: "Long reply ", count: 60))
        })
        await settleMainQueue()
        let oldWidth = try XCTUnwrap(harness.tableView.tableColumns.first).width
        harness.coordinator.setPresentationActive(false)
        harness.scrollView.setFrameSize(NSSize(width: 700, height: 400))
        NotificationCenter.default.post(name: NSView.frameDidChangeNotification, object: harness.scrollView.contentView)
        await settleMainQueue()
        // Native geometry can follow the window while hidden; custom content work stays paused.
        harness.coordinator.setPresentationActive(true)
        await settleMainQueue()
        XCTAssertGreaterThan(try XCTUnwrap(harness.tableView.tableColumns.first?.width), oldWidth)
        XCTAssertTrue(harness.coordinator.followsLatest)
    }

    private func makeHarness(
        followsLatest: Bool,
        useSharedTextCards: Bool = ProcessInfo.processInfo.environment["CORPTIE_TEST_LEGACY_CARDS"] != "1",
        height: CGFloat = 320,
        useSharedProcessCards: Bool = false,
        onToggle: @escaping (String) -> Void = { _ in },
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in },
        onNearTop: @escaping () -> Void = {},
        hasMoreHistory: Bool = false,
        onUnderfilledHistory: @escaping () -> Void = {},
        onPositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in }
    ) -> (
        window: NSWindow,
        scrollView: NSScrollView,
        tableView: NSTableView,
        coordinator: AppKitChatTimelineView.Coordinator,
        followState: FollowState
    ) {
        let state = FollowState(followsLatest)
        let binding = Binding(get: { state.value }, set: { state.value = $0 })
        let tableView = AppKitChatTimelineView.makeTableView()
        let scrollView = AppKitChatTimelineView.makeScrollView(tableView: tableView)
        let coordinator = AppKitChatTimelineView.Coordinator(
            followsLatest: binding,
            useSharedTextCards: useSharedTextCards,
            // Keep the native-control baseline assertions. Shared process rows
            // are exercised through the real coordinator in ProcessCardMigrationTests.
            useSharedProcessCards: useSharedProcessCards,
            onToggleExpansion: onToggle,
            onAction: onAction,
            onNearTop: onNearTop,
            hasMoreHistory: hasMoreHistory,
            onUnderfilledHistory: onUnderfilledHistory,
            onPositionChange: onPositionChange
        )
        coordinator.followsLatest = followsLatest
        coordinator.attach(tableView: tableView, scrollView: scrollView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        addTeardownBlock { @MainActor in
            window.close()
            window.contentView = nil
        }
        window.contentView = scrollView
        window.layoutIfNeeded()
        if useSharedProcessCards && ProcessInfo.processInfo.environment["CORPTIE_TEST_VISIBLE_SDK_ROWS"] == "1" {
            window.orderFrontRegardless()
        }
        return (window, scrollView, tableView, coordinator, state)
    }

    private func row(
        id: String,
        revision: Int = 0,
        text: String = "",
        copyText: String? = nil,
        nativeStyle: AppKitChatTimelineRow.NativeStyle = .agent,
        expandableTurnId: String? = nil,
        isExpanded: Bool = false,
        showsHeader: Bool = true,
        contextTimestamp: String = "",
        messageDate: Date? = nil,
        actions: [AppKitChatTimelineRow.Action] = []
    ) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(
            id: id,
            contentRevision: revision,
            nativeText: text,
            copyText: copyText ?? text,
            nativeStyle: nativeStyle,
            title: "Agent",
            metadata: "10:20",
            expandableTurnId: expandableTurnId,
            isExpanded: isExpanded,
            showsHeader: showsHeader,
            contextTimestamp: contextTimestamp,
            messageDate: messageDate,
            actions: actions
        )
    }

    private func menuItem(in menu: NSMenu?, identifier: String) -> NSMenuItem? {
        menu?.items.first { $0.identifier?.rawValue == identifier }
    }

    private func button(in view: NSView, identifier: String) -> NSButton? {
        if let button = view as? NSButton, button.identifier?.rawValue == identifier { return button }
        return view.subviews.lazy.compactMap { self.button(in: $0, identifier: identifier) }.first
    }

    private func textField(in view: NSView, identifier: String) -> NSTextField? {
        if let textField = view as? NSTextField, textField.identifier?.rawValue == identifier { return textField }
        return view.subviews.lazy.compactMap { self.textField(in: $0, identifier: identifier) }.first
    }

    private func textView(in view: NSView, identifier: String) -> NativeTimelineTextView? {
        if let textView = view as? NativeTimelineTextView,
           textView.identifier?.rawValue == identifier { return textView }
        return view.subviews.lazy.compactMap { self.textView(in: $0, identifier: identifier) }.first
    }

    private func view(in view: NSView, identifier: String) -> NSView? {
        if view.identifier?.rawValue == identifier { return view }
        return view.subviews.lazy.compactMap { self.view(in: $0, identifier: identifier) }.first
    }

    private func assertDescendantsStayInsideVerticalBounds(
        of root: NSView,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for descendant in root.subviews {
            let rect = descendant.convert(descendant.bounds, to: root)
            XCTAssertGreaterThanOrEqual(rect.minY, -1, file: file, line: line)
            XCTAssertLessThanOrEqual(rect.maxY, root.bounds.maxY + 1, file: file, line: line)
            assertDescendantsStayInsideVerticalBounds(of: descendant, file: file, line: line)
        }
    }

    private func hasVisiblePixels(in view: NSView) -> Bool {
        guard !view.bounds.isEmpty,
              let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.05 {
                return true
            }
        }
        return false
    }

    private func visibleAnchor(
        in tableView: NSTableView,
        rows: [AppKitChatTimelineRow]
    ) -> (id: String, offset: CGFloat) {
        let range = tableView.rows(in: tableView.visibleRect)
        let index = range.location
        return (rows[index].id, tableView.visibleRect.minY - tableView.rect(ofRow: index).minY)
    }

    private func isNearBottom(
        _ harness: (
            window: NSWindow,
            scrollView: NSScrollView,
            tableView: NSTableView,
            coordinator: AppKitChatTimelineView.Coordinator,
            followState: FollowState
        )
    ) -> Bool {
        harness.tableView.bounds.maxY - harness.scrollView.contentView.bounds.maxY <= 8
    }

    private func settlePositionPublication() async {
        await settleMainQueue()
        // Position/Binding publication is coalesced for 120ms by the coordinator.
        try? await Task.sleep(for: .milliseconds(150))
        await settleMainQueue()
    }

    private func settleMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                DispatchQueue.main.async {
                    continuation.resume()
                }
            }
        }
    }
}

private struct MeasuredComposerClearanceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct MeasuredComposerTimelineFixture: View {
    let rows: [AppKitChatTimelineRow]
    @State private var composerHeight: CGFloat = 0

    var body: some View {
        AppKitChatTimelineView(
            sessionID: "measured-composer-test",
            rows: rows,
            scrollToBottomRevision: 0,
            followsLatest: .constant(true),
            onToggleExpansion: { _ in },
            bottomClearance: composerHeight
        )
        .overlay(alignment: .bottom) {
            Color.clear.frame(height: 96)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(
                            key: MeasuredComposerClearanceKey.self,
                            value: geometry.size.height
                        )
                    }
                }
        }
        .onPreferenceChange(MeasuredComposerClearanceKey.self) { composerHeight = $0 }
    }
}

private struct ChromeMarker: NSViewRepresentable {
    let identifier: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = NSUserInterfaceItemIdentifier(identifier)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private struct NormalFlowComposerFixture: View {
    let rows: [AppKitChatTimelineRow]
    let editorHeight: CGFloat
    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 48)
            AppKitChatTimelineView(sessionID: "normal-flow", rows: rows, scrollToBottomRevision: 0,
                followsLatest: .constant(true), onToggleExpansion: { _ in }, bottomClearance: 40)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                .overlay(alignment: .bottom) {
                    ChromeMarker(identifier: "test.flow.actions").frame(height: 30).padding(.bottom, 4)
                }
            ChromeMarker(identifier: "test.flow.editor").frame(height: editorHeight)
        }
    }
}
