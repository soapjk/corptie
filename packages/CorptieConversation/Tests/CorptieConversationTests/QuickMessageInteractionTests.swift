import Foundation
import Testing
@testable import CorptieConversation

struct QuickMessageInteractionTests {
    @Test func singleTapOnlyHintsAndDoubleTapSends() {
        #expect(ConversationQuickMessageDrag.tapAction(count: 1, enabled: true) == .hint)
        #expect(ConversationQuickMessageDrag.tapAction(count: 2, enabled: true) == .send)
        for count in 0...4 {
            #expect(ConversationQuickMessageDrag.tapAction(count: count, enabled: false) == .none)
        }
        #expect(ConversationQuickMessageDrag.tapAction(count: 3, enabled: true) == .none)
    }

    @Test func dropOnlyAcceptsCurrentScopeAndVisibleMessageArea() throws {
        let payload = ConversationQuickMessageDrag(scope: "host|device|session", text: "继续")
        let decoded = try JSONDecoder().decode(ConversationQuickMessageDrag.self, from: JSONEncoder().encode(payload))
        #expect(decoded == payload)
        func accepted(_ point: CGPoint, scope: String = payload.scope, enabled: Bool = true,
                      bottom: CGFloat = 170) -> String? {
            decoded.acceptedText(scope: scope, enabled: enabled, location: point,
                viewport: CGSize(width: 393, height: 852), topInset: 90, bottomInset: bottom)
        }
        #expect(accepted(CGPoint(x: 100, y: 300)) == "继续")
        #expect(accepted(CGPoint(x: 0, y: 90)) == "继续")
        for point in [CGPoint(x: 100, y: 89), CGPoint(x: 100, y: 682),
                      CGPoint(x: 100, y: 850), CGPoint(x: -1, y: 300), CGPoint(x: 393, y: 300)] {
            #expect(accepted(point) == nil)
        }
        #expect(accepted(CGPoint(x: 100, y: 300), scope: "other-host|device|session") == nil)
        #expect(accepted(CGPoint(x: 100, y: 300), scope: "host|other-device|session") == nil)
        #expect(accepted(CGPoint(x: 100, y: 300), scope: "host|device|other-session") == nil)
        #expect(accepted(CGPoint(x: 100, y: 300), enabled: false) == nil)
        #expect(accepted(CGPoint(x: 100, y: 300), bottom: 0) == nil)
        // Native reading insets include the open keyboard plus the composer.
        #expect(accepted(CGPoint(x: 100, y: 381), bottom: 470) == "继续")
        #expect(accepted(CGPoint(x: 100, y: 382), bottom: 470) == nil)
        #expect(accepted(CGPoint(x: 100, y: 500), bottom: 470) == nil)
    }

    @Test func invalidOrUnmeasuredDropsCannotSend() {
        for text in ["  \n", String(repeating: "x", count: 16001)] {
            let payload = ConversationQuickMessageDrag(scope: "scope", text: text)
            #expect(payload.acceptedText(scope: "scope", enabled: true, location: CGPoint(x: 20, y: 100),
                viewport: CGSize(width: 300, height: 800), topInset: 40, bottomInset: 100) == nil)
        }
        let payload = ConversationQuickMessageDrag(scope: "scope", text: "hello")
        #expect(payload.acceptedText(scope: "scope", enabled: true, location: .zero,
            viewport: .zero, topInset: 0, bottomInset: 100) == nil)
        #expect(payload.acceptedText(scope: "scope", enabled: true, location: CGPoint(x: 20, y: 100),
            viewport: CGSize(width: 300, height: 120), topInset: 40, bottomInset: 100) == nil)
    }
}
