import Foundation
import Testing
@testable import CorptieClientCore

struct SessionAPITests {
    @MainActor
    @Test func sharedTimeSeparatorUsesFiveMinuteGapAndCalendarDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let locale = Locale(identifier: "en_US_POSIX")
        let first = calendar.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 23, minute: 58))!
        let near = first.addingTimeInterval(299)
        let nextDay = first.addingTimeInterval(420)

        #expect(ConversationTimeSeparatorText.label(
            for: first, after: nil, now: nextDay, calendar: calendar, locale: locale
        ) == nil)
        #expect(ConversationTimeSeparatorText.label(
            for: near, after: first, now: nextDay, calendar: calendar, locale: locale
        ) == nil)
        #expect(ConversationTimeSeparatorText.label(
            for: nextDay, after: first, now: nextDay, calendar: calendar, locale: locale
        )?.contains("2026") == true)
    }
    @Test func workCreationUsesPairedDeviceRouteAndTypedReceipt() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        #expect(try await api.workCreationOptions().agents.map(\.id) == ["agent:test"])
        let receipt = try await api.createWork(ClientWorkCreation(requestId: "work_create1", name: "NewWork",
            description: "Scope", contributorAgentIds: ["agent:test"]))
        #expect(receipt.kind == "work_create")
        #expect(receipt.entityResult?.workId == "work:new")
    }
    @Test func taskCreationUsesScopedRouteAndKeepsStructuredReceipt() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        let input = ClientTaskCreation(requestId: "create_123", workId: "work:test", title: "Task",
            mainAgentId: "agent:test", providerId: "provider:test")
        let receipt = try await api.createTask(sourceSessionId: "session:test", input: input)
        #expect(receipt.kind == "create_task")
        #expect(receipt.taskResult?.taskId == "task:new")
        #expect(receipt.taskResult?.sessionId == "session:new")
        #expect(receipt.commandResult == nil)
        let options = try await api.taskCreationOptions(sourceSessionId: "session:test", providerId: "provider:test")
        #expect(options.work.id == "work:test")
        #expect(options.providers.first?.available == true)
        #expect(options.models.first?.reasoningLevels == ["high"])
        #expect(try await api.receipt(requestId: "request_123").taskResult == nil)
        #expect(try await api.capabilities(sessionId: "session:test").createTask == nil)
    }
    @Test func entityManagementUsesClosedRoutesAndTypedEntityResults() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        let management = try await api.taskManagement(taskId: "task:one")
        #expect(management.task.title == "Task")
        #expect(management.task.archived == false)
        #expect(management.actions.restart == ClientEntityAction(available: false, reason: "PROVIDER_INITIALIZING"))
        #expect(management.actions.delete.available)
        #expect(management.agents.map(\.id) == ["agent:test"])
        let plan = try await api.taskDeletionPlan(taskId: "task:one")
        #expect(plan.status == "risky")
        #expect(plan.worktree?.branchName == "task/abc")
        #expect(plan.risks.first?.files == ["a.swift"])
        #expect(plan.blockers.isEmpty)
        let work = try await api.workManagement(workId: "work:one")
        #expect(work.work.name == "Work")
        #expect(work.actions.delete == ClientEntityAction(available: false, reason: "WORK_TASK_DELETING"))
        var update = ClientTaskUpdate(requestId: "update_12345")
        update.title = "Renamed"
        update.autoTitleEnabled = false
        let renamed = try await api.taskCommand(taskId: "task:one", command: .update, body: update)
        #expect(renamed.kind == "task_update")
        #expect(renamed.entityResult?.title == "Renamed")
        #expect(renamed.taskResult == nil && renamed.commandResult == nil)
        var deletion = ClientTaskDeletion(requestId: "delete_12345")
        deletion.mode = "force"; deletion.acknowledgeDataLoss = true; deletion.confirmedBranchName = "task/abc"
        let deleted = try await api.taskCommand(taskId: "task:one", command: .delete, body: deletion)
        #expect(deleted.entityResult?.operationId == "op:1")
        let removed = try await api.workCommand(workId: "work:one", command: .delete, body: ClientEntityRequest(requestId: "delete_work12"))
        #expect(removed.kind == "work_delete")
        #expect(removed.entityResult?.workId == "work:one")
        #expect(try await api.receipt(requestId: "request_123").entityResult == nil)
    }
    @Test func capabilitiesCarryReadinessAndUsageIsAReadOnlyProjection() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        let capabilities = try await api.capabilities(sessionId: "session:test")
        #expect(capabilities.readiness == "not_ready")
        #expect(capabilities.notReadyReason == ClientSessionNotReadyReason(code: "PROVIDER_INITIALIZING", message: "Provider is starting", retryable: true))
        let usage = try await api.usage(sessionId: "session:test")
        #expect(usage.context?.usedTokens == 10)
        #expect(usage.context?.usedPercent == 10)
        #expect(usage.account?.provider == "codex")
        #expect(usage.account?.rateLimits?.primary?.windowDurationMins == 300)
        #expect(usage.account?.rateLimits?.secondary == nil)
        #expect(usage.account?.rateLimitsByLimitId?["codex"]?.primary?.usedPercent == 25)
        let legacy = try JSONDecoder().decode(ClientSessionCapabilities.self,
            from: Data(#"{"schemaVersion":1,"sessionId":"s","readMessages":true,"send":{"available":true},"stop":{"available":true}}"#.utf8))
        #expect(legacy.readiness == nil)
        #expect(legacy.notReadyReason == nil)
    }
    @Test func timelinePresentationDecodesAdditivelyAndInvalidatesOnStateChanges() throws {
        let data = Data(#"{"id":"tool:1","turnId":"turn:1","type":"commandExecution","text":"output","turnStatus":"running","title":"Read source","presentationRole":"commentary","presentationText":"检查代码","sourceType":"tool","localVisibility":"visible","processingError":"failed","processStartedAt":"start","processEndedAt":"end"}"#.utf8)
        let decoder = JSONDecoder()
        let message = try decoder.decode(ClientMessage.self, from: data)
        #expect(message.turnStatus == "running")
        #expect(message.title == "Read source")
        #expect(message.presentationRole == "commentary")
        #expect(message.presentationText == "检查代码")
        #expect(message.sourceType == "tool")
        #expect(message.localVisibility == "visible")
        #expect(message.processingError == "failed")
        #expect(message.processStartedAt == "start")
        #expect(message.processEndedAt == "end")
        let changed = Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "running", with: "completed").utf8)
        #expect(message != (try decoder.decode(ClientMessage.self, from: changed)))
        let legacy = try decoder.decode(ClientMessage.self,
            from: Data(#"{"id":"old","type":"agentMessage","text":"hello"}"#.utf8))
        #expect(legacy.turnStatus == nil)
        #expect(legacy.presentationRole == nil)
        #expect(legacy.processStartedAt == nil)
        #expect(ClientMessage(id: "local", text: "draft").presentationRole == nil)
    }

    @Test func approvalOptionsAndSubmissionStateDecodeWithoutProviderData() throws {
        let data = Data(#"{"id":"approval:one","type":"approval","text":"Proceed?","status":"submitted","options":[{"id":"yes","label":"允许","role":"approve","selected":false},{"id":"no","label":"拒绝","role":"deny","selected":false}]}"#.utf8)
        let message = try JSONDecoder().decode(ClientMessage.self, from: data)
        #expect(message.status == "submitted")
        #expect(message.options?.map(\.id) == ["yes", "no"])
        #expect(message.options?.first?.role == "approve")
        let legacy = try JSONDecoder().decode(ClientMessage.self,
            from: Data(#"{"id":"old","type":"agentMessage","text":"hello"}"#.utf8))
        #expect(legacy.options == nil)
    }

    @Test func multiQuestionInputDecodesFromTheSharedTimelineAndPostsStructuredAnswers() async throws {
        let data = Data(#"{"id":"input:one","type":"userInput","text":"Choose route","status":"pending","userInput":{"schemaVersion":1,"isBlocking":true,"questions":[{"id":"route","header":"Route","question":"Choose route","isOther":false,"isSecret":false,"options":[{"label":"A","description":"Fast"}]},{"id":"token","header":"Token","question":"Enter token","isOther":false,"isSecret":true,"options":null}]}}"#.utf8)
        let message = try JSONDecoder().decode(ClientMessage.self, from: data)
        #expect(message.userInput?.questions.map(\.id) == ["route", "token"])
        #expect(message.userInput?.questions[1].isSecret == true)
        #expect(message.userInput?.questions[1].options == nil)
        #expect(message.userInput?.isBlocking == true)
        let legacy = try JSONDecoder().decode(ClientMessage.self,
            from: Data(#"{"id":"old","type":"agentMessage","text":"hello"}"#.utf8))
        #expect(legacy.userInput == nil)

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        let response = try await api.respondToUserInput(sessionId: "session:test", itemId: "input:one",
            answers: ["route": ["A"], "token": ["secret-value"]])
        #expect(response.status == "submitted")
        #expect(response.itemId == "input:one")
    }

    @Test func attachmentsDecodeAdditivelyAndStreamThroughTheSessionImageRoute() async throws {
        let decoder = JSONDecoder()
        let message = try decoder.decode(ClientMessage.self, from: Data(#"{"id":"m","type":"userMessage","text":"see","images":[{"managedPath":"chat-resources/session/a.png","fileName":"a.png","mimeType":"image/png","byteLength":9},{"managedPath":"chat-resources/session/b.png"}]}"#.utf8))
        #expect(message.images.map(\.id) == ["chat-resources/session/a.png", "chat-resources/session/b.png"])
        #expect(message.images[0].fileName == "a.png")
        #expect(message.images[1].mimeType == nil)
        let legacy = try decoder.decode(ClientMessage.self, from: Data(#"{"id":"old","type":"agentMessage","text":"hello"}"#.utf8))
        #expect(legacy.images.isEmpty)
        #expect(ClientMessage(id: "local", text: "draft").images.isEmpty)

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        let payload = try await api.image(sessionId: "session:test", managedPath: "chat-resources/session/a.png")
        #expect(payload?.contentType == "image/png")
        #expect(payload.map { String(decoding: $0.data, as: UTF8.self) } == "png-bytes")
        #expect(try await api.image(sessionId: "session:test", managedPath: "chat-resources/session/gone.png") == nil)
    }

    @Test func timelineTimestampsMatchTheDesktopLabel() {
        let label = ConversationTimestampText.messageLabel(createdAt: "2026-09-19T08:05:09.123Z")
        let expected = Date(timeIntervalSince1970: 1_789_805_109.123)
            .formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute().second())
        #expect(label == expected)
        #expect(ConversationTimestampText.messageLabel(createdAt: "2026-09-19T08:05:09Z")
            == Date(timeIntervalSince1970: 1_789_805_109).formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute().second()))
        #expect(ConversationTimestampText.messageLabel(createdAt: nil) == "")
        #expect(ConversationTimestampText.messageLabel(createdAt: "not a date") == "")
    }

    @Test func slashSyntaxPreservesArgumentsWithoutTreatingPathsAsCommands() throws {
        let command = try #require(ClientConversationCommand.parse("  /GoAl  edit 修复输入框\n保留历史  "))
        #expect(command.name == "goal")
        #expect(command.arguments == "edit 修复输入框\n保留历史")
        #expect(ClientConversationCommand.parse("/goal")?.arguments == "")
        #expect(ClientConversationCommand.parse("/future-command 123")?.name == "future-command")
        for text in ["/tmp/file", "/", "//goal", "普通消息 /goal", "/123", "/goal_foo"] {
            #expect(ClientConversationCommand.parse(text) == nil)
        }
    }

    @Test func conversationCommandsUseDedicatedRouteAndTypedResult() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        let catalog = try await api.commandCatalog(sessionId: "session:test")
        #expect(catalog.commands.first?.name == "goal")
        #expect(catalog.commands.first?.canMutate == false)
        let receipt = try await api.conversationCommand(sessionId: "session:test", requestId: "goal_12345",
            command: #require(ClientConversationCommand.parse("/goal")))
        #expect(receipt.kind == "conversation_command")
        #expect(receipt.status == "completed")
        #expect(receipt.commandResult?.text == "当前没有目标。")
        #expect(receipt.commandResult?.truncated == false)
        #expect(try await api.receipt(requestId: "request_123").commandResult == nil)
    }

    @Test func typedCommandsAndHistoryUseVersionedRoutes() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        #expect(try await api.send(sessionId: "session:test", requestId: "request_123", text: "Hello").status == "accepted")
        #expect(try await api.stop(sessionId: "session:test", requestId: "stop_12345").status == "stop_requested")
        #expect(try await api.receipt(requestId: "request_123").requestId == "request_123")
        #expect(try await api.messages(sessionId: "session:test", before: "item:1").items.isEmpty)
        #expect(try await api.capabilities(sessionId: "session:test").send.available)
    }

    @Test func collaborationPresentationOverridesUserMessageVisualMeaning() throws {
        let message = try JSONDecoder().decode(ClientMessage.self, from: Data(#"""
        {
          "id":"work:1","type":"userMessage","text":"trusted capsule",
          "presentationRole":"collaboration","presentationText":"Please review",
          "status":"running","collaborationDirection":"inbound",
          "collaborationInitiatorSessionId":"session:source","collaborationInitiatorSessionTitle":"Source",
          "collaborationRecipientSessionId":"session:target","collaborationRecipientSessionTitle":"Target",
          "collaborationSourceWorkName":"Work A","collaborationTargetWorkName":"Work B",
          "collaborationMessageKind":"change_request"
        }
        """#.utf8))
        #expect(message.presentationKind == .collaborationMessage)
        #expect(message.collaborationPresentation?.body == "Please review")
        #expect(message.collaborationPresentation?.sourceSession == "Source")
        #expect(message.collaborationPresentation?.targetSession == "Target")
        #expect(message.collaborationPresentation?.messageKind == "change_request")
        #expect(ConversationPresentationKind.resolve(type: "userMessage", presentationRole: nil) == .userMessage)
        #expect(ConversationPresentationKind.resolve(type: "future", presentationRole: nil) == .unknown)
    }

    @Test func collaborationConfirmationUsesClosedClientRoute() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let response = try await ClientSessionAPI(transport: transport).respondToCollaborationConfirmation(
            sessionId: "session:test", itemId: "confirmation:item", approve: true)
        #expect(response.status == "confirmed")
    }
}

private final class SessionProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        let path = request.url!.path
        let json: String
        if path.hasPrefix("/client/v1/tasks/") || path.hasPrefix("/client/v1/works/") {
            let route = path.split(separator: "/").last.map(String.init) ?? ""
            let body = (try? JSONSerialization.jsonObject(with: Self.body(of: request))) as? [String: Any]
            switch (path, route, request.httpMethod) {
            case ("/client/v1/works/create", _, "GET"):
                json = #"{"schemaVersion":1,"agents":[{"id":"agent:test","name":"Test"}]}"#
            case ("/client/v1/works/create", _, "POST"):
                #expect(body?["name"] as? String == "NewWork")
                #expect(body?["contributorAgentIds"] as? [String] == ["agent:test"])
                #expect(body?["requestId"] as? String == "work_create1")
                json = #"{"schemaVersion":1,"requestId":"work_create1","sessionId":"","kind":"work_create","status":"completed","updatedAt":"now","entityResult":{"workId":"work:new","name":"NewWork"}}"#
            case ("/client/v1/tasks/task:one/management", _, "GET"):
                json = #"{"schemaVersion":1,"task":{"id":"task:one","workId":"work:one","title":"Task","description":"","acceptanceCriteria":"","verificationCriteria":"","priority":"medium","lifecycleState":"todo","archived":false,"mainAgentId":"agent:test","deletionStatus":null},"agents":[{"id":"agent:test","name":"Test"}],"priorities":["low","medium","high","urgent"],"actions":{"rename":{"available":true,"reason":null},"edit":{"available":true,"reason":null},"restart":{"available":false,"reason":"PROVIDER_INITIALIZING"},"archive":{"available":true,"reason":null},"unarchive":{"available":false,"reason":"TASK_NOT_ARCHIVED"},"delete":{"available":true,"reason":null}}}"#
            case ("/client/v1/tasks/task:one/deletion", _, "GET"):
                json = #"{"schemaVersion":1,"taskId":"task:one","status":"risky","associatedSessionCount":1,"artifacts":[{"id":"artifact:a","title":"Plan"}],"worktree":{"branchName":"task/abc","dirty":true,"mergedIntoMain":false,"aheadOfMain":2},"risks":[{"code":"DIRTY_WORKTREE","message":"uncommitted","files":["a.swift"],"commitCount":2}],"blockers":[]}"#
            case ("/client/v1/works/work:one/management", _, "GET"):
                json = #"{"schemaVersion":1,"work":{"id":"work:one","name":"Work","description":"","status":"active"},"actions":{"edit":{"available":true,"reason":null},"delete":{"available":false,"reason":"WORK_TASK_DELETING"}}}"#
            case ("/client/v1/tasks/task:one/update", _, "POST"):
                #expect(body?["title"] as? String == "Renamed")
                #expect(body?["autoTitleEnabled"] as? Bool == false)
                #expect(body?["description"] == nil, "unset optionals stay off the wire")
                json = #"{"schemaVersion":1,"requestId":"update_12345","sessionId":"","kind":"task_update","status":"completed","errorCode":null,"updatedAt":"now","entityResult":{"taskId":"task:one","title":"Renamed"}}"#
            case ("/client/v1/tasks/task:one/delete", _, "POST"):
                #expect(body?["mode"] as? String == "force")
                #expect(body?["acknowledgeDataLoss"] as? Bool == true)
                #expect(body?["confirmedBranchName"] as? String == "task/abc")
                #expect(body?["deleteWorktree"] as? Bool == true)
                json = #"{"schemaVersion":1,"requestId":"delete_12345","sessionId":"","kind":"task_delete","status":"completed","errorCode":null,"updatedAt":"now","entityResult":{"taskId":"task:one","operationId":"op:1","state":"queued"}}"#
            case ("/client/v1/works/work:one/delete", _, "POST"):
                #expect(body?.keys.sorted() == ["requestId"])
                json = #"{"schemaVersion":1,"requestId":"delete_work12","sessionId":"","kind":"work_delete","status":"completed","errorCode":null,"updatedAt":"now","entityResult":{"workId":"work:one"}}"#
            default:
                Issue.record("unexpected entity route \(request.httpMethod ?? "") \(path)")
                json = "{}"
            }
        } else if path.hasSuffix("/tasks") {
            #expect(path == "/client/v1/sessions/session:test/tasks")
            if request.httpMethod == "GET" {
                #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == "provider:test")
                json = #"{"schemaVersion":1,"sourceSessionId":"session:test","work":{"id":"work:test","name":"Work"},"agents":[],"providers":[{"id":"provider:test","name":"Test","available":true,"supportsModels":true}],"providerId":"provider:test","models":[{"id":"m","name":"Model","reasoningLevels":["high"]}],"priorities":["medium"]}"#
            } else {
                #expect(request.httpMethod == "POST")
                json = #"{"schemaVersion":1,"requestId":"create_123","sessionId":"session:test","kind":"create_task","status":"completed","updatedAt":"now","taskResult":{"taskId":"task:new","sessionId":"session:new","workId":"work:test"}}"#
            }
        } else if path.hasSuffix("conversation-commands") {
            #expect(path == "/client/v1/sessions/session:test/conversation-commands")
            if request.httpMethod == "GET" {
                json = #"{"schemaVersion":1,"sessionId":"session:test","commands":[{"name":"goal","usage":"/goal","summary":"管理目标","available":true,"requiresConfirmation":false,"canMutate":false}]}"#
            } else {
                #expect(request.httpMethod == "POST")
                var data = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open()
                    defer { stream.close() }
                    var bytes = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable {
                        let count = stream.read(&bytes, maxLength: bytes.count)
                        if count <= 0 { break }
                        data.append(contentsOf: bytes.prefix(count))
                    }
                }
                let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                #expect(body?["name"] as? String == "goal")
                #expect(body?["arguments"] as? String == "")
                #expect(body?["confirmed"] as? Bool == false)
                #expect(body?["requestId"] as? String == "goal_12345")
                #expect(body?["text"] == nil)
                json = #"{"schemaVersion":1,"sessionId":"session:test","requestId":"goal_12345","kind":"conversation_command","status":"completed","updatedAt":"2026-09-19T00:00:00Z","commandResult":{"text":"当前没有目标。","truncated":false}}"#
            }
        } else if path.hasSuffix("/images") {
            #expect(request.httpMethod == "GET")
            let managed = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
            if managed == "chat-resources/session/a.png" {
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "image/png"])!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data("png-bytes".utf8))
            } else {
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data(#"{"code":"IMAGE_NOT_AVAILABLE"}"#.utf8))
            }
            client?.urlProtocolDidFinishLoading(self)
            return
        } else if path.hasSuffix("capabilities") {
            json = #"{"schemaVersion":1,"sessionId":"session:test","readMessages":true,"send":{"available":true},"stop":{"available":false},"readiness":"not_ready","notReadyReason":{"code":"PROVIDER_INITIALIZING","message":"Provider is starting","retryable":true}}"#
        } else if path.hasSuffix("/usage") {
            #expect(request.httpMethod == "GET")
            #expect(path == "/client/v1/sessions/session:test/usage")
            json = #"{"schemaVersion":1,"sessionId":"session:test","context":{"usedTokens":10,"contextWindow":100,"remainingTokens":90,"usedPercent":10},"account":{"available":true,"provider":"codex","model":"gpt-5","rateLimits":{"limitId":"codex","limitName":"Codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1700000000},"secondary":null},"rateLimitsByLimitId":{"codex":{"limitId":"codex","limitName":"Codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1700000000},"secondary":null}}}}"#
        } else if path.hasSuffix("/user-input") {
            #expect(request.httpMethod == "POST")
            let body = (try? JSONSerialization.jsonObject(with: Self.body(of: request))) as? [String: Any]
            #expect(body?["itemId"] as? String == "input:one")
            let answers = body?["answers"] as? [String: [String]]
            #expect(answers?["route"] == ["A"])
            #expect(answers?["token"] == ["secret-value"])
            json = #"{"schemaVersion":1,"sessionId":"session:test","itemId":"input:one","status":"submitted"}"#
        } else if path.hasSuffix("/collaboration-confirmation") {
            #expect(request.httpMethod == "POST")
            let body = (try? JSONSerialization.jsonObject(with: Self.body(of: request))) as? [String: Any]
            #expect(body?["itemId"] as? String == "confirmation:item")
            #expect(body?["decision"] as? String == "confirm")
            json = #"{"schemaVersion":1,"sessionId":"session:test","itemId":"confirmation:item","status":"confirmed"}"#
        } else if path.hasSuffix("messages") && request.httpMethod == "GET" {
            #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(URLQueryItem(name: "before", value: "item:1")) == true)
            json = #"{"schemaVersion":1,"sessionId":"session:test","items":[],"hasEarlier":false}"#
        } else {
            let stopping = path.hasSuffix("stop")
            #expect(path.hasPrefix("/client/v1/"))
            #expect(request.httpMethod == (path.contains("/commands/") ? "GET" : "POST"))
            json = "{\"schemaVersion\":1,\"sessionId\":\"session:test\",\"requestId\":\"request_123\",\"kind\":\"\(stopping ? "stop" : "send")\",\"status\":\"\(stopping ? "stop_requested" : "accepted")\",\"updatedAt\":\"2026-09-13T00:00:00Z\"}"
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    private static func body(of request: URLRequest) -> Data {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(contentsOf: bytes.prefix(count))
            }
        }
        return data
    }
}
