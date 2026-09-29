import SwiftUI
import CorptieClientCore

public enum ConversationUserInputInteractionPolicy {
    /// A single declared choice is a complete answer; composite forms need a submit action.
    public static func directSelectionQuestionID(_ request: ConversationUserInput) -> String? {
        guard request.questions.count == 1, let question = request.questions.first,
              question.options != nil, question.selectionMode != "multiple", !question.isOther else { return nil }
        return question.id
    }
}

/// One inline form for both timelines. Accepted answers remain visible in the card.
public struct ConversationInlineUserInput: View {
    public let request: ConversationUserInput
    public let status: String?
    public let respond: ([String: [String]], String) async throws -> Void
    public let afterSubmit: () async -> Void

    @State private var selected: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var submittedOptions: [String: Set<String>] = [:]
    @State private var submittedAnswersLocally: [String: [String]] = [:]
    @State private var submitting = false
    @State private var submittedLocally = false
    @State private var cancelledLocally = false
    @State private var errorText: String?

    public init(request: ConversationUserInput, status: String?,
                respond: @escaping ([String: [String]], String) async throws -> Void,
                afterSubmit: @escaping () async -> Void = {}) {
        self.request = request
        self.status = status
        self.respond = respond
        self.afterSubmit = afterSubmit
    }

    private var isPending: Bool { status == "pending" && !submittedLocally }
    private var directSelectionQuestionID: String? {
        ConversationUserInputInteractionPolicy.directSelectionQuestionID(request)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("需要你的输入", systemImage: "questionmark.bubble")
                .font(.headline)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            if isPending {
                ConversationInputFields(request: request, selected: $selected, typed: $typed,
                                        onOptionSelected: selectOption)
                    .disabled(submitting)
                if directSelectionQuestionID == nil {
                    Button("提交答案") { Task { await submit() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(submitting || request.answers(selected: selected, typed: typed) == nil)
                        .accessibilityIdentifier("user-input-submit")
                }
                if request.canCancel == true {
                    Button("取消请求", role: .cancel) { Task { await submit(cancelling: true) } }
                        .disabled(submitting)
                }
            } else {
                ConversationInputFields(request: request,
                                        selected: .constant(displayedSelection), typed: .constant([:]),
                                        readOnly: true,
                                        showsSubmittedText: (submittedLocally && !cancelledLocally) || status == "submitted",
                                        submittedAnswers: displayedAnswers)
                Text(statusText).font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if submitting { ProgressView("正在提交…").controlSize(.small) }
            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-user-input")
    }

    private var displayedSelection: [String: Set<String>] {
        if let authoritative = request.selectedOptions {
            return authoritative.mapValues(Set.init)
        }
        return submittedOptions.isEmpty ? selected : submittedOptions
    }

    private var displayedAnswers: [String: [String]]? {
        request.submittedAnswers ?? (submittedLocally && !cancelledLocally ? submittedAnswersLocally : nil)
    }

    private var statusText: String {
        if cancelledLocally || status == "cancelled" { return "已取消请求" }
        if submittedLocally || status == "submitted" { return "已提交，答案已显示" }
        switch status {
        case "dispatching": return "正在提交，等待确认"
        case "unknown": return "提交结果待同步，请勿重复提交"
        case "expired": return "此问题已失效"
        default: return "此问题暂时无法回答"
        }
    }

    private func selectOption(_ questionID: String, _ label: String) {
        guard directSelectionQuestionID == questionID, !submitting else { return }
        selected[questionID] = [label]
        Task { await submit(answersOverride: [questionID: [label]]) }
    }

    private func submit(cancelling: Bool = false, answersOverride: [String: [String]]? = nil) async {
        guard !submitting, isPending,
              let answers = cancelling ? [:] : (answersOverride ?? request.answers(selected: selected, typed: typed)) else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            try await respond(answers, cancelling ? "cancel" : "submit")
            submittedOptions = request.questions.reduce(into: [:]) { result, question in
                guard let options = question.options else { return }
                let allowed = Set(options.map(\.label))
                result[question.id] = Set((answers[question.id] ?? []).filter(allowed.contains))
            }
            submittedAnswersLocally = cancelling ? [:] : answers
            submittedLocally = true
            cancelledLocally = cancelling
            await afterSubmit()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
