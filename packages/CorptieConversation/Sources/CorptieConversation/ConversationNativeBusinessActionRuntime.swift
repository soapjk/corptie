import SwiftUI
import CorptieClientCore

@MainActor @Observable final class ConversationNativeBusinessActionRuntime {
    var error: String?
    var needsRecovery = false
    var confirmation: ClientDetailAction?
    private var busy: Set<String> = []
    @ObservationIgnored private var coordinator: ClientDetailActionCoordinator?
    @ObservationIgnored private var reply: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var token = UUID()
    func install(_ value: ClientDetailActionCoordinator) { coordinator = value; error = nil }
    func retire() {
        token = UUID(); confirm(false); busy = []; needsRecovery = false; error = nil
        let old = coordinator; coordinator = nil
        if let old { Task { try? await old.invalidate(clearRecoveryIdentity: false) } }
    }
    func canPerform(cardID: String, action: ClientDetailAction) -> Bool {
        coordinator != nil && action.available && action.kind == "command" && ClientDetailActionCoordinator.supports(action)
            && !busy.contains(cardID + ":" + action.id)
    }
    func confirm(_ accepted: Bool) { let current = reply; reply = nil; confirmation = nil; current?.resume(returning: accepted) }
    private func ask(_ action: ClientDetailAction) async -> Bool {
        guard reply == nil else { return false }
        return await withCheckedContinuation { reply = $0; confirmation = action }
    }
    func recover(store: ClientDetailBusinessStore, selected: ClientDetailAPI?, api: @escaping @Sendable () async throws -> ClientDetailAPI) async {
        guard let coordinator, let selected else { return }
        let current = token
        do {
            let receipts = try await coordinator.recover()
            guard token == current else { return }
            needsRecovery = receipts.contains { ["unknown", "pending", "dispatching"].contains($0.status) }
            error = needsRecovery ? "结果尚未确认，只能核对回执，不会自动重发" : nil
            if !receipts.isEmpty && !needsRecovery { try await refresh(store, selected: selected, api: api, token: current) }
        } catch { if token == current { needsRecovery = true; self.error = "暂时无法核对回执，未重发" } }
    }
    private func refresh(_ store: ClientDetailBusinessStore, selected: ClientDetailAPI,
                         api: @escaping @Sendable () async throws -> ClientDetailAPI, token current: UUID) async throws {
        guard let sessionID = store.sessionID else { return }
        let document = try await api().businessSnapshot(sessionID: sessionID)
        guard token == current, !Task.isCancelled else { return }
        try store.receive(document, resetPages: true)
        _ = selected
    }
    func perform(cardID: String, action: ClientDetailAction, fields: [String: ClientInspectorValue],
                 store: ClientDetailBusinessStore, selected: ClientDetailAPI, api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        guard store.isCurrent, let coordinator, let documentID = store.documentID, canPerform(cardID: cardID, action: action), busy.count < 16,
              store.orderedCards.first(where: { $0.id == cardID })?.card.actions.contains(action) == true else { return }
        let key = cardID + ":" + action.id, current = token
        busy.insert(key)
        Task {
            defer { if token == current { busy.remove(key) } }
            do {
                let outcome = try await coordinator.perform(documentID: documentID, cardID: cardID, action: action, fields: fields,
                    confirm: { action in await self.ask(action) })
                guard token == current, !Task.isCancelled else { return }
                switch outcome {
                case .receipt(let receipt):
                    needsRecovery = ["unknown", "pending", "dispatching"].contains(receipt.status)
                    if receipt.status == "completed" { error = nil; try await refresh(store, selected: selected, api: api, token: current) }
                    else { error = needsRecovery ? "结果未知，请核对回执，不会自动重发" : "操作被拒绝" }
                case .cancelled: break
                case .read, .navigation: break
                }
            } catch {
                guard token == current else { return }
                needsRecovery = error is ClientDetailActionUncertain
                self.error = needsRecovery ? "结果未知，请核对回执" : "操作未完成；如内容已变化，请刷新后重新确认"
            }
        }
    }
}
