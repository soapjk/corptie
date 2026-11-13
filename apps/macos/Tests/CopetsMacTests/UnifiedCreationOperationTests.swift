import AppKit
import Combine
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class UnifiedCreationOperationTests: XCTestCase {
    private func input(work: String? = "work:one") -> UnifiedCreationSubmission {
        .init(requestID: "stable-request", messageID: "message:stable", deliveryID: "delivery:stable",
            text: "First message retained while preparing", imageURLs: [], workID: work, parentTaskID: nil,
            sourceSessionID: "session:source", roleID: "agent:one", providerID: "provider:fixture", modelID: "model:one",
            permission: .init(sandbox: "read-only", approval: "on-request"), serviceTier: "priority",
            supportsPermissions: true, supportsServiceTier: true)
    }

    func testSlowCreationPublishesPendingBeforeIOAndBlocksDuplicateClicksForChatAndTask() async throws {
        for work in [nil, "work:one"] as [String?] {
            let draft = UnifiedCreationDraft(), service = try CreationServiceStub()
            service.createDelay = .milliseconds(50)
            let intent = input(work: work)
            draft.start(intent, service: service)
            XCTAssertTrue(draft.submissionStarted)
            XCTAssertTrue(draft.busy)
            XCTAssertNil(draft.createdSession, "Pending presentation must not manufacture a Session")
            XCTAssertEqual(service.calls, [], "Click must publish before any service call")
            draft.start(intent, service: service)
            await draft.operationTask?.value
            XCTAssertEqual(service.calls, ["create", "permissions", "service-tier", "send"])
            XCTAssertEqual(service.inputs.count, 1)
            XCTAssertEqual(draft.stage, .completed)
        }
    }

    func testConfigurationFailuresKeepOriginalPageAndResumeOnlyUnfinishedSteps() async throws {
        for route in ["permissions", "service-tier"] {
            let draft = UnifiedCreationDraft(), service = try CreationServiceStub()
            service.failOnce = route
            let intent = input()
            draft.start(intent, service: service)
            await draft.operationTask?.value
            XCTAssertNotNil(draft.error)
            XCTAssertNotNil(draft.createdSession)
            XCTAssertTrue(draft.submissionStarted)
            XCTAssertEqual(service.sent.count, 0)
            draft.start(intent, service: service)
            await draft.operationTask?.value
            XCTAssertNil(draft.error)
            XCTAssertEqual(service.calls.filter { $0 == "create" }.count, 1)
            XCTAssertEqual(service.calls.filter { $0 == "permissions" }.count, route == "permissions" ? 2 : 1)
            XCTAssertEqual(service.calls.filter { $0 == "service-tier" }.count, route == "service-tier" ? 2 : 1)
            XCTAssertEqual(service.sent.count, 1)
        }
    }

    func testCreateAndSendFailureRetriesFreezeAllIdentitiesAndSource() async throws {
        for failed in ["create", "send"] {
            let draft = UnifiedCreationDraft(), service = try CreationServiceStub()
            service.failOnce = failed
            let intent = input()
            draft.start(intent, service: service)
            await draft.operationTask?.value
            XCTAssertNotNil(draft.error)
            draft.prompt = "A different draft after leaving"
            draft.providerID = "another-provider"
            draft.start(input(work: nil), service: service)
            await draft.operationTask?.value
            XCTAssertEqual(draft.stage, .completed)
            for retried in service.inputs + service.sent {
                XCTAssertEqual(retried.requestID, intent.requestID)
                XCTAssertEqual(retried.messageID, intent.messageID)
                XCTAssertEqual(retried.deliveryID, intent.deliveryID)
                XCTAssertEqual(retried.text, intent.text)
                XCTAssertEqual(retried.workID, intent.workID)
                XCTAssertEqual(retried.sourceSessionID, intent.sourceSessionID)
                XCTAssertEqual(retried.providerID, intent.providerID)
            }
            if failed == "send" {
                XCTAssertEqual(service.calls.filter { $0 == "create" }.count, 1)
                XCTAssertEqual(service.calls.filter { $0 == "permissions" }.count, 1)
            }
        }
    }

    func testLeavingDoesNotCancelOperationOrClaimNavigationAndReturningCanOpenOnce() async throws {
        let draft = UnifiedCreationDraft(), service = try CreationServiceStub()
        service.createDelay = .milliseconds(80)
        draft.isPresented = true
        draft.start(input(), service: service)
        draft.isPresented = false
        draft.followupEditor.draft.updateFromEditor("Next question")
        await draft.operationTask?.value
        XCTAssertEqual(draft.stage, .completed)
        XCTAssertNil(draft.claimVisibleCompletion())
        XCTAssertEqual(draft.followupEditor.draft.text, "Next question")
        draft.isPresented = true
        XCTAssertEqual(draft.claimVisibleCompletion()?.id, "session:created")
        XCTAssertNil(draft.claimVisibleCompletion())
        draft.start(input(), service: service)
        XCTAssertEqual(service.sent.count, 1)
    }

    func testProgressUsesOnlyAuthoritativeStagesAndCancelsSubscription() {
        var stages: [UnifiedCreationStage] = []
        let token = UnifiedCreationProgressEvents.updates.filter { $0.taskID == "task:one" }.sink { stages.append($0.stage) }
        UnifiedCreationProgressEvents.publish(taskID: "task:other", action: "startup-worktree_prepared")
        UnifiedCreationProgressEvents.publish(taskID: "task:one", action: "invented")
        UnifiedCreationProgressEvents.publish(taskID: "task:one", action: "startup-worktree_prepared")
        UnifiedCreationProgressEvents.publish(taskID: "task:one", action: "startup-session_bound")
        UnifiedCreationProgressEvents.publish(taskID: "task:one", action: "startup-provider_bound")
        token.cancel()
        UnifiedCreationProgressEvents.publish(taskID: "task:one", action: "startup-worktree_prepared")
        XCTAssertEqual(stages, [.worktreePrepared, .sessionBound, .providerBound])
    }

    func testTaskRecoveryRetainsExactFailedOperationAcrossLostResponse() async throws {
        var step = 0
        var creationBodies: [NSDictionary] = []
        var recoveryIDs: [String] = []
        let session = makeTransport()
        defer { session.invalidateAndCancel(); CreationURLProtocol.handler = nil }
        CreationURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Corptie-Logical-Session-Id"), "session:source")
            defer { step += 1 }
            switch step {
            case 0, 4:
                XCTAssertEqual(request.url?.path, "/tasks")
                creationBodies.append(try CreationURLProtocol.body(request) as NSDictionary)
                if step == 0 { return (503, #"{"error":"Workspace preparation failed"}"#) }
                return (200, "{\"session\":\(creationSessionJSON)}")
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertTrue(request.url!.path.hasSuffix("/startup-recovery"))
                return (200, #"{"status":"failed","canRetry":true,"startupOperationId":"startup:failed"}"#)
            case 2, 3:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertTrue(request.url!.path.hasSuffix("/startup-recovery"))
                recoveryIDs.append(try XCTUnwrap(CreationURLProtocol.body(request)["startupOperationId"] as? String))
                if step == 2 { throw URLError(.timedOut) }
                return (200, #"{"status":"ready","canRetry":false,"startupOperationId":"startup:recovered"}"#)
            default: XCTFail("Unexpected duplicate request"); return (500, "{}")
            }
        }
        let service = UnifiedCreationService(backend: BackendClient(), urlSession: session)
        var stages: [UnifiedCreationStage] = []
        for _ in 0..<2 {
            do { _ = try await service.create(input()) { stages.append($0) }; XCTFail("Expected injected failure") }
            catch { }
            UnifiedCreationProgressEvents.publish(taskID: "task:stable-request", action: "startup-worktree_prepared")
            XCTAssertTrue(stages.isEmpty, "Failure must release the task progress subscription")
        }
        let created = try await service.create(input()) { stages.append($0) }
        XCTAssertEqual(created.id, "session:created")
        XCTAssertEqual(step, 5)
        XCTAssertEqual(recoveryIDs, ["startup:failed", "startup:failed"])
        XCTAssertEqual(creationBodies.count, 2)
        XCTAssertEqual(creationBodies.first, creationBodies.last)
        XCTAssertEqual(creationBodies.first?["id"] as? String, "task:stable-request")
        UnifiedCreationProgressEvents.publish(taskID: "task:stable-request", action: "startup-worktree_prepared")
        XCTAssertTrue(stages.isEmpty, "Success must release the task progress subscription")
    }

    func testChatPendingReceiptRequeriesSameIntentWithoutSending() async throws {
        var attempts: [NSDictionary] = []
        let session = makeTransport()
        defer { session.invalidateAndCancel(); CreationURLProtocol.handler = nil }
        CreationURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/desktop/chats/create")
            attempts.append(try CreationURLProtocol.body(request) as NSDictionary)
            let status = attempts.count == 1 ? "dispatching" : "completed"
            let value = attempts.count == 1 ? "null" : creationSessionJSON
            return (200, """
                {"receipt":{"schemaVersion":1,"requestId":"stable-request","sessionId":"session:created","kind":"chat_create","status":"\(status)","updatedAt":"2026-11-13"},"session":\(value)}
                """)
        }
        let service = UnifiedCreationService(backend: BackendClient(), urlSession: session)
        do { _ = try await service.create(input(work: nil)) { _ in }; XCTFail("Pending receipt is not a Session") }
        catch { }
        let created = try await service.create(input(work: nil)) { _ in }
        XCTAssertEqual(created.id, "session:created")
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts.first, attempts.last)
    }

    private func makeTransport() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CreationURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    func testNativeClickRendersPendingConversationDuringControlledTwoSecondCreation() async throws {
        _ = NSApplication.shared
        let draft = UnifiedCreationDraft(), service = try CreationServiceStub()
        service.createDelay = .seconds(2)
        let intent = input()
        let host = NSHostingView(rootView: CreationClickHarness(draft: draft) { draft.start(intent, service: service) })
        let window = NSWindow(contentRect: .init(x: 100, y: 100, width: 640, height: 480),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        let button = try XCTUnwrap(findButton(host))
        let started = ContinuousClock.now
        button.performClick(nil)
        try await Task.sleep(for: .milliseconds(60))
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        XCTAssertTrue(draft.submissionStarted)
        XCTAssertNil(draft.createdSession)
        XCTAssertEqual(service.sent.count, 0)
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let elapsed = started.duration(to: .now)
        print("[creation-ui-evidence] native control activation to pending view capture: \(elapsed); injected create delay: 2 seconds; Session still absent")
        XCTAssertLessThan(elapsed, .seconds(1))
        if let directory = ProcessInfo.processInfo.environment["CORPTIE_CREATION_CAPTURE_DIR"],
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: directory).appending(path: "pending-creation.png"))
        }
        await draft.operationTask?.value
        XCTAssertEqual(draft.stage, .completed)
    }

    private func findButton(_ view: NSView) -> NSButton? {
        if let button = view as? NSButton { return button }
        return view.subviews.lazy.compactMap(findButton).first
    }
}

private let creationSessionJSON = #"{"id":"session:created","title":"Created","agent":"Fixture","status":"complete","progress":1,"summary":"","updatedAt":"2026-11-13","accent":"cyan"}"#

private final class CreationURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
}

@MainActor
private final class CreationServiceStub: UnifiedCreationServing {
    var calls: [String] = []
    var inputs: [UnifiedCreationSubmission] = []
    var sent: [UnifiedCreationSubmission] = []
    var failOnce: String?
    var createDelay: Duration = .zero
    let session: TaskSession
    init() throws {
        session = try JSONDecoder().decode(TaskSession.self, from: Data(#"{"id":"session:created","title":"Created","agent":"Fixture","status":"complete","progress":1,"summary":"","updatedAt":"2026-11-13","accent":"cyan"}"#.utf8))
    }
    func check(_ stage: String) throws {
        calls.append(stage)
        if failOnce == stage { failOnce = nil; throw BackendError.message("Injected \(stage) failure") }
    }
    func create(_ input: UnifiedCreationSubmission, progress: @escaping (UnifiedCreationStage) -> Void) async throws -> TaskSession {
        inputs.append(input)
        try check("create")
        try await Task.sleep(for: createDelay)
        return session
    }
    func configure(_ session: TaskSession, route: String, values: [String: String]) async throws -> TaskSession {
        try check(route)
        if route == "permissions" { XCTAssertEqual(values["sandbox"], "read-only") }
        if route == "service-tier" { XCTAssertEqual(values["serviceTier"], "priority") }
        return session
    }
    func importImage(_ url: URL, session: TaskSession) async throws -> ChatImageReference { fatalError("No fixture images") }
    func send(_ input: UnifiedCreationSubmission, session: TaskSession, images: [ChatImageReference]) async throws {
        sent.append(input)
        try check("send")
    }
}

private struct CreationClickHarness: View {
    @ObservedObject var draft: UnifiedCreationDraft
    let send: () -> Void
    var body: some View {
        Group {
            if draft.submissionStarted {
                UnifiedCreationProgressView(draft: draft, retry: send, open: {}) {
                    ComposerInputTextView(controller: draft.followupEditor, placeholder: "Next message",
                        font: .systemFont(ofSize: 13), onSubmit: { _ in }).frame(height: 60)
                }
            } else { NativeCreationTestButton(action: send) }
        }
        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.white)
    }
}

private struct NativeCreationTestButton: NSViewRepresentable {
    let action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action: action) }
    func makeNSView(context: Context) -> NSButton {
        NSButton(title: "Send first message", target: context.coordinator, action: #selector(Coordinator.click))
    }
    func updateNSView(_ button: NSButton, context: Context) {}
    final class Coordinator: NSObject {
        let action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func click() { action() }
    }
}
