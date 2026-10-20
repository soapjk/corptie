import SwiftUI

public struct ConversationDetailResourceMenu: View {
    public enum Kind: String, Sendable {
        case addReference, manageMemory, resources
        var title: String {
            switch self { case .addReference: "添加引用"; case .manageMemory: "记忆管理"; case .resources: "资源与审计" }
        }
        var symbol: String {
            switch self { case .addReference: "link.badge.plus"; case .manageMemory: "brain"; case .resources: "doc.text.magnifyingglass" }
        }
    }
    public struct Item: Identifiable {
        public var id: String { kind.rawValue }
        let kind: Kind
        let available: Bool
        let perform: @MainActor () -> Void
        public init(_ kind: Kind, available: Bool = true, perform: @escaping @MainActor () -> Void) {
            self.kind = kind; self.available = available; self.perform = perform
        }
    }
    let items: [Item]
    public init(items: [Item]) { self.items = items }
    public var body: some View {
        Menu {
            ForEach(items) { item in
                Button(item.kind.title, systemImage: item.kind.symbol, action: item.perform).disabled(!item.available)
            }
        } label: { ConversationDetailHeaderIcon(systemName: "slider.horizontal.3") }
        .menuStyle(.borderlessButton).help("资源管理").accessibilityLabel("资源管理")
    }
}
