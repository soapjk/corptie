import SwiftUI
import CorptieClientCore
import CorptieConversation

struct CorptieTaskAcceptanceReviewView: View {
    let task: CorptieTask
    let isRejecting: Bool
    let rejectionError: String?
    let onClose: () -> Void
    let onReject: () -> Void

    private var results: [CorptieTaskAcceptanceResult] {
        task.completionSuggestion?.results ?? task.acceptanceAssessment?.results ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(L10n("自动验收结论详情"))
                    .font(.headline)

                HStack {
                    Button(action: onClose) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L10n("关闭"))
                    .disabled(isRejecting)
                    Spacer()
                }
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(task.title)
                        .font(.system(size: 13, weight: .semibold))
                    if results.isEmpty {
                        ContentUnavailableView(
                            L10n("暂无自动验收结论详情"),
                            systemImage: "doc.text.magnifyingglass"
                        )
                        .frame(maxWidth: .infinity, minHeight: 150)
                    } else {
                        ForEach(Array(results.enumerated()), id: \.offset) { index, result in
                            acceptanceResult(result, index: index)
                        }
                    }
                    if let rejectionError {
                        Label(rejectionError, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }

            Divider()

            HStack {
                Spacer()
                Button(role: .destructive, action: onReject) {
                    if isRejecting {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(L10n("取消验收通过"))
                        }
                    } else {
                        Text(L10n("取消验收通过"))
                    }
                }
                .disabled(isRejecting)
            }
            .padding(16)
        }
        .frame(width: 480, height: 430)
        .interactiveDismissDisabled(isRejecting)
    }

    private func acceptanceResult(_ result: CorptieTaskAcceptanceResult, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(index + 1). \(result.criterion)")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(result.verdict == "passed" ? L10n("已通过") : L10n("未通过"))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(result.verdict == "passed" ? Color.green : Color.red)
            }
            ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, evidence in
                VStack(alignment: .leading, spacing: 3) {
                    Text("• \(evidence.summary)")
                        .font(.system(size: 11))
                    Text(evidence.reference)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct CorptieTaskCompletionConfirmationView: View {
    let task: CorptieTask
    let assessment: CorptieTaskAcceptanceAssessment?
    let suggestion: CorptieTaskCompletionSuggestion?
    let onConfirm: () -> Void
    let onCancel: () -> Void

    private var acceptance: CorptieTaskAutomaticAcceptancePresentation {
        .resolve(assessment: assessment, suggestion: suggestion)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n("确认完成"))
                    .font(.title3.weight(.semibold))
                Text(task.title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(task.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch acceptance.state {
                    case .passed:
                        Label(
                            L10n("自动验收：已通过"),
                            systemImage: "checkmark.seal.fill"
                        )
                        .foregroundStyle(.green)
                    case .notPassed:
                        Label(
                            L10n("自动验收：未通过"),
                            systemImage: "xmark.seal.fill"
                        )
                        .foregroundStyle(.orange)
                    case .notAssessed:
                        Label(
                            L10n("自动验收：尚未验收"),
                            systemImage: "questionmark.circle.fill"
                        )
                        .foregroundStyle(.secondary)
                    }

                    Text(L10n("无论自动验收结果如何，你都可以将此 CorptieTask 标记为完成。"))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 10) {
                        Text(L10n("自动验收结论详情"))
                            .font(.system(size: 11, weight: .semibold))

                        if acceptance.results.isEmpty {
                            ContentUnavailableView(
                                L10n("暂无自动验收结论详情"),
                                systemImage: "doc.text.magnifyingglass"
                            )
                            .frame(maxWidth: .infinity, minHeight: 120)
                        } else {
                            ForEach(Array(acceptance.results.enumerated()), id: \.offset) { index, result in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text("\(index + 1). \(result.criterion)")
                                            .font(.system(size: 12, weight: .semibold))
                                        Spacer()
                                        Text(acceptanceVerdictLabel(result.verdict))
                                            .font(.system(size: 10, weight: .semibold))
                                            .foregroundStyle(acceptanceVerdictColor(result.verdict))
                                    }
                                    .textSelection(.enabled)
                                    if result.evidence.isEmpty {
                                        Text(L10n("该结论暂无证据详情"))
                                            .font(.system(size: 11))
                                            .foregroundStyle(.tertiary)
                                    } else {
                                        ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, evidence in
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text("• \(evidence.summary)")
                                                    .font(.system(size: 11))
                                                Text(evidence.reference)
                                                    .font(.system(size: 10, design: .monospaced))
                                                    .foregroundStyle(.secondary)
                                            }
                                            .textSelection(.enabled)
                                        }
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }

            Divider()

            HStack(spacing: 10) {
                Spacer()
                Button(L10n("取消"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("标记为完成"), action: onConfirm)
                .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 520, height: 480)
    }

    private func acceptanceVerdictLabel(_ verdict: String) -> String {
        switch verdict {
        case "passed": L10n("已通过")
        case "failed": L10n("未通过")
        default: L10n("未知")
        }
    }

    private func acceptanceVerdictColor(_ verdict: String) -> Color {
        switch verdict {
        case "passed": .green
        case "failed": .red
        default: .secondary
        }
    }
}

// MARK: - 工作项编辑（弹出小窗）
