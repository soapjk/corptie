import SwiftUI
import CorptieClientCore

enum EntityNamePolicy {
    static func isValid(_ value: String) -> Bool {
        EntityTitlePolicy.isValid(value)
    }

    @MainActor
    static var validationMessage: String {
        L10n(EntityTitlePolicy.guidance)
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
