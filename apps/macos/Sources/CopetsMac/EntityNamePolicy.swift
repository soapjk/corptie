import SwiftUI

enum EntityNamePolicy {
    private static let allowedPattern = #"^[A-Za-z0-9\p{Script=Han}]+$"#

    static func isValid(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        return value.range(of: allowedPattern, options: .regularExpression) != nil
    }

    @MainActor
    static var validationMessage: String {
        L10n("名称只能包含大小写英文字母、中文或数字，不能包含空格和标点符号。")
    }
}

struct EntityNameValidationMessage: View {
    let value: String

    var body: some View {
        if !value.isEmpty, !EntityNamePolicy.isValid(value) {
            Label(EntityNamePolicy.validationMessage, systemImage: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(EntityNamePolicy.validationMessage)
        }
    }
}
