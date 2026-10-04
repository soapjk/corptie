import Foundation
import Testing
import CorptieClientCore
import CorptieClientSecurity
@testable import CorptieMobileState

@MainActor struct PadConversationNoticeTests {
    private func snapshot(sessionID: String = "session:test") throws -> ClientTimelineSnapshot {
        let json = #"{"schemaVersion":2,"kind":"snapshot","sessionId":"SESSION","revision":1,"messages":{"schemaVersion":1,"sessionId":"SESSION","items":[{"id":"reply","type":"agentMessage","text":"working reply"}],"hasEarlier":false,"nextBefore":null,"revision":1},"capabilities":{"schemaVersion":1,"sessionId":"SESSION","readMessages":true,"send":{"available":true},"stop":{"available":false},"composer":true},"usage":null,"composer":null}"#
        return try JSONDecoder().decode(ClientTimelineSnapshot.self, from: Data(json.replacingOccurrences(of: "SESSION", with: sessionID).utf8))
    }

    @Test func transientReadFailuresAreSilentButExplicitSettingsUpdateIsNot() {
        let workspace = PadWorkspace()
        for error in [URLError(.timedOut) as any Error, URLError(.networkConnectionLost), CloudRelayTransportError.disconnected] {
            workspace.reportConversationReadFailure(error, operation: .messages)
            #expect(workspace.conversationNotice.isEmpty)
            workspace.reportConversationReadFailure(error, operation: .composer)
            #expect(workspace.conversationNotice.isEmpty)
        }
        workspace.reportConversationReadFailure(URLError(.timedOut), operation: .updateComposer)
        #expect(workspace.conversationNotice.hasPrefix("更新模型设置失败："))
        #expect(!workspace.conversationNotice.contains("HTTPS"))
    }

    @Test func successfulSelectedTimelineClearsReadErrorWithoutClearingUnknownSendOutcome() throws {
        let workspace = PadWorkspace()
        workspace.selection = "session:test"
        workspace.status = "暂时无法确认请求是否已送达，请查询回执。不会自动重发。"
        workspace.reportConversationReadFailure(ClientConnectionError.invalidResponse, operation: .messages)
        #expect(workspace.conversationNotice.hasPrefix("加载消息失败："))
        workspace.applyRealtimeTimeline(try snapshot(sessionID: "session:other"))
        #expect(!workspace.conversationNotice.isEmpty)
        workspace.applyRealtimeTimeline(try snapshot())
        #expect(workspace.conversationNotice.isEmpty)
        #expect(workspace.status.contains("不会自动重发"))
        #expect(workspace.messages.first?.text == "working reply")
    }

    @Test func incomingMessagesDoNotEraseSettingsMutationOrAttachmentError() throws {
        let workspace = PadWorkspace()
        workspace.selection = "session:test"
        workspace.reportConversationReadFailure(URLError(.timedOut), operation: .updateComposer)
        workspace.applyRealtimeTimeline(try snapshot())
        #expect(workspace.conversationNotice.hasPrefix("更新模型设置失败："))
        workspace.clearConversationReadNotice(.composer)
        #expect(!workspace.conversationNotice.isEmpty)
        workspace.clearConversationReadNotice(.updateComposer)
        #expect(workspace.conversationNotice.isEmpty)
        workspace.conversationNotice = "图片文件读取失败。"
        workspace.applyRealtimeTimeline(try snapshot())
        #expect(workspace.conversationNotice == "图片文件读取失败。")
    }

    @Test func optionalComposerNetworkFailureDoesNotPolluteWorkingChat() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let transport = BackendTransport(endpoint: endpoint, data: { _ in throw URLError(.timedOut) },
            bytes: { _ in throw URLError(.timedOut) })
        let workspace = PadWorkspace()
        workspace.selection = "session:test"
        workspace.capabilities = try snapshot().capabilities
        let connection = PadConnection(transportOverride: transport)
        await workspace.configureComposer(connection)
        #expect(workspace.conversationNotice.isEmpty)
        await workspace.load(connection)
        #expect(workspace.conversationNotice.isEmpty)
        await workspace.configureComposer(connection, update: ["model": "test-model"])
        #expect(workspace.conversationNotice.hasPrefix("更新模型设置失败："))
        await workspace.load(connection)
        #expect(workspace.conversationNotice.hasPrefix("更新模型设置失败："))
    }

    @Test func cancellationNeverOverwritesAnActionNotice() {
        let workspace = PadWorkspace()
        workspace.conversationNotice = "照片导入失败，请重试。"
        workspace.reportConversationReadFailure(URLError(.cancelled), operation: .messages)
        workspace.reportConversationReadFailure(CancellationError(), operation: .composer)
        #expect(workspace.conversationNotice == "照片导入失败，请重试。")
    }
}
