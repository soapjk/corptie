import SwiftUI
import CorptieClientCore

/// The exact same content in Detail and Timeline; containers supply width and
/// commands, never independent fonts, markers or row styling.
public struct TaskExecutionChecklist: View {
    public let plan: ConversationExecutionPlan
    public let width: CGFloat
    public var canEdit: Bool
    public var isExpanded: Bool?
    public var onToggleExpansion: (() -> Void)?
    public var openAssignment: ((ConversationExecutionPlan.Assignment) -> Void)?
    public var submit: (ExecutionChecklistCommand) async throws -> Void
    @State private var showsAll = false
    @State private var editor: Editor?
    @State private var pendingRemoval: ConversationExecutionPlan.Step?
    @State private var busy = false
    @State private var error: String?

    private struct Editor: Identifiable {
        let id = UUID()
        let itemID: String?
        var text: String
        var condition: String
    }
    public init(plan: ConversationExecutionPlan, width: CGFloat, canEdit: Bool = true,
                isExpanded: Bool? = nil, onToggleExpansion: (() -> Void)? = nil, openAssignment: ((ConversationExecutionPlan.Assignment) -> Void)? = nil, submit: @escaping (ExecutionChecklistCommand) async throws -> Void) {
        self.plan = plan; self.width = width; self.canEdit = canEdit; self.submit = submit
        self.isExpanded = isExpanded; self.onToggleExpansion = onToggleExpansion; self.openAssignment = openAssignment
    }
    public static func columns(for width: CGFloat) -> Int { max(1, min(3, Int((width + 12) / 252))) }
    public static func previewHeight(plan: ConversationExecutionPlan, width: CGFloat) -> CGFloat {
        heights(plan: plan, width: width).collapsed
    }
    /// Prepare both extents when the plan/width changes, before a disclosure
    /// click. No text measurement or full-list rendering is needed to expand.
    public static func heights(plan: ConversationExecutionPlan, width: CGFloat) -> (collapsed: CGFloat, expanded: CGFloat) {
        let columns = columns(for: width)
        var full: CGFloat = 0, preview: CGFloat = 0, row = 0
        for first in stride(from: 0, to: plan.steps.count, by: columns) {
            var height: CGFloat = 20
            for index in first..<min(first + columns, plan.steps.count) {
                height = max(height, itemHeight(plan.steps[index]))
            }
            full += height + (row > 0 ? 4 : 0)
            if row < 2 { preview += height + (row > 0 ? 4 : 0) }
            row += 1
        }
        let chrome: CGFloat = 20 + 16 + 12 + (plan.closed != true && plan.steps.count > columns * 2 ? 24 : 0)
        if plan.closed == true { return (20, chrome + max(20, full)) }
        return (chrome + max(20, preview), chrome + max(20, full))
    }
    private static func itemHeight(_ item: ConversationExecutionPlan.Step) -> CGFloat {
        (item.reason?.isEmpty == false ? 34 : 20) + (item.assignment == nil ? 0 : 14)
    }
    private var isClosed: Bool { plan.closed == true }
    private var expanded: Bool { isExpanded ?? showsAll }
    private var columns: Int { Self.columns(for: width) }
    private var grid: [GridItem] { Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .topLeading), count: columns) }
    private var completed: Int { plan.completedCount ?? 0 }
    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Label(isClosed ? "执行清单 · 已关闭" : "执行清单", systemImage: "list.bullet.clipboard").font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 0)
                Text("已完成 \(completed)/\(plan.steps.count)").font(.system(size: 11)).foregroundStyle(.secondary)
                if isClosed {
                    Button(expanded ? "收起" : "查看") {
                        if let onToggleExpansion { onToggleExpansion() } else { showsAll.toggle() }
                    }.font(.system(size: 11))
                } else if canEdit {
                    Button { editor = Editor(itemID: nil, text: "", condition: "") } label: { Image(systemName: "plus") }
                        .help("添加事项").accessibilityLabel("添加事项")
                    Button { send(.init(action: "close", revision: plan.revision)) } label: {
                        Image(systemName: "xmark").frame(width: 18, height: 20).contentShape(Rectangle())
                    }
                    .help("关闭本批清单，不停止任务").accessibilityLabel("关闭本批清单")
                    .accessibilityIdentifier("task-execution-checklist.close")
                }
            }
            .frame(height: 20)
            if !isClosed || expanded {
                if plan.steps.isEmpty {
                    Text("暂无事项").font(.system(size: 12)).foregroundStyle(.secondary).frame(height: 20)
                } else {
                    LazyVGrid(columns: grid, alignment: .leading, spacing: 4) {
                        // Collapsed cards instantiate only their visible prefix;
                        // expansion reveals the remaining items inside this card.
                        ForEach(plan.steps.prefix(expanded ? plan.steps.count : columns * 2)) { item in itemRow(item) }
                    }
                }
                if !isClosed && plan.steps.count > columns * 2 {
                    Button(expanded ? "收起" : "展开全部 \(plan.steps.count) 项") {
                        if let onToggleExpansion { onToggleExpansion() } else { showsAll.toggle() }
                    }
                    .font(.system(size: 11)).frame(height: 18)
                    .accessibilityIdentifier("task-execution-checklist.disclosure")
                    .accessibilityValue(expanded ? "已展开" : "已收起")
                }
                HStack(spacing: 6) {
                    if let error {
                        Text("保存失败：\(error)").foregroundStyle(.red).help(error)
                    } else { Text(stateLabel).foregroundStyle(.secondary) }
                    if busy { Text("正在保存…").foregroundStyle(.secondary) }
                }.font(.system(size: 10)).lineLimit(1).frame(height: 16)
            }
        }
        .font(.system(size: 12))
        .buttonStyle(.plain)
        .disabled(busy)
        .sheet(item: $editor) { entry in
            ChecklistEditor(entryText: entry.text, entryCondition: entry.condition) { title, condition in
                send(.init(action: entry.itemID == nil ? "add" : "edit", revision: plan.revision,
                           itemID: entry.itemID, text: title, condition: condition))
                editor = nil
            }
        }
        .confirmationDialog("删除此事项？进行中的操作可能仍在执行。", isPresented: Binding(
            get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } })) {
            if let item = pendingRemoval {
                if item.assignment != nil {
                    Button("解除子任务关联") { send(.init(action: "unassign", revision: plan.revision, itemID: item.stepId)) }
                }
                Button("删除事项", role: .destructive) { send(.init(action: "remove", revision: plan.revision, itemID: item.stepId)); pendingRemoval = nil }
            }
            Button("取消", role: .cancel) { pendingRemoval = nil }
        }
        .accessibilityIdentifier("task-execution-checklist")
    }
    private var stateLabel: String {
        if isClosed { return "本批清单已关闭" }
        if !plan.steps.isEmpty && completed == plan.steps.count {
            return "清单已完成 · Task 验收独立进行"
        }
        return "事项进度"
    }
    private func itemRow(_ item: ConversationExecutionPlan.Step) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button {
                send(.init(action: "status", revision: plan.revision, itemID: item.stepId,
                           status: item.status == "completed" ? "pending" : "completed"))
            } label: {
                Text(Image(systemName: symbol(item.status))).font(.system(size: 12))
                    .foregroundStyle(item.status == "completed" ? Color.green : item.status == "blocked" ? .orange : .secondary)
                    .frame(width: 16, height: 20).contentShape(Rectangle())
            }
            .disabled(!canEdit || isClosed).accessibilityLabel(item.status == "completed" ? "撤销完成：\(item.text)" : "标记完成：\(item.text)")
            VStack(alignment: .leading, spacing: 2) {
                Text("\(item.ordinal + 1). \(item.text)")
                    .font(.system(size: 12)).lineLimit(1)
                    .foregroundStyle(item.status == "completed" ? .secondary : .primary)
                if let assignment = item.assignment {
                    Button {
                        openAssignment?(assignment)
                    } label: {
                        Text("↳ \(assignment.title ?? "子任务") · \(assignmentLabel(assignment.status))")
                            .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .disabled(assignment.taskId == nil || assignment.sessionId == nil || openAssignment == nil)
                    .help(assignment.reason ?? assignment.title ?? "子任务")
                }
                if let reason = item.reason, !reason.isEmpty {
                    Text(reason).font(.system(size: 10)).foregroundStyle(.orange).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(height: Self.itemHeight(item), alignment: .topLeading)
        .help([item.text, item.condition, item.reason].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n"))
        .contextMenu {
            if canEdit && !isClosed {
                Button("编辑事项（已完成项将撤销完成）") { editor = Editor(itemID: item.stepId, text: item.text, condition: item.condition ?? "") }
                if item.ordinal > 0 { Button("上移") { send(.init(action: "move", revision: plan.revision, itemID: item.stepId, position: item.ordinal - 1)) } }
                if item.ordinal + 1 < plan.steps.count { Button("下移") { send(.init(action: "move", revision: plan.revision, itemID: item.stepId, position: item.ordinal + 1)) } }
                if item.assignment != nil {
                    Button("解除子任务关联") { send(.init(action: "unassign", revision: plan.revision, itemID: item.stepId)) }
                }
                Button("删除事项", role: .destructive) { pendingRemoval = item }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(statusLabel(item.status))，\(item.text)\(item.reason.map { "，\($0)" } ?? "")")
    }
    private func assignmentLabel(_ status: String?) -> String {
        switch status {
        case "running", "processing", "in_progress": "执行中"
        case "completed", "complete": "本轮已结束"
        case "done": "任务已完成"
        case "failed": "执行失败"
        case "blocked": "等待条件"
        case "cancelled": "已取消"
        case "unknown": "状态待确认"
        case "unavailable": "不可用"
        case "preparing", "accepted", "waiting_workspace": "准备中"
        default: "待执行"
        }
    }
    private func symbol(_ status: String) -> String {
        switch status { case "completed": "checkmark.circle.fill"; case "inProgress": "record.circle"; case "blocked": "exclamationmark.circle"; default: "circle" }
    }
    private func statusLabel(_ status: String) -> String {
        switch status { case "completed": "已完成"; case "inProgress": "进行中"; case "blocked": "阻塞"; default: "待开始" }
    }
    private func send(_ command: ExecutionChecklistCommand) {
        guard !busy else { return }
        busy = true; error = nil
        Task {
            do { try await submit(command) } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

private struct ChecklistEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var entryText: String
    @State var entryCondition: String
    var save: (String, String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("清单事项").font(.headline)
            TextField("要做的事情", text: $entryText, axis: .vertical).lineLimit(2...4)
            TextField("完成条件（可选）", text: $entryCondition, axis: .vertical).lineLimit(2...4)
            HStack { Spacer(); Button("取消") { dismiss() }; Button("保存") { save(entryText, entryCondition) }
                .keyboardShortcut(.defaultAction).disabled(entryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || entryText.count > 2000 || entryCondition.count > 2000) }
        }.padding(20).frame(width: 360)
    }
}
