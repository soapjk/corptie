import SwiftUI

/// Shared Detail rail content. Ownership, requests and navigation stay in the host.
public struct ConversationInspectorSection<Content: View>: View {
    private let title: String
    private let systemImage: String
    private let content: Content
    public init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title; self.systemImage = systemImage; self.content = content()
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            content
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

public struct ConversationTaskDefinition: View {
    private let values: [String]
    private let titles: [String]
    private let expandLabel: String
    private let collapseLabel: String
    public init(description: String, acceptance: String, verification: String,
                descriptionTitle: String = "描述", acceptanceTitle: String = "验收标准",
                verificationTitle: String = "验证标准", expandLabel: String = "展开", collapseLabel: String = "收起") {
        values = [description, acceptance, verification]
        titles = [descriptionTitle, acceptanceTitle, verificationTitle]
        self.expandLabel = expandLabel; self.collapseLabel = collapseLabel
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(values.indices, id: \.self) { index in
                if !values[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ConversationInspectorSection(title: titles[index],
                        systemImage: ["text.alignleft", "checklist", "checkmark.seal"][index]) {
                        ConversationDetailText(text: values[index], expandLabel: expandLabel, collapseLabel: collapseLabel)
                    }
                }
            }
        }
    }
}
