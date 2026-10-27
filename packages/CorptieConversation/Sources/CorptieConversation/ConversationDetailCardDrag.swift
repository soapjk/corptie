import SwiftUI
import CoreTransferable
import UniformTypeIdentifiers
import CorptieClientCore

/// Only immutable identity crosses the drag boundary. Business stores remain
/// owned by the current presentation, including while a drag is in flight.
struct ConversationDetailCardDrag: Codable, Transferable, Sendable, Equatable {
    let scope: [String]
    let cardID: String
    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: UTType(exportedAs: "com.corptie.detail-card"))
    }
}

extension ConversationDetailCardArrangement {
    @discardableResult
    func move(_ payload: ConversationDetailCardDrag, in scope: [String], relativeTo targetID: String,
              after: Bool, cards: [ClientDetailBusinessCardState]) -> Bool {
        guard payload.scope == scope, payload.cardID != targetID,
              cards.contains(where: { $0.id == payload.cardID }) else { return false }
        let ordered = ordered(cards)
        guard let target = ordered.firstIndex(where: { $0.id == targetID }) else { return false }
        let destination = after ? ordered.dropFirst(target + 1).first?.id : targetID
        move([payload.cardID], before: destination, cards: ordered)
        return true
    }
}

private struct DetailCardDragKey: EnvironmentKey {
    static let defaultValue: ConversationDetailCardDrag? = nil
}

extension EnvironmentValues {
    var detailCardDrag: ConversationDetailCardDrag? {
        get { self[DetailCardDragKey.self] }
        set { self[DetailCardDragKey.self] = newValue }
    }
}

struct ConversationDetailCardDropTarget: ViewModifier {
    let enabled: Bool
    let move: (ConversationDetailCardDrag, Bool) -> Bool
    func body(content: Content) -> some View {
        #if os(macOS)
        content
        #else
        if enabled {
            GeometryReader { geometry in
                content.dropDestination(for: ConversationDetailCardDrag.self) { items, location in
                    guard items.count == 1, let item = items.first else { return false }
                    return move(item, location.y >= geometry.size.height / 2)
                }
            }
        } else { content }
        #endif
    }
}
