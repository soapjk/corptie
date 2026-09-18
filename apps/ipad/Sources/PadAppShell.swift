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
    private enum Sheet: String, Identifiable { case settings; var id: String { rawValue } }

    var body: some View {
        TabView(selection: $tab) {
            WorkspaceView(connection: connection, workspace: workspace, settings: { sheet = .settings })
                .tag(PadTab.workspace)
                .tabItem { Label(PadTab.workspace.title, systemImage: PadTab.workspace.symbol) }
                .toolbar(.hidden, for: .tabBar)
            ForEach([PadTab.automations, .worktrees, .agents]) { page in
                PadControlView(tab: page, connection: connection, store: controls,
                    settings: { sheet = .settings }, openSession: { id in
                        workspace.selection = id
                        tab = .workspace
                    })
                    .tag(page)
                    .tabItem { Label(page.title, systemImage: page.symbol) }
                    .toolbar(.hidden, for: .tabBar)
            }
        }
        // iPadOS places TabView's standard bar at the top. Use the public native
        // UITabBar as the bottom selector, without falsifying content size classes.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            PadBottomTabBar(selection: $tab).frame(height: 49).background(.bar)
        }
        .sheet(item: $sheet) { _ in PadSettingsView(connection: connection, workspace: workspace) }
        .task { await workspace.inventory(connection) }
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

private struct PadBottomTabBar: UIViewRepresentable {
    @Binding var selection: PadTab
    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }
    func makeUIView(context: Context) -> UITabBar {
        let bar = UITabBar()
        bar.items = PadTab.allCases.map { UITabBarItem(title: $0.title, image: UIImage(systemName: $0.symbol), tag: $0.rawValue) }
        bar.itemPositioning = .fill
        bar.delegate = context.coordinator
        return bar
    }
    func updateUIView(_ bar: UITabBar, context: Context) {
        context.coordinator.selection = $selection
        bar.selectedItem = bar.items?.first { $0.tag == selection.rawValue }
    }
    final class Coordinator: NSObject, UITabBarDelegate {
        var selection: Binding<PadTab>
        init(selection: Binding<PadTab>) { self.selection = selection }
        func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
            if let tab = PadTab(rawValue: item.tag) { selection.wrappedValue = tab }
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
                    Text("连接获批后，移动端当前支持的功能会直接可用，无需再次设置权限。")
                    Text("当前移动版：四页浏览、实时消息、发送与停止。自动化编辑、Git 操作与 Agent / Skill 编辑尚未接入。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
