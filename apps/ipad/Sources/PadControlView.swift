import SwiftUI
import CorptieClientCore

struct PadControlView: View {
    let tab: PadTab
    let connection: PadConnection
    @Bindable var store: PadControlStore
    let settings: () -> Void
    let openSession: (String) -> Void
    private var selection: Binding<PadControlSelection?> {
        Binding(get: { store.routes[tab] }, set: { value in
            store.routes[tab] = value
            if let value { store.selections[value.kind] = value.id }
        })
    }
    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(tab.resources, id: \.self) { kind in
                    Section(kind == .skills ? "Skills" : tab.title) {
                        if let error = store.errors[kind] {
                            Text(error).font(.footnote).foregroundStyle(.secondary)
                        }
                        ForEach(store.items[kind] ?? []) { item in
                            NavigationLink(value: PadControlSelection(kind: kind, id: item.id)) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.name)
                                    if let status = item.status ?? item.availability {
                                        Text(PadControlPresentation.status(status)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        if store.loading.contains(kind) { ProgressView().accessibilityLabel("正在同步") }
                        else if store.items[kind]?.isEmpty == true, store.errors[kind] == nil {
                            Text("暂无内容").foregroundStyle(.secondary)
                        }
                        if store.cursors[kind] != nil {
                            Button("加载更多") { Task { await store.refresh(kind, connection: connection, more: true) } }
                                .disabled(store.loading.contains(kind))
                        }
                    }
                }
            }
            .navigationTitle(tab.title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("设置", systemImage: "gearshape") { settings() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("刷新", systemImage: "arrow.clockwise") {
                        Task { for kind in tab.resources { await store.refresh(kind, connection: connection) } }
                    }
                }
            }
        } detail: {
            if let route = selection.wrappedValue {
                if let item = store.items[route.kind]?.first(where: { $0.id == route.id }) {
                    detail(item, kind: route.kind)
                } else {
                    ContentUnavailableView("此项目已不在当前列表中", systemImage: "doc.questionmark")
                }
            } else {
                ContentUnavailableView("选择一个项目", systemImage: tab.symbol)
            }
        }
    }

    @ViewBuilder private func detail(_ item: ClientControlItem, kind: ClientControlKind) -> some View {
        if kind == .repositories {
            List {
                Section("Worktrees") {
                    if !store.repositoryError.isEmpty { Text(store.repositoryError).foregroundStyle(.secondary) }
                    if let detail = store.repository, detail.repository.id == item.id {
                        ForEach(detail.worktrees) { tree in
                            VStack(alignment: .leading, spacing: 6) {
                                Label(tree.branchName ?? "游离 HEAD", systemImage: tree.isMain ? "house" : "arrow.triangle.branch")
                                Text(PadControlPresentation.status(tree.state)).font(.caption).foregroundStyle(.secondary)
                                if tree.dirty == true { Text("有未提交修改").font(.caption) }
                                if let ahead = tree.aheadOfMain, let behind = tree.behindMain {
                                    Text("领先 \(ahead) · 落后 \(behind)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        if let job = detail.latestJob {
                            LabeledContent("最近合并计划", value: PadControlPresentation.status(job.status))
                        }
                    } else if store.repositoryError.isEmpty { ProgressView("读取分支状态") }
                }
                Section { Text("合并、冲突处理、删除和发布操作暂需在 Mac 上完成。外部 Git 修改可通过刷新同步。")
                    .font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
            .task(id: item.id) { await store.loadRepository(item.id, connection: connection) }
        } else {
            Form {
                if kind == .automations {
                    Section("计划任务") {
                        if let status = item.status { LabeledContent("状态", value: PadControlPresentation.status(status)) }
                        if let type = item.scheduleType { LabeledContent("触发方式", value: PadControlPresentation.status(type)) }
                        if let time = item.nextRunAt { LabeledContent("下次触发", value: PadControlPresentation.date(time)) }
                        if let time = item.expiresAt { LabeledContent("到期", value: PadControlPresentation.date(time)) }
                        if let status = item.lastRunStatus { LabeledContent("最近执行", value: PadControlPresentation.status(status)) }
                        if let id = item.sessionId { Button("进入目标会话") { openSession(id) } }
                    }
                }
                if let description = item.description, !description.isEmpty {
                    Section("描述") { Text(description).textSelection(.enabled) }
                }
                Section("信息") {
                    if let type = item.kind ?? item.sourceType { LabeledContent("类型", value: type) }
                    LabeledContent("ID", value: item.id).textSelection(.enabled)
                    if let date = item.updatedAt { LabeledContent("更新时间", value: PadControlPresentation.date(date)) }
                }
                Section { Text("此页当前支持浏览；编辑与管理操作暂需在 Mac 上完成。")
                    .font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
        }
    }
}

private enum PadControlPresentation {
    static func status(_ value: String) -> String {
        ["active": "等待触发", "paused": "已暂停", "cancelled": "已取消", "expired": "已过期",
         "completed": "已完成", "failed": "失败", "error": "错误", "running": "执行中", "queued": "已触发",
         "claimed": "正在启动", "succeeded": "成功", "available": "可用", "missing": "不可用",
         "once": "单次", "interval": "周期", "condition": "条件", "processExit": "进程退出"][value] ?? value
    }
    static func date(_ value: String) -> String {
        let date = try? Date(value, strategy: .iso8601)
        return date?.formatted(date: .abbreviated, time: .standard) ?? value
    }
}
