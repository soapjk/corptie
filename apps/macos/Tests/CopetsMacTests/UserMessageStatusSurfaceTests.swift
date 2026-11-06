import AppKit
import CorptieClientCore
import CorptieConversation
import XCTest
@testable import CorptieMac

@MainActor
final class UserMessageStatusSurfaceTests: XCTestCase {
    func testNativeUserStatusRetainsDetailsWithoutBackgroundDecoration() throws {
        _ = NSApplication.shared
        let cell = AppKitChatNativeTextCell(identifier: .init("user-status-native"))
        for skin in ConversationSkin.allCases {
            cell.updateAppearance(skin: skin)
            for value in ["queued", "processing", "confirmed", "failed"] {
                let status = try XCTUnwrap(UserMessageStatusPresentation(authoritativeStatus: value, legacyStatus: nil))
                let message = row(status)
                cell.frame = NSRect(x: 0, y: 0, width: 1000, height: 100)
                cell.setContent(message, availableWidth: 1000, onToggleExpansion: { _ in })
                cell.layoutSubtreeIfNeeded()
                let card = try XCTUnwrap(descendants(cell).first { $0.identifier?.rawValue == "chat.timeline.card" })
                XCTAssertEqual(card.toolTip, status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                XCTAssertFalse(descendants(cell).contains { $0.identifier?.rawValue == "chat.timeline.message-glow" })
            }
        }
    }

    func testSharedImageUserStatusNeverAddsBackgroundOrLayoutAnchor() throws {
        _ = NSApplication.shared
        let cell = AppKitSharedMessageTextCell(identifier: .init("user-status-shared"))
        for skin in ConversationSkin.allCases {
            cell.updateAppearance(skin: skin)
            for value in ["queued", "processing", "confirmed", "failed"] {
                let status = try XCTUnwrap(UserMessageStatusPresentation(authoritativeStatus: value, legacyStatus: nil))
                var message = row(status)
                message.images = [.init(managedPath: "status-image", displayURL: nil, originalPath: nil,
                    geometry: .init(pixelWidth: 1400, pixelHeight: 420))]
                for width: CGFloat in [1000, 1400, 900] {
                    cell.frame = NSRect(x: 0, y: 0, width: width, height: 340)
                    cell.setContent(message, availableWidth: width, onToggleExpansion: { _ in })
                    cell.layoutSubtreeIfNeeded()
                    XCTAssertEqual(cell.subviews.count, 1, "Only the content host remains; no status decoration sibling")
                    XCTAssertFalse(descendants(cell).contains {
                        $0.identifier?.rawValue == "chat.timeline.message-glow"
                            || String(describing: type(of: $0)) == "MessageGlowAnchor"
                    })
                }
            }
        }
    }

    private func row(_ status: UserMessageStatusPresentation) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(id: "user-status", contentRevision: 1,
            nativeText: "用户消息", copyText: "用户消息", nativeStyle: .user,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false, messageStatus: status)
    }

    private func descendants(_ view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants($0) }
    }
}
