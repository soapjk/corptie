import SwiftUI

// 四级审批卡（03 §15.3，净新增组件）。
// 出现在：Session 下钻详情页（07 视图树 SessionExecutionView → ApprovalCard）
//         与浮球展开层（03 §17.3.4，复用 DetachedCollaborationConfirmationCard 骨架）。
//
// 卡结构五要素：RiskLevelBadge + ProposalSummary + AffectedScope + RationaleText + SourceLine。
// 底部三级操作：确认继续 / 驳回重规划 / 编辑改参；dangerous 另加二次确认（键入短语）。

// MARK: - 等级徽标

struct RiskLevelBadge: View {
    let level: RiskLevel

    var body: some View {
        HStack(spacing: 4) {
            if level.showsWarningIcon {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            Text(level.title)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(level.color.opacity(0.15), in: Capsule())
        .foregroundStyle(level.color)
    }
}

// MARK: - 审批卡

struct ApprovalCard: View {
    let request: ApprovalRequest
    let onApprove: () -> Void
    let onReject: () -> Void
    let onEdit: (String) -> Void

    @State private var typedPhrase = ""
    @State private var isEditing = false
    @State private var editFeedback = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            proposal
            affectedScope
            rationale
            sourceLine

            Divider()

            editField

            actionBar
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(riskBorderColor, lineWidth: 1)
        )
    }

    private var riskBorderColor: Color {
        switch request.riskLevel {
        case .high: .orange.opacity(0.5)
        case .dangerous: .red.opacity(0.6)
        default: Color.primary.opacity(0.12)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            RiskLevelBadge(level: request.riskLevel)
            Text(request.action)
                .font(.headline)
                .monospaced()
                .textSelection(.enabled)
        }
    }

    private var proposal: some View {
        Text(request.proposal)
            .font(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var affectedScope: some View {
        if !request.affectedScope.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("影响范围")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(request.affectedScope, id: \.self) { scope in
                    Label(scope, systemImage: "doc.text")
                        .font(.callout)
                        .textSelection(.enabled)
                }
            }
        }
    }

    @ViewBuilder
    private var rationale: some View {
        if !request.rationale.isEmpty {
            Text(request.rationale)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var sourceLine: some View {
        Text(request.sourceLine)
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private var editField: some View {
        if isEditing {
            TextField("补充约束或修改参数", text: $editFeedback)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 8) {
            Button(role: .cancel) {
                onReject()
            } label: {
                Text("驳回重规划")
            }

            Button {
                isEditing.toggle()
            } label: {
                Text("编辑改参")
            }

            Spacer()

            approveControl
        }
    }

    @ViewBuilder
    private var approveControl: some View {
        if request.requiresSecondaryConfirm {
            VStack(alignment: .trailing, spacing: 6) {
                TextField("输入「\(request.confirmPhrase ?? "")」以确认", text: $typedPhrase)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
                Button {
                    onApprove()
                } label: {
                    Text("我已知风险，仍要执行")
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(typedPhrase.trimmingCharacters(in: .whitespacesAndNewlines) != (request.confirmPhrase ?? ""))
            }
        } else {
            Button {
                onApprove()
            } label: {
                Text("确认继续")
            }
            .buttonStyle(.borderedProminent)
        }
    }
}

// MARK: - 演示视图（用于预览 / 验证两种弹卡形态）

struct ApprovalCardDemoView: View {
    @State private var decisions: [String: String] = [:]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("审批卡演示")
                    .font(.title.bold())

                ForEach(Self.demoRequests) { request in
                    VStack(alignment: .leading, spacing: 8) {
                        ApprovalCard(
                            request: request,
                            onApprove: { decisions[request.id] = "已批准" },
                            onReject: { decisions[request.id] = "已驳回" },
                            onEdit: { _ in decisions[request.id] = "已编辑" }
                        )
                        if let decision = decisions[request.id] {
                            Text(decision)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding()
        }
        .frame(width: 460, height: 720)
    }

    static let demoRequests: [ApprovalRequest] = [
        ApprovalRequest(
            id: "high-git-push",
            action: "git push origin main",
            proposal: "把当前分支的提交推送到远程 main 分支。",
            riskLevel: .high,
            affectedScope: ["仓库 corptie / refs/heads/main", "远程 origin"],
            rationale: "推送会改变远程共享状态，其他协作者将看到这些提交。",
            sourceLine: "Agent 独立贡献者「backend-dev」· Session#42",
            requiresSecondaryConfirm: false,
            confirmPhrase: nil
        ),
        ApprovalRequest(
            id: "dangerous-rm",
            action: "rm -rf build/ node_modules/",
            proposal: "清理构建产物与依赖目录，以彻底重建。",
            riskLevel: .dangerous,
            affectedScope: ["build/（约 1.2 GB）", "node_modules/（约 480 MB）"],
            rationale: "删除不可恢复；依赖需重新安装，构建需重跑。",
            sourceLine: "Agent 独立贡献者「ops」· Session#57",
            requiresSecondaryConfirm: true,
            confirmPhrase: "删除不可恢复"
        )
    ]
}
