import Foundation

enum NewSessionModelSelection {
    static func preferredModelId(
        savedModelId: String?,
        providerDefaultModelId: String?,
        models: [CodexModel]
    ) -> String {
        let availableIds = Set(models.map(\.id))
        for candidate in [savedModelId, providerDefaultModelId] {
            guard let candidate = normalized(candidate) else {
                continue
            }
            if availableIds.isEmpty || availableIds.contains(candidate) {
                return candidate
            }
        }
        return models.first?.id ?? ""
    }

    static func preferredReasoningLevel(
        savedReasoningLevel: String?,
        providerDefaultReasoningLevel: String?,
        model: CodexModel?
    ) -> String {
        let supported = model?.reasoningLevels?
            .compactMap(normalized)
            .map { $0.lowercased() } ?? []
        let candidates = [
            normalized(savedReasoningLevel)?.lowercased(),
            normalized(providerDefaultReasoningLevel)?.lowercased(),
            normalized(model?.defaultReasoningLevel)?.lowercased()
        ]

        for candidate in candidates.compactMap({ $0 }) {
            if supported.isEmpty || supported.contains(candidate) {
                return candidate
            }
        }
        if supported.contains("medium") {
            return "medium"
        }
        return supported.first ?? ""
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
