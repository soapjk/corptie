import Testing
@testable import CorptieMac

struct EntityNamePolicyTests {
    @Test("标题接受中文英文数字横杠下划线")
    func acceptsAllowedCharacters() {
        #expect(EntityNamePolicy.isValid("Work任务2026"))
        #expect(EntityNamePolicy.isValid("ABCxyz123"))
        #expect(EntityNamePolicy.isValid("纯中文名称"))
        #expect(EntityNamePolicy.isValid("MarketCow-SDK_v2"))
        #expect(EntityNamePolicy.isValid("_2026"))
    }

    @Test("名称拒绝空白和标点符号", arguments: [
        "Two Words", "前后 空格", "2号策略", "0Task", "Task\n", "Task%", "Task,One",
        "名称。", "名称/Task", "", "\n"
    ])
    func rejectsWhitespaceAndPunctuation(value: String) {
        #expect(!EntityNamePolicy.isValid(value))
    }
}
