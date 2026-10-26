import Testing
import SwiftUI
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit

@MainActor struct ConversationDetailActivityTests {
    @Test func activityGenerationAndIdempotenceRejectOldResults() {
        let activity = ConversationDetailPresentationActivity()
        #expect(!activity.allows(generation: 0))
        activity.deactivate(); #expect(activity.generation == 0)
        activity.activate(); let active = activity.generation
        activity.activate(); #expect(activity.generation == active)
        #expect(activity.allows(generation: active))
        activity.deactivate(); #expect(!activity.allows(generation: active))
        activity.activate(); #expect(!activity.allows(generation: active))
        #expect(activity.allows(generation: activity.generation))
    }
    private func consumerCount(_ handle: ClientDetailBusinessHandle) -> Int {
        // Inspect the real repository lease collection without adding a product diagnostics API.
        let collection = Mirror(reflecting: handle).children.first { $0.label == "consumers" }!.value
        return Mirror(reflecting: collection).children.count
    }
    private func detail(repository: ClientDetailBusinessRepository, scope: ClientDetailBusinessScope,
                        activity: ConversationDetailPresentationActivity?,
                        api: @escaping @Sendable () async throws -> ClientDetailAPI = { throw CancellationError() },
                        coordinator: (@MainActor @Sendable (ClientDetailAPI, String) async throws -> ClientDetailActionCoordinator)? = nil) -> ConversationServerDetail {
        let selection = ClientDetailConfiguration.Selection(id: "fixture", title: "Fixture", choices: [], canSelect: false)
        let adapters = ConversationDetailAdapters(configuration: .init(provider: selection, model: selection, reasoning: selection),
            selectConfiguration: { _, _ in }, reloadConfiguration: {},
            readTurnSummary: { _ in throw CancellationError() }, readTurnTrace: { _, _ in throw CancellationError() },
            worktreeAPI: { _ in throw CancellationError() }, onWorktreeJob: { _ in }, resident: .init())
        return ConversationServerDetail(scope: "fixture", sessionID: scope.sessionID, context: .init(sessionKind: "task", taskID: nil, workID: nil), coordinator: coordinator,
            repository: repository, displayScope: scope, presentationRepository: ConversationDetailPresentationRepository(),
            adapters: adapters, activity: activity, api: api)
    }
    @Test func inactiveTaskDoesNotAcquireAndReactivationUsesOneLease() async {
        let repository = ClientDetailBusinessRepository()
        let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "window", principalID: "user", sessionID: "a", taskID: nil, workID: nil)
        let activity = ConversationDetailPresentationActivity()
        let handle = repository.entry(for: scope)
        let host = NSHostingView(rootView: detail(repository: repository, scope: scope, activity: activity))
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 280, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
        defer { activity.deactivate(); window.contentView = nil; window.close(); repository.invalidateAll() }
        await settle(); #expect(consumerCount(handle) == 0)
        for _ in 0..<3 {
            activity.activate(); await waitForConsumerCount(1, handle); #expect(consumerCount(handle) == 1)
            activity.deactivate(); await waitForConsumerCount(0, handle); #expect(consumerCount(handle) == 0)
        }
        repository.invalidateAll(); activity.activate(); await settle()
        #expect(handle.retired); #expect(consumerCount(handle) == 0)
    }
    @Test func defaultActivityPreservesExistingLeaseLifecycle() async {
        let repository = ClientDetailBusinessRepository()
        let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "window", principalID: "user", sessionID: "default", taskID: nil, workID: nil)
        let handle = repository.entry(for: scope)
        let host = NSHostingView(rootView: detail(repository: repository, scope: scope, activity: nil))
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 280, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
        defer { window.contentView = nil; window.close(); repository.invalidateAll() }
        host.layoutSubtreeIfNeeded(); await waitForConsumerCount(1, handle); #expect(consumerCount(handle) == 1)
        window.contentView = nil; await waitForConsumerCount(0, handle); #expect(consumerCount(handle) == 0)
    }
    @Test func latePolicyAfterDeactivationReleasesLeaseWithoutCreatingCoordinator() async throws {
        let repository = ClientDetailBusinessRepository()
        let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "late", principalID: "user", sessionID: "late", taskID: nil, workID: nil)
        let gate = PolicyGate()
        let activity = ConversationDetailPresentationActivity(isActive: true)
        let handle = repository.entry(for: scope)
        var coordinatorCalls = 0
        let host = NSHostingView(rootView: detail(repository: repository, scope: scope, activity: activity,
            api: { await gate.wait() }, coordinator: { _, _ in coordinatorCalls += 1; throw CancellationError() }))
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 280, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
        defer { window.contentView = nil; window.close(); repository.invalidateAll() }
        host.layoutSubtreeIfNeeded(); await waitForConsumerCount(1, handle); #expect(consumerCount(handle) == 1)
        activity.deactivate()
        let api = ClientDetailAPI(transport: BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:49989")!),
            data: { _ in throw CancellationError() }, bytes: { _ in throw CancellationError() }), route: .desktop)
        await gate.resolve(api)
        await settle()
        #expect(consumerCount(handle) == 0)
        #expect(coordinatorCalls == 0)
    }
    @Test func lateCoordinatorIsInvalidatedWithoutRecoveringAfterDeactivation() async throws {
        let repository = ClientDetailBusinessRepository()
        let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "late-coordinator", principalID: "user", sessionID: "late-coordinator", taskID: nil, workID: nil)
        let gate = CoordinatorGate(), journal = EmptyActionJournal()
        let activity = ConversationDetailPresentationActivity(isActive: true)
        let handle = repository.entry(for: scope)
        let api = ClientDetailAPI(transport: BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:49989")!),
            data: { _ in throw CancellationError() }, bytes: { _ in throw CancellationError() }), route: .desktop)
        let host = NSHostingView(rootView: detail(repository: repository, scope: scope, activity: activity,
            api: { api }, coordinator: { _, _ in await gate.wait() }))
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 280, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
        defer { activity.deactivate(); window.contentView = nil; window.close(); repository.invalidateAll() }
        host.layoutSubtreeIfNeeded()
        await waitForConsumerCount(1, handle)
        #expect(consumerCount(handle) == 1)
        try handle.store.receive(ClientDetailBusinessDocument.decode(Data(#"{"protocolVersion":1,"catalog":"native-business-v1","documentId":"detail","sessionId":"late-coordinator","generation":"fixture","revision":"1","cards":[],"order":[]}"#.utf8)))
        for _ in 0..<10 { if await gate.calls > 0 { break }; await settle() }
        #expect(await gate.calls > 0)
        activity.deactivate()
        let coordinator = ClientDetailActionCoordinator(scope: .init(serverID: "fixture", principalID: "user", sessionID: scope.sessionID,
            accountID: "fixture", credentialBindingID: "fixture", catalog: "fixture", capabilityDigest: "fixture"),
            transport: ClientDetailDynamicActionTransport(api: { throw CancellationError() }), journal: journal)
        await gate.resolve(coordinator); await settle()
        #expect(await journal.pendingCalls == 0)
        await #expect(throws: ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED")) { try await coordinator.recover() }
    }
    private actor EmptyActionJournal: ClientDetailActionJournal {
        private(set) var pendingCalls = 0
        func pending(scope: ClientDetailActionScope) -> [ClientDetailPendingAction] { pendingCalls += 1; return [] }
        func save(_ pending: ClientDetailPendingAction) {}
        func remove(scope: ClientDetailActionScope, requestID: String) {}
        func clear(scope: ClientDetailActionScope) {}
    }
    private actor CoordinatorGate {
        private(set) var calls = 0
        private var result: ClientDetailActionCoordinator?
        private var waiters: [CheckedContinuation<ClientDetailActionCoordinator, Never>] = []
        func wait() async -> ClientDetailActionCoordinator {
            calls += 1
            if let result { return result }
            return await withCheckedContinuation { waiters.append($0) }
        }
        func resolve(_ value: ClientDetailActionCoordinator) {
            result = value
            let pending = waiters; waiters.removeAll()
            for waiter in pending { waiter.resume(returning: value) }
        }
    }
    private actor PolicyGate {
        private var result: ClientDetailAPI?
        private var waiters: [CheckedContinuation<ClientDetailAPI, Never>] = []
        func wait() async -> ClientDetailAPI {
            if let result { return result }
            return await withCheckedContinuation { waiters.append($0) }
        }
        func resolve(_ value: ClientDetailAPI) {
            result = value
            let pending = waiters; waiters.removeAll()
            for waiter in pending { waiter.resume(returning: value) }
        }
    }
    private func waitForConsumerCount(_ expected: Int, _ handle: ClientDetailBusinessHandle) async {
        // SwiftUI cancellation is delivered through a subsequent render/lifecycle pass.
        // Other native-window tests can occupy the main actor beyond a fixed 180ms.
        for _ in 0..<40 {
            if consumerCount(handle) == expected { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }
    private func settle() async { try? await Task.sleep(for: .milliseconds(180)) }
}
#endif
