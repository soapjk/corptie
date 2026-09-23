import SwiftUI
import UIKit
import CorptieClientCore

/// Feature state and the single event subscription outlive individual Tab pages.
struct PadAppShell: View {
    @Environment(\.scenePhase) private var scenePhase
    let connection: PadConnection
    @State private var workspace = PadWorkspace()
    @State private var controls = PadControlStore()
    @State private var tab = PadTab.workspace
    @State private var sheet: Sheet?
    @State private var isKeyboardVisible = false
    private enum Sheet: String, Identifiable { case settings; var id: String { rawValue } }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                WorkspaceView(connection: connection, workspace: workspace, settings: { sheet = .settings })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(tab == .workspace ? 1 : 0)
                    .allowsHitTesting(tab == .workspace)
                ForEach([PadTab.automations, .worktrees, .agents]) { page in
                    PadControlView(tab: page, connection: connection, store: controls,
                        settings: { sheet = .settings }, openSession: { id in
                            workspace.selection = id
                            tab = .workspace
                        })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .opacity(tab == page ? 1 : 0)
                        .allowsHitTesting(tab == page)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !isKeyboardVisible {
                PadBottomTabBar(selection: $tab)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .ignoresSafeArea(.keyboard)
        .background {
            Color(uiColor: .systemGroupedBackground)
                .ignoresSafeArea()
        }
        .background { PadKeyboardDismissal().frame(width: 0, height: 0) }
        .ignoresSafeArea(.container, edges: .top)
        .sheet(item: $sheet) { _ in PadSettingsView(connection: connection, workspace: workspace) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = false }
        }
        .task { await workspace.inventory(connection) }
        .task(id: scenePhase == .active ? workspace.reconciliationKey(connection) : nil) {
            guard scenePhase == .active else { return }
            await workspace.reconcileAutomatically(connection)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { controls.pause(); return }
            controls.activate(tab, connection: connection)
            await workspace.runRealtime(connection)
        }
        .onChange(of: scenePhase) { if scenePhase != .active { controls.pause() } }
        .onChange(of: tab) { if scenePhase == .active { controls.activate(tab, connection: connection) } }
        .onChange(of: workspace.controlRevision) { controls.invalidate(connection) }
        .onDisappear { controls.pause() }
    }
}

private struct PadBottomTabBar: View {
    @Binding var selection: PadTab
    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 0) {
                ForEach(PadTab.allCases) { item in
                    Button {
                        selection = item
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: item.symbol)
                                .font(.system(size: 18, weight: selection == item ? .semibold : .regular))
                            Text(item.title)
                                .font(.system(size: 10, weight: selection == item ? .medium : .regular))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selection == item ? Color.accentColor : Color.secondary)
                    .accessibilityIdentifier("tab-\(item.rawValue)")
                }
            }
            .frame(height: 49)
        }
        .background {
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea(edges: .bottom)
        }
    }
}

private struct PadSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    let connection: PadConnection
    let workspace: PadWorkspace
    var body: some View {
        NavigationStack {
            Form {
                Section("连接的 Mac") {
                    LabeledContent("地址", value: connection.address)
                    LabeledContent("服务器", value: connection.serverID)
                    Text(workspace.liveStatus).foregroundStyle(.secondary)
                    Button("断开连接", role: .destructive) { connection.disconnect(); dismiss() }
                        .disabled(connection.busy)
                }
                Section("功能与版本") {
                    Text("连接获批后可浏览、发送和停止。/goal 等修改类命令与清空会话上下文，需要在 Mac 的设备接入设置中另外授权。")
                    Text("当前移动版：四页浏览、实时消息、发送与停止。自动化编辑、Git 操作与 Agent / Skill 编辑尚未接入。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
