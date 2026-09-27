import SwiftUI
import CorptieClientCore

/// The same declarative form on macOS and iPadOS. No Provider-specific UI.
public struct ConversationInputFields: View {
    let request: ConversationUserInput
    @Binding var selected: [String: Set<String>]
    @Binding var typed: [String: String]

    public init(request: ConversationUserInput, selected: Binding<[String: Set<String>]>, typed: Binding<[String: String]>) {
        self.request = request
        _selected = selected
        _typed = typed
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let value = request.url, let url = URL(string: value),
               ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                Link("打开网页 · \(url.host ?? "外部网站")", destination: url)
            }
            ForEach(request.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    if !question.header.isEmpty { Text(question.header).font(.caption).foregroundStyle(.secondary) }
                    Text(question.question).font(.body).fixedSize(horizontal: false, vertical: true)
                    if question.required == false { Text("可选").font(.caption).foregroundStyle(.secondary) }
                    if let options = question.options {
                        ForEach(options, id: \.label) { option in
                            Button {
                                var values = selected[question.id, default: []]
                                if values.contains(option.label) { values.remove(option.label) }
                                else if question.selectionMode == "single" { values = [option.label] }
                                else { values.insert(option.label) }
                                selected[question.id] = values
                                if question.selectionMode == "single" { typed[question.id] = "" }
                            } label: {
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: selected[question.id, default: []].contains(option.label)
                                          ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(Color.accentColor)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option.label)
                                        if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                                    }
                                    .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selected[question.id, default: []].contains(option.label) ? .isSelected : [])
                            .accessibilityIdentifier("user-input-option-\(question.id)-\(option.label)")
                        }
                    }
                    if question.options == nil || question.isOther {
                        if question.isSecret { SecureField("输入答案", text: binding(question)).textFieldStyle(.roundedBorder) }
                        else { TextField(question.options == nil ? "输入答案" : "其他答案", text: binding(question), axis: .vertical)
                            .lineLimit(1...4).textFieldStyle(.roundedBorder) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func binding(_ question: ConversationUserInput.Question) -> Binding<String> {
        Binding(get: { typed[question.id] ?? "" }, set: {
            typed[question.id] = $0
            if question.selectionMode == "single" && !$0.isEmpty { selected[question.id] = [] }
        })
    }
}
