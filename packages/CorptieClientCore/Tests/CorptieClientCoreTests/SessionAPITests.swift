import Foundation
import Testing
@testable import CorptieClientCore

struct SessionAPITests {
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
}

private final class SessionProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        let path = request.url!.path
        let json: String
        if path.hasSuffix("/tasks") {
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
                json = #"{"schemaVersion":1,"sessionId":"session:test","commands":[{"name":"goal","usage":"/goal","summary":"管理目标","available":true,"requiredPermissions":["messages.read"],"requiresConfirmation":false,"canMutate":false}]}"#
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
        } else if path.hasSuffix("capabilities") {
            json = #"{"schemaVersion":1,"sessionId":"session:test","readMessages":true,"send":{"available":true},"stop":{"available":false}}"#
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
}
