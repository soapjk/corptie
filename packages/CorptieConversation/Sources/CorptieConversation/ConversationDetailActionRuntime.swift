import SwiftUI
import CorptieClientCore

/// View-local coordination only. Credential/journal ownership remains in the
/// host, and authoritative mutation outcomes remain server command receipts.
@MainActor @Observable final class ConversationDetailActionRuntime {
    var error: String?
    var confirmation: ClientDetailAction?
    var ready = false
    var needsRecovery = false
    private struct Flight: Hashable { let card: String; let action: String }
    private var busy: Set<Flight> = []
    @ObservationIgnored private var reply: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var coordinator: ClientDetailActionCoordinator?
    @ObservationIgnored private var generation = UUID()
    func install(_ coordinator: ClientDetailActionCoordinator) { self.coordinator = coordinator; ready = true; error = nil }
    func retire() {
        generation = UUID(); confirm(false)
        let old = coordinator; coordinator = nil; ready = false; error = nil; needsRecovery = false; busy = []
        if let old { Task { try? await old.invalidate(clearRecoveryIdentity: false) } }
    }
    func canPerform(_ action: ClientDetailAction, writes: Bool) -> Bool {
        ready && action.available && ClientDetailActionCoordinator.supports(action) && (action.kind == "command" && writes
          || action.kind == "read" && action.operation == "detail.collection.page")
    }
    func isIdle(cardID: String, actionID: String) -> Bool { !busy.contains(Flight(card: cardID, action: actionID)) }
    func recover(store: ClientDetailStore, selected: ClientDetailAPI,
                 api: @escaping @Sendable () async throws -> ClientDetailAPI) async {
        guard let coordinator else { return }
        let token = generation
        do {
            let receipts = try await coordinator.recover()
            guard token == generation, !Task.isCancelled else { return }
            needsRecovery = receipts.contains { $0.status == "unknown" || $0.status == "pending" }
            if needsRecovery { error = "结果仍未知，未自动重发" }
            else if !receipts.isEmpty {
                error = nil
                if let session = store.canonicalSessionID { await store.refresh(sessionID: session, api: { try await api().usingPresentationPolicy(selected) }) }
            }
        } catch {
            guard token == generation, !Task.isCancelled else { return }
            needsRecovery = true; self.error = "暂时无法核对回执，未重发"
        }
    }
    func confirm(_ accepted: Bool) {
        let pending = reply; reply = nil; confirmation = nil; pending?.resume(returning: accepted)
    }
    private func ask(_ action: ClientDetailAction) async -> Bool {
        guard reply == nil else { return false }
        return await withCheckedContinuation { reply = $0; confirmation = action }
    }
    func perform(cardID: String, action: ClientDetailAction, fields: [String: ClientInspectorValue],
                 store: ClientDetailStore, selected: ClientDetailAPI,
                 api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        guard let coordinator, let documentID = store.documentID,
              canPerform(action, writes: selected.writesAvailable), isIdle(cardID: cardID, actionID: action.id), busy.count < 32 else { return }
        let flight = Flight(card: cardID, action: action.id); busy.insert(flight)
        let token = generation
        let expectedSession = store.canonicalSessionID
        Task<Void, Never> {
            defer { if token == generation { busy.remove(flight) } }
            do {
                let outcome = try await coordinator.perform(documentID: documentID, cardID: cardID, action: action,
                    fields: fields, confirm: { [weak self] action in await self?.ask(action) ?? false })
                guard token == generation, !Task.isCancelled, store.documentID == documentID else { return }
                switch outcome {
                case .read(let value):
                    try store.applyActionRead(value, negotiation: selected.negotiation, expectedSessionID: expectedSession)
                    self.error = nil
                case .receipt(let receipt):
                    if receipt.status == "completed" {
                        self.error = nil
                        if let expectedSession { await store.refresh(sessionID: expectedSession, api: { try await api().usingPresentationPolicy(selected) }) }
                    } else {
                        needsRecovery = receipt.status == "unknown" || receipt.status == "pending"
                        self.error = needsRecovery ? "结果未知，只能核对回执，不会自动重发" : "操作被拒绝，未自动重试"
                    }
                case .cancelled: break
                case .navigation: break // Native destination callbacks own navigation.
                }
            } catch {
                guard token == generation, !Task.isCancelled else { return }
                if let failure = error as? ClientServiceFailure, ["DETAIL_REVISION_CONFLICT", "DETAIL_CURSOR_INVALID"].contains(failure.code), let expectedSession {
                    self.error = "资源已变化，已重新同步；请重新加载后操作"
                    await store.refresh(sessionID: expectedSession, api: { try await api().usingPresentationPolicy(selected) })
                } else {
                    needsRecovery = error is ClientDetailActionUncertain
                    self.error = needsRecovery ? "Detail 结果未知，请核对回执；不会自动重发" : "Detail 操作未完成，未自动重试"
                }
            }
        }
    }
}
