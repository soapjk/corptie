import SwiftUI
import CorptieClientCore

struct PadControlView: View {
    let tab: PadTab
    let connection: PadConnection
    @Bindable var store: PadControlStore
    let openSession: (String) -> Void
    @State private var preferredCompactColumn = NavigationSplitViewColumn.sidebar
    private var selection: Binding<PadControlSelection?> {
        Binding(get: { store.routes[tab] }, set: { value in
            store.routes[tab] = value
            if let value { store.selections[value.kind] = value.id }
        })
    }
    var body: some View {
        NavigationSplitView(preferredCompactColumn: $preferredCompactColumn) {
            ScrollViewReader { proxy in
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
                            .id(PadControlSelection(kind: kind, id: item.id))
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
            .onChange(of: selection.wrappedValue, initial: true) { _, route in
                if let route { proxy.scrollTo(route, anchor: .center) }
            }
            .onChange(of: store.automationNavigationRevision) { _, _ in
                if tab == .automations, let route = selection.wrappedValue {
                    proxy.scrollTo(route, anchor: .center)
                }
            }
            .onChange(of: tab.resources.flatMap { store.items[$0] ?? [] }.map(\.id)) { _, _ in
                if let route = selection.wrappedValue { proxy.scrollTo(route, anchor: .center) }
            }
            .navigationTitle(tab.title)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("刷新", systemImage: "arrow.clockwise") {
                        Task { for kind in tab.resources { await store.refresh(kind, connection: connection) } }
                    }
                }
            }
            }
        } detail: {
            if let route = selection.wrappedValue {
                if let item = store.items[route.kind]?.first(where: { $0.id == route.id }) {
                    detail(item, kind: route.kind)
                } else if store.items[route.kind] == nil || store.loading.contains(route.kind) {
                    ProgressView("正在同步…")
                } else {
                    ContentUnavailableView("此项目已不在当前列表中", systemImage: "doc.questionmark")
                }
            } else {
                ContentUnavailableView("选择一个项目", systemImage: tab.symbol)
            }
        }
        .onChange(of: selection.wrappedValue, initial: true) { _, route in
            preferredCompactColumn = route == nil ? .sidebar : .detail
        }
        .onChange(of: store.automationNavigationRevision) { _, _ in
            // Reopening the same task must also leave the compact sidebar.
            if tab == .automations { preferredCompactColumn = .detail }
        }
    }

    @ViewBuilder private func detail(_ item: ClientControlItem, kind: ClientControlKind) -> some View {
        if kind == .repositories {
            PadWorktreeManagementView(repository: item, connection: connection,
                                      manager: store.worktrees, openSession: openSession)
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
