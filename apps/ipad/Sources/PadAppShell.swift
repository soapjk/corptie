import SwiftUI
import UIKit
import CorptieClientCore

/// Feature state and the single event subscription outlive individual navigation pages.
struct PadAppShell: View {
    @Environment(\.scenePhase) private var scenePhase
    let connection: PadConnection
    @State private var workspace = PadWorkspace()
    @State private var controls = PadControlStore()
    @State private var tab = PadTab.workspace
    @State private var sheet: Sheet?
    @State private var isKeyboardVisible = false
    @AppStorage("corptie.mobile.navigationRailExpanded") private var navigationRailExpanded = true
    private enum Sheet: String, Identifiable { case settings; var id: String { rawValue } }

    private var usesNavigationRail: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    var body: some View {
        HStack(spacing: 0) {
            if usesNavigationRail {
                PadNavigationRail(
                    selection: $tab,
                    isExpanded: $navigationRailExpanded,
                    settings: { sheet = .settings }
                )
                .frame(width: navigationRailExpanded ? 200 : 64)
            }

            ZStack {
                WorkspaceView(connection: connection, workspace: workspace)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(tab == .workspace ? 1 : 0)
                    .allowsHitTesting(tab == .workspace)
                    .accessibilityHidden(tab != .workspace)
                ForEach([PadTab.automations, .worktrees, .agents]) { page in
                    PadControlView(tab: page, connection: connection, store: controls, openSession: { id in
                        workspace.selection = id
                        tab = .workspace
                    })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(tab == page ? 1 : 0)
                    .allowsHitTesting(tab == page)
                    .accessibilityHidden(tab != page)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !usesNavigationRail, !isKeyboardVisible {
                PadBottomTabBar(selection: $tab, settings: { sheet = .settings })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background {
            Color(uiColor: .systemGroupedBackground)
                .ignoresSafeArea()
        }
        .background { PadKeyboardDismissal().frame(width: 0, height: 0) }
        .sheet(item: $sheet) { _ in PadSettingsView(connection: connection, workspace: workspace) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            guard !usesNavigationRail else { return }
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            guard !usesNavigationRail else { return }
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = false }
        }
        .task(id: scenePhase == .active ? workspace.reconciliationKey(connection) : nil) {
            guard scenePhase == .active else { return }
            await workspace.reconcileAutomatically(connection)
        }
        // One foreground scene owns one resident event stream. Selecting a
        // Task only changes the local timeline projection; it must never tear
        // down the connection and request another bootstrap snapshot.
        .task(id: scenePhase) {
            guard scenePhase == .active else { controls.pause(); return }
            controls.activate(tab, connection: connection)
            await workspace.runRealtime(connection)
        }
        .onChange(of: scenePhase) { if scenePhase != .active { controls.pause() } }
        .onChange(of: tab) { if scenePhase == .active { controls.activate(tab, connection: connection) } }
        .onChange(of: workspace.controlRevision) {
            if let snapshot = workspace.directControlSnapshot { controls.apply(snapshot) }
            else { controls.invalidate(connection) }
        }
        .onDisappear { controls.pause() }
    }
}

private struct PadNavigationRail: View {
    @Binding var selection: PadTab
    @Binding var isExpanded: Bool
    let settings: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            ForEach(PadTab.allCases) { item in
                let isSelected = selection == item
                Button {
                    selection = item
                } label: {
                    railLabel(symbol: item.symbol, title: item.title, selected: isSelected)
                }
                .buttonStyle(.plain)
                .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                .background(isSelected ? Color.accentColor.opacity(0.10) : Color.clear)
                .help(item.title)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
                .accessibilityIdentifier("tab-\(item.rawValue)")
            }

            Spacer(minLength: 12)
            Divider().padding(.horizontal, 8)

            Button(action: settings) {
                railLabel(symbol: "gearshape", title: "设置")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("设置")
            .accessibilityLabel("设置")
            .accessibilityIdentifier("navigation-settings")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .frame(maxHeight: .infinity)
        .background {
            Color(uiColor: .systemGroupedBackground)
                .ignoresSafeArea(edges: [.top, .bottom, .leading])
        }
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(width: 0.5)
                .ignoresSafeArea(edges: [.top, .bottom])
                .allowsHitTesting(false)
        }
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color.clear)
                .frame(width: 24)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 8)
                        .onEnded { value in
                            let translation = value.translation.width
                            let predicted = value.predictedEndTranslation.width
                            let distance = abs(predicted) > abs(translation) ? predicted : translation
                            if distance <= -32 {
                                isExpanded = false
                            } else if distance >= 32 {
                                isExpanded = true
                            }
                        }
                )
                .accessibilityElement()
                .accessibilityLabel("调整导航栏宽度")
                .accessibilityValue(isExpanded ? "已展开" : "已折叠")
                .accessibilityHint("向左拖动收起，向右拖动展开")
                .accessibilityAction(named: isExpanded ? "收起导航" : "展开导航") {
                    isExpanded.toggle()
                }
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: isExpanded = true
                    case .decrement: isExpanded = false
                    @unknown default: break
                    }
                }
                .accessibilityIdentifier("navigation-rail-resizer")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("navigation-rail")
    }

    private func railLabel(symbol: String, title: String, selected: Bool = false) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: selected ? .semibold : .medium))
                .frame(width: 40, height: 40)
            if isExpanded {
                Text(title)
                    .font(.system(size: 15, weight: selected ? .semibold : .medium))
                    .lineLimit(1)
                Spacer(minLength: 4)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct PadBottomTabBar: View {
    @Binding var selection: PadTab
    let settings: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 0) {
                ForEach(PadTab.allCases) { item in
                    let isSelected = selection == item
                    Button {
                        selection = item
                    } label: {
                        compactLabel(symbol: item.symbol, title: item.title, selected: isSelected)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .accessibilityLabel(item.title)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityIdentifier("tab-\(item.rawValue)")
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
            .frame(maxWidth: 360)
            .padGlassSurface(in: Capsule(), interactive: true)

            Button(action: settings) {
                Image(systemName: "gearshape")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 50, height: 50)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padGlassSurface(in: Circle(), interactive: true)
            .accessibilityLabel("设置")
            .accessibilityIdentifier("navigation-settings")
        }
        .frame(maxWidth: 430)
    }

    private func compactLabel(symbol: String, title: String, selected: Bool = false) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: selected ? .semibold : .regular))
            Text(title)
                .font(.system(size: 10, weight: selected ? .semibold : .regular))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, minHeight: 50)
        .contentShape(Rectangle())
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
