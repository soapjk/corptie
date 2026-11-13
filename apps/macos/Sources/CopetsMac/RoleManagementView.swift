import AppKit
import CorptieConversation
import SwiftUI

enum RolesSkillsLayoutMode: Equatable {
    case split
    case compact
}

enum RolesSkillsLayoutMetrics {
    static let skillsColumnWidth: CGFloat = 300
    static let headerHeight: CGFloat = 60
    static let columnPadding: CGFloat = 16
    static let minimumAgentsColumnWidth: CGFloat = 568
    static let dividerWidth: CGFloat = 1

    static func mode(for availableWidth: CGFloat) -> RolesSkillsLayoutMode {
        availableWidth >= minimumAgentsColumnWidth + skillsColumnWidth + dividerWidth
            ? .split : .compact
    }

    static func showsInlineSkills(
        width: CGFloat, sidebarVisible: Bool, preference: Bool, sheetPresented: Bool
    ) -> Bool {
        mode(for: width) == .split && sidebarVisible && preference && !sheetPresented
    }

    static func gridColumnCount(for width: CGFloat) -> Int {
        guard width.isFinite else { return 1 }
        return max(1, Int(floor(max(0, width - 16) / 276)))
    }

    static func sheetSize(in availableSize: CGSize, ideal: CGSize) -> CGSize {
        CGSize(
            width: max(1, min(ideal.width, availableSize.width - 32)),
            height: max(1, min(ideal.height, availableSize.height - 48)))
    }
}

/// Page-owned column shell: paint reaches the window edges while controls
/// reserve the same title-bar space as the console. No content-sized wrapper,
/// material or extra scrolling container surrounds the existing pane contents.
struct RolePageColumns<Roles: View, Skills: View>: View {
    let showsSkills: Bool
    let topInset: CGFloat
    @ViewBuilder var roles: () -> Roles
    @ViewBuilder var skills: () -> Skills

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            roles()
                .padding(.top, topInset)
                .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(WorkbenchStyle.canvas)
            if showsSkills {
                Divider()
                skills()
                    .padding(.top, topInset)
                    .frame(width: RolesSkillsLayoutMetrics.skillsColumnWidth)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .background(WorkbenchStyle.sidebarColor)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(WorkbenchStyle.canvas)
    }
}

struct RoleManagementView: View {
    // The client performs existing commands; only the registry projection is observed.
    private let client = EntityAPIClient.shared
    @StateObject private var registry = RoleRegistryPresentation()
    @EnvironmentObject private var router: AppTabRouter
    @EnvironmentObject private var sidebarState: TabSidebarState
    @State private var isCreatingRole = false
    @State private var isRegisteringSkill = false
    @State private var isShowingSkillsSheet = false
    @AppStorage("ui.roles.showSkills", store: CorptieAppEnvironment.userDefaults) private
        var showsSkillsColumn = true
    @State private var isShowingMcpSheet = false
    @State private var selectedRoleForDetail: Role?
    @State private var roleForSessionCreation: Role?
    @State private var pendingSkillDeletion: SkillDeletionImpact?
    @State private var skillDeletionError: String?
    @State private var isDeletingSkill = false
    @State private var inspectingSkillID: String?
    @State private var roleQuery = ""
    @State private var skillQuery = ""
    @State private var roleSearchFocusRequest = 0
    @State private var skillSearchFocusRequest = 0
    @State private var returnRoleID: String?
    @FocusState private var focusedRoleID: String?
    @FocusState private var skillsButtonFocused: Bool

    private var hasModal: Bool {
        isCreatingRole || isShowingSkillsSheet || isShowingMcpSheet || isRegisteringSkill
            || selectedRoleForDetail != nil || roleForSessionCreation != nil
            || pendingSkillDeletion != nil || skillDeletionError != nil
    }

    var body: some View {
        GeometryReader { geometry in
            let inlineSkills = RolesSkillsLayoutMetrics.showsInlineSkills(
                width: geometry.size.width, sidebarVisible: sidebarState.isVisible,
                preference: showsSkillsColumn, sheetPresented: isShowingSkillsSheet
            )
            let roleWidth = geometry.size.width - (inlineSkills ? 301 : 0)
            let skillsSize = RolesSkillsLayoutMetrics.sheetSize(
                in: geometry.size, ideal: CGSize(width: 420, height: 680))
            let mcpSize = RolesSkillsLayoutMetrics.sheetSize(
                in: geometry.size, ideal: CGSize(width: 760, height: 620))

            RolePageColumns(
                showsSkills: inlineSkills,
                topInset: MainWindowLayoutMetrics.titlebarHeight
            ) {
                rolesColumn(
                    width: roleWidth, inlineSkills: inlineSkills,
                    canInlineSkills: RolesSkillsLayoutMetrics.mode(for: geometry.size.width)
                        == .split
                        && sidebarState.isVisible
                )
            } skills: {
                skillsColumn(isSheet: false)
            }
            .sheet(isPresented: $isShowingSkillsSheet, onDismiss: { skillsButtonFocused = true }) {
                skillsColumn(isSheet: true)
                    .frame(width: skillsSize.width, height: skillsSize.height)
            }
            .sheet(isPresented: $isShowingMcpSheet) {
                McpManagementView(roles: registry.roles, preferredSize: mcpSize)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(WorkbenchStyle.canvas.ignoresSafeArea(.container, edges: .vertical))
        .ignoresSafeArea(.container, edges: .top)
        .sheet(isPresented: $isCreatingRole) { RoleCreateView() }
        .sheet(item: $selectedRoleForDetail, onDismiss: restoreRoleFocus) { role in
            if let current = registry.roles.first(where: { $0.id == role.id }) {
                RoleDetailView(agent: current)
            } else {
                missingRoleView
            }
        }
        .sheet(item: $roleForSessionCreation, onDismiss: restoreRoleFocus) { role in
            if let current = registry.roles.first(where: { $0.id == role.id }) {
                NewSessionCreationSheet(fixedAgent: current) { session in
                    router.openSession(session.id, source: .createdSession)
                }
            } else {
                missingRoleView
            }
        }
        .alert(
            L10n("Delete Skill?"),
            isPresented: Binding(
                get: { pendingSkillDeletion != nil }, set: { if !$0 { pendingSkillDeletion = nil } }
            ), presenting: pendingSkillDeletion
        ) { impact in
            if SkillDeletionConfirmationPolicy.canOfferDestructiveAction(for: impact) {
                Button(L10n("Delete"), role: .destructive) {
                    Task { await confirmSkillDeletion(impact) }
                }
                .disabled(isDeletingSkill)
            }
            Button(impact.canDelete ? L10n("Cancel") : L10n("OK"), role: .cancel) {}
        } message: { impact in
            Text(skillDeletionConfirmationMessage(impact))
        }
        .alert(
            L10n("Unable to delete Skill"),
            isPresented: Binding(
                get: { skillDeletionError != nil }, set: { if !$0 { skillDeletionError = nil } }
            )
        ) {
            Button(L10n("OK"), role: .cancel) { skillDeletionError = nil }
        } message: {
            Text(skillDeletionError ?? "")
        }
        .background {
            Button(L10n("Search roles")) { roleSearchFocusRequest &+= 1 }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(!sidebarState.isSelected || hasModal)
                .hidden().frame(width: 0, height: 0).accessibilityHidden(true)
        }
        .task { await registry.refresh() }
    }

    private func rolesColumn(width: CGFloat, inlineSkills: Bool, canInlineSkills: Bool) -> some View
    {
        let matches = registry.matchingRoles(roleQuery)
        let columns = Array(
            repeating: GridItem(.flexible(minimum: 0), spacing: 16),
            count: RolesSkillsLayoutMetrics.gridColumnCount(for: width))
        return VStack(alignment: .leading, spacing: 0) {
            rolesHeader(width: width, inlineSkills: inlineSkills, canInlineSkills: canInlineSkills)
            Text(
                L10n(
                    "Roles define reusable instructions and skills. Sessions run through execution engines."
                )
            )
            .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16).padding(.bottom, 8)
            HStack(spacing: 12) {
                RegistrySearchField(
                    text: $roleQuery,
                    placeholder: L10n("Search role names, descriptions or specialties"),
                    identifier: "roles-search", focusRequest: roleSearchFocusRequest
                )
                .frame(height: 32)
                if registry.isRefreshing {
                    ProgressView().controlSize(.small).accessibilityLabel(L10n("Loading roles"))
                }
                Text("\(matches.count) / \(registry.roles.count)")
                    .font(WorkbenchTypography.font(for: .metadata)).monospacedDigit()
                    .foregroundStyle(
                        .secondary
                    )
                    .fixedSize().accessibilityLabel(
                        L10nFormat("%d of %d roles", matches.count, registry.roles.count))
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            registryError
            switch registry.phase(itemCount: registry.roles.count) {
            case .loading:
                loadingView("Loading roles")
            case .failed:
                failedView
            case .empty:
                ContentUnavailableView {
                    Label(L10n("No roles yet"), systemImage: "person.2")
                } description: {
                    Text(L10n("Create a reusable role for conversations and tasks."))
                } actions: {
                    createRoleButton
                }
            case .content:
                if matches.isEmpty {
                    noMatchesView(title: "No matching roles", clear: { roleQuery = "" })
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
                            ForEach(matches) { role in roleCard(role) }
                        }.padding(16)
                    }
                    .accessibilityIdentifier("roles-grid")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func rolesHeader(width: CGFloat, inlineSkills: Bool, canInlineSkills: Bool) -> some View
    {
        if width < 420 {
            HStack(spacing: 8) {
                rolesTitle
                Spacer(minLength: 4)
                Menu(L10n("Manage")) {
                    Button(L10n("Skills")) { isShowingSkillsSheet = true }
                    Button(L10n("Manage MCP")) { isShowingMcpSheet = true }
                }.fixedSize()
                createRoleButton
            }.padding(.horizontal, 16).frame(minHeight: 60)
        } else if width < 600 {
            VStack(alignment: .leading, spacing: 8) {
                rolesTitle
                HStack(spacing: 8) {
                    managementButtons(inlineSkills: inlineSkills, canInlineSkills: canInlineSkills)
                    Spacer(minLength: 0)
                    createRoleButton
                }
            }.padding(16)
        } else {
            HStack(spacing: 8) {
                rolesTitle
                Spacer(minLength: 8)
                managementButtons(inlineSkills: inlineSkills, canInlineSkills: canInlineSkills)
                createRoleButton
            }.padding(.horizontal, 16).frame(minHeight: 60)
        }
    }

    private var rolesTitle: some View {
        HStack(spacing: 8) {
            Text(L10n("Roles")).font(WorkbenchTypography.font(for: .pageTitle))
            Text("\(registry.roles.count)")
                .font(WorkbenchTypography.font(for: .metadata)).monospacedDigit().foregroundStyle(
                    .secondary
                )
                .padding(.horizontal, 8).padding(.vertical, 2).background(
                    .quaternary, in: Capsule())
        }.fixedSize()
    }

    private var createRoleButton: some View {
        Button {
            isCreatingRole = true
        } label: {
            Label(L10n("New role"), systemImage: "plus")
        }
        .buttonStyle(.borderedProminent).disabled(!registry.isReachable)
        .accessibilityIdentifier("roles-create")
    }

    @ViewBuilder
    private func managementButtons(inlineSkills: Bool, canInlineSkills: Bool) -> some View {
        Button {
            if canInlineSkills { showsSkillsColumn.toggle() } else { isShowingSkillsSheet = true }
        } label: {
            Label(L10n("Skills"), systemImage: "shippingbox")
        }
        .buttonStyle(.bordered).focused($skillsButtonFocused)
        .tint(inlineSkills ? .accentColor : nil)
        .background(
            inlineSkills ? Color.accentColor.opacity(0.12) : .clear,
            in: RoundedRectangle(cornerRadius: 6)
        )
        .accessibilityValue(L10n(inlineSkills ? "Expanded" : "Collapsed"))
        .accessibilityAddTraits(inlineSkills ? .isSelected : [])
        .accessibilityIdentifier("roles-skills")
        Button {
            isShowingMcpSheet = true
        } label: {
            Label(L10n("Manage MCP"), systemImage: "point.3.connected.trianglepath.dotted")
        }.buttonStyle(.bordered).help(L10n("Manage independent MCP Servers and role assignments"))
            .accessibilityIdentifier("roles-mcp")
    }

    private func skillsColumn(isSheet: Bool) -> some View {
        let matches = registry.matchingSkills(skillQuery)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n("Skills")).font(WorkbenchTypography.font(for: .sectionTitle))
                Spacer(minLength: 0)
                Button {
                    isRegisteringSkill = true
                } label: {
                    Label(L10n("Register Skill"), systemImage: "plus")
                }
                .disabled(!registry.isReachable).accessibilityIdentifier("skills-register")
                if isSheet {
                    Button {
                        isShowingSkillsSheet = false
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .keyboardShortcut(.cancelAction).accessibilityLabel(L10n("Close Skills"))
                }
            }.padding(.horizontal, 16).frame(minHeight: 60)
            Text(L10n("Shared registry. Assign registered skills in role details."))
                .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16).padding(.bottom, 8)
            RegistrySearchField(
                text: $skillQuery, placeholder: L10n("Search Skills"), identifier: "skills-search",
                focusRequest: skillSearchFocusRequest
            )
            .frame(height: 32).padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            switch registry.phase(itemCount: registry.skills.count) {
            case .loading: loadingView("Loading Skills")
            case .failed: failedView
            case .empty:
                ContentUnavailableView(
                    L10n("No Skills"), systemImage: "shippingbox",
                    description: Text(
                        L10n("Register a Skill from a local directory or Git repository.")))
            case .content:
                if matches.isEmpty {
                    noMatchesView(title: "No matching Skills", clear: { skillQuery = "" })
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(matches) { skill in
                                SkillRegistryRow(
                                    skill: skill, isInspecting: inspectingSkillID == skill.id,
                                    canDelete: registry.isReachable && inspectingSkillID == nil
                                        && !isDeletingSkill
                                ) {
                                    Task { await prepareSkillDeletion(skill) }
                                }
                                Divider().padding(.leading, 16)
                            }
                        }
                    }.accessibilityIdentifier("skills-registry")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(isSheet ? WorkbenchStyle.canvas : Color.clear)
        .sheet(isPresented: $isRegisteringSkill) { SkillRegisterView { _ in } }
        .background {
            if isSheet {
                Button(L10n("Search Skills")) { skillSearchFocusRequest &+= 1 }
                    .keyboardShortcut("f", modifiers: .command).disabled(isRegisteringSkill)
                    .hidden().frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder private var registryError: some View {
        if let error = registry.syncError {
            HStack(alignment: .top, spacing: 8) {
                Label(
                    L10n("Registry unavailable. Displayed data may be out of date."),
                    systemImage: "exclamationmark.triangle")
                Spacer(minLength: 0)
                Button(L10n("Retry")) { Task { await registry.refresh() } }.disabled(
                    registry.isRefreshing)
            }
            .font(WorkbenchTypography.font(for: .help))
            .help(error).padding(16).accessibilityLabel(error)
        }
    }

    private func loadingView(_ title: String) -> some View {
        ProgressView(L10n(title)).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var failedView: some View {
        ContentUnavailableView {
            Label(L10n("Unable to load registry"), systemImage: "exclamationmark.triangle")
        } description: {
            Text(registry.syncError ?? L10n("Retry"))
        } actions: {
            Button(L10n("Retry")) { Task { await registry.refresh() } }.disabled(
                registry.isRefreshing)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func noMatchesView(title: String, clear: @escaping () -> Void) -> some View {
        ContentUnavailableView {
            Label(L10n(title), systemImage: "magnifyingglass")
        } description: {
            Text(L10n("Try another search or clear the current query."))
        } actions: {
            Button(L10n("Clear search"), action: clear)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var missingRoleView: some View {
        ContentUnavailableView {
            Label(L10n("Role no longer exists"), systemImage: "person.crop.circle.badge.xmark")
        } description: {
            Text(L10n("The registry was updated. Return to choose another role."))
        } actions: {
            Button(L10n("Close")) {
                selectedRoleForDetail = nil
                roleForSessionCreation = nil
            }.keyboardShortcut(.cancelAction)
        }
        .frame(width: 480, height: 300)
    }

    private func restoreRoleFocus() {
        if let id = returnRoleID, registry.matchingRoles(roleQuery).contains(where: { $0.id == id })
        {
            focusedRoleID = id
        } else {
            focusedRoleID = registry.matchingRoles(roleQuery).first?.id
        }
    }

    private func prepareSkillDeletion(_ skill: Skill) async {
        guard inspectingSkillID == nil, !isDeletingSkill else { return }
        inspectingSkillID = skill.skillId
        defer { inspectingSkillID = nil }
        guard let impact = await client.skillDeletionImpact(skillId: skill.skillId) else {
            skillDeletionError =
                client.errorMessage ?? L10n("Unable to inspect Skill deletion impact.")
            return
        }
        pendingSkillDeletion = impact
    }

    private func confirmSkillDeletion(_ impact: SkillDeletionImpact) async {
        guard SkillDeletionConfirmationPolicy.canOfferDestructiveAction(for: impact) else { return }
        isDeletingSkill = true
        defer { isDeletingSkill = false }
        if await client.deleteSkill(skillId: impact.skillId) {
            pendingSkillDeletion = nil
        } else {
            pendingSkillDeletion = nil
            skillDeletionError = client.errorMessage ?? L10n("Unable to delete Skill.")
        }
    }

    private func skillDeletionConfirmationMessage(_ impact: SkillDeletionImpact) -> String {
        let agentNames = impact.affectedAgents.map(\.name).joined(separator: "、")
        let affected =
            impact.affectedAgentCount == 0
            ? L10n("No Role currently uses this Skill.")
            : L10nFormat(
                "This permanently removes the Skill from %d Role(s): %@.",
                impact.affectedAgentCount,
                agentNames)
        if impact.canDelete {
            return affected + "\n\n"
                + L10n(
                    "All Provider runtime copies and the Git cache will be removed. This cannot be undone."
                )
        }
        let sessions = impact.activeSessions.map { "\($0.title)（\($0.agentName)）" }.joined(
            separator: "、")
        return affected + "\n\n"
            + L10nFormat(
                "Deletion is blocked because %d active Session(s) can still use this Skill: %@. End or interrupt them first.",
                impact.activeSessionCount,
                sessions
            )
    }

    private func roleCard(_ role: Role) -> some View {
        RoleCard(
            agent: role, canStartSession: registry.isReachable, focusedRoleID: $focusedRoleID,
            onOpenDetail: {
                returnRoleID = role.id
                selectedRoleForDetail = role
            },
            onStartSession: {
                returnRoleID = role.id
                roleForSessionCreation = role
            }
        )
        .contextMenu {
            Button(L10n("开始新会话")) {
                returnRoleID = role.id
                roleForSessionCreation = role
            }
            .disabled(role.status == "unavailable" || !registry.isReachable)
            Button(L10n("打开详情")) {
                returnRoleID = role.id
                selectedRoleForDetail = role
            }
            Divider()
            Button {
                NotificationCenter.default.post(
                    name: .showAgentOrb, object: nil, userInfo: ["agentId": role.roleId])
            } label: {
                Label(L10n("Show Floating Orb"), systemImage: "circle.circle")
            }
        }
    }
}

struct SkillRegistryRow: View {
    let skill: Skill
    var isInspecting = false
    var canDelete = true
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(skill.name).font(WorkbenchTypography.font(for: .cardTitle)).lineLimit(1).help(
                    skill.name)
                Spacer(minLength: 0)
                if isInspecting {
                    ProgressView().controlSize(.small).accessibilityLabel(
                        L10n("Checking deletion impact"))
                }
                Menu {
                    Button(L10n("Copy source")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(skill.source, forType: .string)
                    }
                    Divider()
                    Button(L10n("Delete Skill"), role: .destructive, action: onDelete).disabled(
                        !canDelete)
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton).fixedSize().frame(minWidth: 28, minHeight: 28)
                .accessibilityLabel(L10nFormat("Actions for %@", skill.name))
            }
            Text(skill.description.isEmpty ? L10n("No description") : skill.description)
                .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary).lineLimit(2)
            Text(L10n(skill.isManaged ? "托管安装" : "来源引用"))
                .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.vertical, 2).background(
                    .quaternary, in: Capsule())
            Label(
                "\(L10n(skill.sourceKindLocalizationKey)) · \(skill.source)",
                systemImage: skill.sourceType == "url"
                    ? "link" : (skill.isGit ? "arrow.triangle.branch" : "folder")
            )
            .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.middle).help(skill.source)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
    }
}

struct RoleCard: View {
    let agent: Role
    var canStartSession = true
    @FocusState.Binding var focusedRoleID: String?
    let onOpenDetail: () -> Void
    let onStartSession: () -> Void
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ZStack {
            // A separate native button covers the card. Footer and popover
            // buttons are siblings, never nested buttons or bubbling gestures.
            Button(action: onOpenDetail) {
                Color.clear.contentShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain).focused($focusedRoleID, equals: agent.id)
            .onKeyPress(.return) {
                onOpenDetail()
                return .handled
            }
            .accessibilityLabel(L10nFormat("Open details for %@", agent.name))
            .accessibilityIdentifier("role-detail-\(agent.id)")

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    avatar
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.name).font(WorkbenchTypography.font(for: .cardTitle)).lineLimit(
                            1
                        ).help(
                            agent.name)
                        Text(
                            L10n(
                                agent.isPlatformAssistant
                                    ? "Platform managed" : "Available for chat and tasks")
                        )
                        .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                        .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 40, alignment: .top).allowsHitTesting(false)
                Text(agent.description.isEmpty ? L10n("No description") : agent.description)
                    .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                    .lineLimit(3).frame(maxWidth: .infinity, minHeight: 54, alignment: .topLeading)
                    .padding(.top, 8).allowsHitTesting(false)
                FlowTags(tags: agent.capabilities).padding(.top, 8)
                Spacer(minLength: 10)
                HStack(spacing: 8) {
                    if agent.status == "unavailable" {
                        Label(L10n("Unavailable"), systemImage: "exclamationmark.circle")
                            .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.red)
                            .lineLimit(1)
                            .help(agent.statusReason ?? L10n("Unavailable"))
                            .accessibilityLabel(agent.statusReason ?? L10n("Unavailable"))
                    }
                    Spacer(minLength: 0)
                    Button(action: onStartSession) {
                        Label(L10n("开始新会话"), systemImage: "bubble.left.and.bubble.right")
                    }
                    .buttonStyle(.bordered).frame(minHeight: 28)
                    .disabled(agent.status == "unavailable" || !canStartSession)
                    .accessibilityIdentifier("role-start-\(agent.id)")
                }
            }.padding(16)
        }
        .frame(maxWidth: .infinity, minHeight: 268, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    focusedRoleID == agent.id
                        ? Color.accentColor
                        : Color(
                            nsColor: contrast == .increased
                                ? .separatorColor : .quaternaryLabelColor),
                    lineWidth: focusedRoleID == agent.id ? 2 : 1
                )
                .allowsHitTesting(false)
        }
    }

    private var avatar: some View {
        RoleCardAvatar(role: agent)
    }
}

struct RoleCardAvatar: View {
    let role: Role
    var size: CGFloat = 40
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                DefaultInitialAvatarView(
                    familySeed: role.name, variationSeed: role.roleId,
                    initials: DefaultAvatarInitials.make(from: role.name), size: size)
            }
        }.frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
            .task(id: role.avatarPath) {
                // Static thumbnails; loading is tied to the path, never body evaluation.
                image = role.avatarPath.flatMap { AvatarImageSupport.loadImage(at: $0) }
            }
    }
}

struct FlowTags: View {
    let tags: [String]
    @State private var isShowingAllTags = false

    var body: some View {
        Group {
            if tags.isEmpty {
                Text(L10n("无专长标签")).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(
                    .secondary
                )
                .frame(maxWidth: .infinity, alignment: .leading).allowsHitTesting(false)
            } else {
                CappedFlowLayout(spacing: 6, maxRows: 2) {
                    ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                        Text(tag).font(WorkbenchTypography.font(for: .metadata)).lineLimit(1)
                            .truncationMode(
                                .tail
                            )
                            .padding(.horizontal, 7).padding(.vertical, 3).background(
                                .quaternary, in: Capsule()
                            )
                            .allowsHitTesting(false)
                    }
                    Button {
                        isShowingAllTags = true
                    } label: {
                        Text("…").font(WorkbenchTypography.font(for: .metadata)).frame(minWidth: 18)
                            .padding(.horizontal, 4).padding(.vertical, 3).background(
                                .quaternary, in: Capsule())
                    }
                    .buttonStyle(.plain).help(L10n("查看全部标签")).accessibilityLabel(L10n("查看全部标签"))
                    .popover(isPresented: $isShowingAllTags, arrowEdge: .bottom) { allTagsPopover }
                }
            }
        }.frame(height: CappedFlowLayout.regionHeight, alignment: .topLeading).clipped()
    }

    private var allTagsPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("全部专长标签")).font(WorkbenchTypography.font(for: .sectionTitle))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                        Text(tag).font(WorkbenchTypography.font(for: .help)).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true).frame(
                                maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.frame(maxHeight: 260)
        }.padding(16).frame(minWidth: 260, idealWidth: 320, maxWidth: 380)
    }
}

// 最后一个子视图固定为溢出入口。Layout 会先尝试完整排布；只有内容确实溢出时才放置入口。
struct CappedFlowLayout: Layout {
    static let regionHeight: CGFloat = 48

    var spacing: CGFloat = 6
    var maxRows: Int = 2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? 260, height: Self.regionHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let overflowSubview = subviews.last else { return }
        let tagSubviews = subviews.dropLast()
        let tagSizes = tagSubviews.map { $0.sizeThatFits(.unspecified) }
        let overflowSize = overflowSubview.sizeThatFits(.unspecified)
        let result = CappedFlowLayoutEngine.layout(
            itemSizes: tagSizes,
            overflowSize: overflowSize,
            availableWidth: bounds.width,
            maxRows: maxRows,
            spacing: spacing
        )

        for (index, frame) in result.itemFrames.enumerated() {
            if let frame {
                tagSubviews[index].place(
                    at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                    proposal: ProposedViewSize(frame.size)
                )
            } else {
                tagSubviews[index].place(
                    at: CGPoint(x: bounds.maxX + 1, y: bounds.maxY + 1),
                    proposal: .zero
                )
            }
        }
        if let frame = result.overflowFrame {
            overflowSubview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size)
            )
        } else {
            overflowSubview.place(
                at: CGPoint(x: bounds.maxX + 1, y: bounds.maxY + 1),
                proposal: .zero
            )
        }
    }
}

struct CappedFlowLayoutResult: Equatable {
    let itemFrames: [CGRect?]
    let overflowFrame: CGRect?

    var visibleItemCount: Int { itemFrames.compactMap { $0 }.count }
    var isOverflowing: Bool { overflowFrame != nil }
}

enum CappedFlowLayoutEngine {
    static func layout(
        itemSizes: [CGSize],
        overflowSize: CGSize,
        availableWidth: CGFloat,
        maxRows: Int,
        spacing: CGFloat
    ) -> CappedFlowLayoutResult {
        let width = max(0, availableWidth)
        let rows = max(1, maxRows)
        let firstPass = place(itemSizes: itemSizes, availableWidth: width, maxRows: rows, spacing: spacing)
        let hasTruncatedItem = itemSizes.contains { $0.width > width }
        guard firstPass.visibleItemCount < itemSizes.count || hasTruncatedItem else {
            return CappedFlowLayoutResult(itemFrames: firstPass.frames, overflowFrame: nil)
        }

        let indicatorWidth = min(max(0, overflowSize.width), width)
        let finalRowWidth = max(0, width - indicatorWidth - spacing)
        let capped = place(
            itemSizes: itemSizes,
            availableWidth: width,
            maxRows: rows,
            spacing: spacing,
            finalRowWidth: finalRowWidth
        )
        let rowHeight = max(capped.rowHeight, overflowSize.height)
        let finalRowY = CGFloat(rows - 1) * (rowHeight + spacing)
        let lastVisibleFrame = capped.frames.compactMap { $0 }.last
        let indicatorX: CGFloat
        if let lastVisibleFrame, abs(lastVisibleFrame.minY - finalRowY) < 0.5 {
            indicatorX = min(width - indicatorWidth, lastVisibleFrame.maxX + spacing)
        } else {
            indicatorX = 0
        }
        let overflowFrame = CGRect(x: max(0, indicatorX), y: finalRowY, width: indicatorWidth, height: overflowSize.height)
        return CappedFlowLayoutResult(itemFrames: capped.frames, overflowFrame: overflowFrame)
    }

    private static func place(
        itemSizes: [CGSize],
        availableWidth: CGFloat,
        maxRows: Int,
        spacing: CGFloat,
        finalRowWidth: CGFloat? = nil
    ) -> (frames: [CGRect?], visibleItemCount: Int, rowHeight: CGFloat) {
        let rowHeight = itemSizes.map(\.height).max() ?? 0
        var frames = Array<CGRect?>(repeating: nil, count: itemSizes.count)
        var row = 0
        var x: CGFloat = 0

        for (index, naturalSize) in itemSizes.enumerated() {
            var rowWidth = row == maxRows - 1 ? (finalRowWidth ?? availableWidth) : availableWidth
            rowWidth = max(0, rowWidth)
            var itemWidth = min(max(0, naturalSize.width), rowWidth)
            if x > 0, x + itemWidth > rowWidth {
                row += 1
                x = 0
                guard row < maxRows else { break }
                rowWidth = row == maxRows - 1 ? (finalRowWidth ?? availableWidth) : availableWidth
                itemWidth = min(max(0, naturalSize.width), max(0, rowWidth))
            }
            guard itemWidth > 0 else { break }
            let y = CGFloat(row) * (rowHeight + spacing)
            frames[index] = CGRect(x: x, y: y, width: itemWidth, height: naturalSize.height)
            x += itemWidth + spacing
        }

        return (frames, frames.compactMap { $0 }.count, rowHeight)
    }
}
