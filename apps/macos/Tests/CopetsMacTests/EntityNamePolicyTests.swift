import Testing
@testable import CorptieMac

struct EntityNamePolicyTests {
    @Test("Work、Task、Agent 名称仅接受英文、中文和数字")
    func acceptsAllowedCharacters() {
        #expect(EntityNamePolicy.isValid("Work任务2026"))
        #expect(EntityNamePolicy.isValid("ABCxyz123"))
        #expect(EntityNamePolicy.isValid("纯中文名称"))
    }

    @Test("名称拒绝空白和标点符号", arguments: [
        "Two Words", "前后 空格", "name-with-dash", "name_with_underscore",
        "名称。", "名称/Task", "", "\n"
    ])
    func rejectsWhitespaceAndPunctuation(value: String) {
        #expect(!EntityNamePolicy.isValid(value))
    }
}
