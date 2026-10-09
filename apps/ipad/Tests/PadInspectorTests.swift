import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@Suite(.serialized) @MainActor
struct PadInspectorTests {
    private func snapshot(_ id: String, sections: String, errors: String = "{}") throws -> ClientInspectorSnapshot {
        try JSONDecoder().decode(ClientInspectorSnapshot.self, from: Data("""
        {"schemaVersion":1,"sessionId":"\(id)","resolvedSessionId":"\(id)","workId":null,"taskId":null,"taskDefinition":null,"summary":null,"workDescription":null,"environment":{},"sections":\(sections),"errors":\(errors)}
        """.utf8))
    }
    @Test func failedSectionsRetainLastConfirmedDataButSuccessfulEmptySectionsClear() throws {
        let store = PadInspectorStore()
        store.apply(try snapshot("s", sections: #"{"references":[{"referenceId":"r"}],"artifacts":{"items":[]}}"#), sessionID: "s")
        store.apply(try snapshot("s", sections: #"{"artifacts":{"items":[{"artifactId":"a"}]}}"#, errors: #"{"references":"FAILED"}"#), sessionID: "s")
        #expect(store.sections["references"]?.items.count == 1)
        #expect(store.snapshot?.errors["references"] == "FAILED")
        store.apply(try snapshot("s", sections: #"{"references":[]}"#), sessionID: "s")
        #expect(store.sections["references"]?.items.isEmpty == true)
    }
    @Test func activeScheduleAppearsFromPushAndSuccessfulEmptyUpdateRemovesIt() throws {
        let store = PadInspectorStore()
        store.apply(try snapshot("s", sections: #"{"schedules":[]}"#), sessionID: "s")
        #expect(store.sections["schedules"]?.items.isEmpty == true)
        store.apply(try snapshot("s", sections: #"{"schedules":[{"taskId":"scheduled:one","status":"active","name":"Next check"}]}"#), sessionID: "s")
        #expect(store.sections["schedules"]?.items.first?["name"].text == "Next check")
        store.apply(try snapshot("s", sections: "{}", errors: #"{"schedules":"AUTHORIZATION_REVOKED"}"#), sessionID: "s")
        #expect(store.snapshot?.errors["schedules"] == "AUTHORIZATION_REVOKED")
        store.apply(try snapshot("s", sections: #"{"schedules":[]}"#), sessionID: "s")
        #expect(store.sections["schedules"]?.items.isEmpty == true)
        #expect(store.snapshot?.errors["schedules"] == nil)
    }
    @Test func wrongSessionFrameCannotReplaceVisibleDetail() throws {
        let store = PadInspectorStore()
        store.apply(try snapshot("s", sections: "{}"), sessionID: "s")
        store.apply(try snapshot("other", sections: #"{"references":[{"referenceId":"private"}]}"#), sessionID: "s")
        #expect(store.snapshot?.sessionId == "s")
        #expect(store.sections["references"] == nil)
    }
    @Test func taskDefinitionFromPushRetainsAllVisibleFields() throws {
        let value = try JSONDecoder().decode(ClientInspectorSnapshot.self, from: Data(#"{"schemaVersion":1,"sessionId":"s","resolvedSessionId":"s","workId":"w","taskId":"t","taskDefinition":{"description":"Scope","acceptanceCriteria":"Accepted","verificationCriteria":"Verified"},"summary":null,"workDescription":null,"environment":{},"sections":{},"errors":{}}"#.utf8))
        let store = PadInspectorStore()
        store.apply(value, sessionID: "s")
        #expect(store.snapshot?.taskDefinition?["description"].text == "Scope")
        #expect(store.snapshot?.taskDefinition?["acceptanceCriteria"].text == "Accepted")
        #expect(store.snapshot?.taskDefinition?["verificationCriteria"].text == "Verified")
    }

    @Test func taskDetailAlwaysUsesTheSharedInformationCard() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/PadInspectorResources.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("ConversationTaskInformationCard(summary: summary"))
        #expect(!source.contains("verification: verification"))
        #expect(!source.contains("label: \"验证标准\""))
        #expect(source.contains("showsWhenEmpty: true"))
        #expect(source.contains("ConversationDetailModuleCard(title: \"引用内容\", systemImage: \"link\", headerActions:"))
        #expect(source.contains("ConversationDetailHeaderIcon(systemName: \"plus\")"))
        #expect(!source.contains("Menu(\"添加引用\", systemImage: \"plus\")"))
        #expect(!source.contains("Task 摘要与设置"))
        #expect(!source.contains("ConversationDetailModuleCard(title: \"Task 定义\""))
        #expect(source.contains("ConversationDetailDisclosure(isExpanded: $recallsExpanded"))
        #expect(source.contains("ForEach(recall[\"selectedEntries\"].items"))
        #expect(source.contains("entry[\"content\"].text"))
        #expect(source.contains("ConversationEnvironmentCard(provider: {"))
        #expect(source.contains("Image(systemName: \"chevron.up.chevron.down\")"))
        #expect(!source.contains("ConversationDetailHeaderIcon(systemName: \"arrow.triangle.2.circlepath\")"))
        #expect(source.contains("ConversationDetailDisclosure(isExpanded: $turnExpanded"))
        #expect(source.contains("if let scheduleError = store.snapshot?.errors[\"schedules\"]"))
        #expect(source.contains("scheduleFailure(scheduleError)"))
    }

    @Test func conversationHeaderOffersDesktopMetadataAndCopyActions() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieMobileApp.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        #expect(source.contains("resource: \"header\""))
        #expect(source.contains("UIPasteboard.general.string = title"))
        #expect(source.contains("UIPasteboard.general.string = cwd"))
        #expect(source.contains("conversation-copy-workspace"))
        #expect(source.contains("conversation-open-worktrees"))
        #expect(source.contains("ProviderCodex"))
        #expect(source.contains("ProviderClaudeCode"))
        #expect(source.contains("ProviderOpenClacky"))
    }
}
