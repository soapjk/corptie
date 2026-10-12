import Testing
@testable import CorptieConversation

struct ConversationReferenceStatusTests {
    @Test func pathsNeverClaimTheirContentsWereRead() {
        #expect(ConversationReferenceStatus.label(for: "available", targetType: "localFile") == "已引用")
        #expect(ConversationReferenceStatus.label(for: "changed", targetType: "localFile") == "已引用")
        #expect(ConversationReferenceStatus.label(for: "missing", targetType: "localFile") == "文件不存在")
        #expect(ConversationReferenceStatus.label(for: "unavailable", targetType: "localFile") == "无法检查文件")
        #expect(ConversationReferenceStatus.label(for: "available", targetType: "localFile", enabled: false) == "已停用")
        #expect(ConversationReferenceStatus.label(for: "available", targetType: "webURL") == "可用")
    }
}
