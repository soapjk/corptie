import SwiftUI
import CorptieClientCore

public enum ConversationInputAnswerPresentation {
    public static func textAnswers(for question: ConversationUserInput.Question,
                                   submittedAnswers: [String: [String]]?) -> [String] {
        let declared = Set(question.options?.map(\.label) ?? [])
        return (submittedAnswers?[question.id] ?? []).filter { !declared.contains($0) }
    }
}

/// The same declarative form on macOS and iPadOS. No Provider-specific UI.
public struct ConversationInputFields: View {
    let request: ConversationUserInput
    @Binding var selected: [String: Set<String>]
    @Binding var typed: [String: String]
    let readOnly: Bool
    let showsSubmittedText: Bool
    let submittedAnswers: [String: [String]]?
    let onOptionSelected: ((String, String) -> Void)?

    public init(request: ConversationUserInput, selected: Binding<[String: Set<String>]>,
                typed: Binding<[String: String]>, readOnly: Bool = false,
                showsSubmittedText: Bool = true,
                submittedAnswers: [String: [String]]? = nil,
                onOptionSelected: ((String, String) -> Void)? = nil) {
        self.request = request
        _selected = selected
        _typed = typed
        self.readOnly = readOnly
        self.showsSubmittedText = showsSubmittedText
        self.submittedAnswers = submittedAnswers
        self.onOptionSelected = onOptionSelected
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
                            if readOnly {
                                optionContent(option, question: question)
                                    .accessibilityElement(children: .combine)
                                    .accessibilityValue(isSelected(option.label, question: question) ? "已选择" : "未选择")
                            } else {
                                Button {
                                    var values = selected[question.id, default: []]
                                    if values.contains(option.label) { values.remove(option.label) }
                                    else if question.selectionMode == "single" { values = [option.label] }
                                    else { values.insert(option.label) }
                                    selected[question.id] = values
                                    if question.selectionMode == "single" { typed[question.id] = "" }
                                    onOptionSelected?(question.id, option.label)
                                } label: {
                                    optionContent(option, question: question)
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(isSelected(option.label, question: question) ? .isSelected : [])
                                .accessibilityValue(isSelected(option.label, question: question) ? "已选择" : "未选择")
                                .accessibilityIdentifier("user-input-option-\(question.id)-\(option.label)")
                            }
                        }
                    }
                    if question.options == nil || question.isOther {
                        if readOnly {
                            if showsSubmittedText {
                                let entered = ConversationInputAnswerPresentation.textAnswers(
                                    for: question, submittedAnswers: submittedAnswers)
                                if entered.isEmpty {
                                    Text(submittedAnswers == nil ? "旧记录未保留文本答案" : "未填写其他答案")
                                        .font(.caption).foregroundStyle(.secondary)
                                } else {
                                    ForEach(Array(entered.enumerated()), id: \.offset) { entry in
                                        Text(entry.element).font(.callout)
                                            .fixedSize(horizontal: false, vertical: true)
                                            .textSelection(.enabled)
                                    }
                                }
                            }
                        } else {
                            TextField(question.options == nil ? "输入答案" : "其他答案", text: binding(question), axis: .vertical)
                                .lineLimit(1...4).textFieldStyle(.roundedBorder)
                                .accessibilityLabel(question.question)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func isSelected(_ label: String, question: ConversationUserInput.Question) -> Bool {
        selected[question.id, default: []].contains(label)
    }

    private func optionContent(_ option: ConversationUserInput.Option,
                               question: ConversationUserInput.Question) -> some View {
        let selected = isSelected(option.label, question: question)
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label).fontWeight(selected ? .semibold : .regular)
                if !option.description.isEmpty {
                    Text(option.description).font(.caption).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.09) : Color.primary.opacity(0.025),
                    in: RoundedRectangle(cornerRadius: 9))
        .overlay {
            RoundedRectangle(cornerRadius: 9)
                .strokeBorder(selected ? Color.accentColor.opacity(0.35) : Color.primary.opacity(0.10), lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 9))
    }

    private func binding(_ question: ConversationUserInput.Question) -> Binding<String> {
        Binding(get: { typed[question.id] ?? "" }, set: {
            typed[question.id] = $0
            if question.selectionMode == "single" && !$0.isEmpty { selected[question.id] = [] }
        })
    }
}
