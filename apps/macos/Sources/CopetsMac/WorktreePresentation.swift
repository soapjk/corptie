import AppKit
import CorptieClientCore
import CorptieConversation
import SwiftUI

/// Presentation-only policies. No Git, Provider, network, or filesystem work.
enum WorktreeLayoutMode: Equatable {
    case compact, twoColumns, threeColumns

    func resized(to width: CGFloat) -> Self {
        guard width.isFinite else { return self }
        switch self {
        case .compact:
            return width >= 994 ? .threeColumns : width >= 764 ? .twoColumns : .compact
        case .twoColumns:
            return width < 740 ? .compact : width >= 994 ? .threeColumns : .twoColumns
        case .threeColumns:
            return width < 740 ? .compact : width < 970 ? .twoColumns : .threeColumns
        }
    }
}

enum WorktreeDetailTab: String, CaseIterable {
    case overview, changes, execution
    @MainActor var title: String {
        switch self {
        case .overview: L10n("Overview")
        case .changes: L10n("Changes")
        case .execution: L10n("Execution Record")
        }
    }
}

enum WorktreeStatusFilter: String, CaseIterable {
    case all, attention, changed, unavailable
    @MainActor var title: String {
        switch self {
        case .all: L10n("All")
        case .attention: L10n("Needs Attention")
        case .changed: L10n("Has Changes")
        case .unavailable: L10n("Unavailable")
        }
    }
    func includes(_ tree: ManagedWorktree) -> Bool {
        switch self {
        case .all: true
        case .attention: tree.availability != "available" || tree.dirty == nil || tree.isLocked
            || tree.operationState != nil || !tree.conflictFiles.isEmpty || tree.pendingIntegration
        case .changed: tree.dirty == true
        case .unavailable: tree.availability != "available"
        }
    }
}

@MainActor
enum WorktreePresentationPolicy {
    static func matches(_ query: String, values: [String]) -> Bool {
        let words = query.split(whereSeparator: \.isWhitespace)
        return words.allSatisfy { word in values.contains { $0.localizedStandardContains(String(word)) } }
    }

    static func batchBlocker(_ tree: ManagedWorktree) -> String? {
        if tree.hierarchy != nil { return L10n("Use the parent-child integration actions for this Worktree.") }
        if tree.availability != "available" { return L10n("This Worktree is unavailable.") }
        if tree.isDetached || tree.branchName == nil { return L10n("This Worktree has no named branch.") }
        if tree.operationState != nil { return L10n("A Git operation is in progress.") }
        if !tree.conflictFiles.isEmpty { return L10n("Resolve conflicts before selecting this Worktree.") }
        return nil
    }

    static func changeSummary(_ tree: ManagedWorktree) -> String {
        if tree.availability != "available" || tree.dirty == nil { return L10n("Unable to confirm local changes. Refresh or inspect the local directory.") }
        if !tree.changedFiles.isEmpty { return L10nFormat("%d uncommitted files", tree.changedFiles.count) }
        return tree.dirty == true ? L10n("Changes detected; the file list was not provided.") : L10n("No uncommitted files")
    }

    static func localState(_ tree: ManagedWorktree) -> (title: String, symbol: String, color: Color) {
        if tree.availability != "available" { return (L10n("Unavailable"), "exclamationmark.triangle", .red) }
        if !tree.conflictFiles.isEmpty { return (L10n("Conflicts"), "exclamationmark.triangle", .orange) }
        if tree.operationState != nil { return (L10n("Operation in progress"), "clock", .orange) }
        if tree.isLocked { return (L10n("Locked"), "lock", .orange) }
        guard let dirty = tree.dirty else { return (L10n("Unknown"), "questionmark.circle", .secondary) }
        return dirty ? (L10n("Has Changes"), "pencil.circle", .orange) : (L10n("Clean"), "checkmark.circle", .secondary)
    }
}

/// Rebuilt only when inventory/query changes, never on job progress or row rendering.
@MainActor
struct WorktreeListProjection {
    let trees: [ManagedWorktree]
    let matches: Set<String>
    let parentIDs: Set<String>
    let isFiltering: Bool
    let eligibleMatches: [String]
    private let roots: [ManagedWorktree]
    private let childrenByParent: [String: [ManagedWorktree]]

    init(trees: [ManagedWorktree] = [], query: String = "", filter: WorktreeStatusFilter = .all) {
        self.trees = trees
        isFiltering = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || filter != .all
        matches = Set(trees.filter {
            WorktreePresentationPolicy.matches(query, values: [$0.branchName ?? "", $0.path]) && filter.includes($0)
        }.map(\.worktreeId))
        let byID = Dictionary(uniqueKeysWithValues: trees.map { ($0.worktreeId, $0) })
        var parents = Set<String>()
        for id in matches {
            var next = byID[id]?.hierarchy?.parentWorktreeId
            var visited = Set<String>([id])
            while let parent = next, visited.insert(parent).inserted {
                parents.insert(parent)
                next = byID[parent]?.hierarchy?.parentWorktreeId
            }
        }
        parentIDs = parents
        let matchedIDs = matches
        let filtering = isFiltering
        eligibleMatches = trees.filter { matchedIDs.contains($0.worktreeId) && WorktreePresentationPolicy.batchBlocker($0) == nil }.map(\.worktreeId)
        let included = filtering ? trees.filter { matchedIDs.contains($0.worktreeId) || parents.contains($0.worktreeId) } : trees
        let index = TaskHierarchyIndex(nodes: included.map { .init(id: $0.worktreeId, workId: "inventory", parentTaskId: $0.hierarchy?.parentWorktreeId) })
        roots = (index.rootIDsByWork["inventory"] ?? []).compactMap { byID[$0] }
        childrenByParent = index.childrenByParentID.mapValues { ids in ids.compactMap { byID[$0] } }
    }

    func visible(expanded: Set<String>, repositoryID: String) -> [ManagedWorktree] {
        // The inventory index and batch eligibility were prepared on data/query change.
        // Expansion only concatenates the already prepared visible row groups.
        let expandedIDs = isFiltering ? expanded.union(parentIDs) : expanded
        var result: [ManagedWorktree] = []
        for root in roots {
            result.append(root)
            if expandedIDs.contains(root.worktreeId) { result.append(contentsOf: childrenByParent[root.worktreeId] ?? []) }
        }
        return result
    }

}

@MainActor
enum WorktreeBatchSelectionPolicy {
    static func reconcile(_ ids: [String], trees: [ManagedWorktree]) -> [String] {
        let eligible = Set(trees.filter { WorktreePresentationPolicy.batchBlocker($0) == nil }.map(\.worktreeId))
        return ids.filter { eligible.contains($0) }
    }

    static func adding(_ matches: [String], to selected: [String]) -> [String] {
        var seen = Set(selected)
        return selected + matches.filter { seen.insert($0).inserted }
    }
}

struct WorktreePanel: ViewModifier {
    var sidebar = false
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // Paint the complete column, including title-bar and bottom safe areas.
            // Content keeps its own safe-area layout; no rounded card clips the canvas.
            .background((sidebar ? WorkbenchStyle.sidebarColor : WorkbenchStyle.canvas)
                .ignoresSafeArea(.container, edges: .vertical))
    }
}

struct WorktreeChangesView: View {
    let tree: ManagedWorktree
    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            Text(WorktreePresentationPolicy.changeSummary(tree)).font(WorkbenchTypography.font(for: .help))
            if let stat = tree.diffStat, !stat.isEmpty { Text(stat).font(WorkbenchTypography.font(for: .technical)).textSelection(.enabled) }
            if !tree.conflictFiles.isEmpty {
                Label(L10n("Conflicting Files"), systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                ForEach(tree.conflictFiles, id: \.self) { Text($0).textSelection(.enabled) }
                Divider()
            }
            ForEach(tree.changedFiles, id: \.self) { file in
                Label(file, systemImage: "doc").font(WorkbenchTypography.font(for: .help)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct WorktreeAuditView: View {
    let job: WorktreeIntegrationJob
    let worktreeID: String
    @State private var onlyCurrentTree = false
    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            Text(L10n("The latest integration job for this repository, not a complete operation history."))
                .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            Text(job.id).font(WorkbenchTypography.font(for: .technical)).textSelection(.enabled)
            Text(L10nFormat("Created: %@", job.createdAt)).font(.subheadline)
            Text(L10nFormat("Updated: %@", job.updatedAt)).font(.subheadline)
            if let at = job.confirmedAt { Text(L10nFormat("Confirmed: %@", at)).font(.subheadline) }
            if let at = job.completedAt { Text(L10nFormat("Completed: %@", at)).font(.subheadline) }
            if !job.plan.items.contains(where: { $0.worktreeId == worktreeID }) {
                Text(L10n("This Worktree did not participate in this job.")).foregroundStyle(.secondary)
            }
            Toggle(L10n("Current Worktree and job-level events only"), isOn: $onlyCurrentTree)
                .toggleStyle(.checkbox)
            if job.audit.isEmpty { Text(L10n("This job did not provide event records.")).foregroundStyle(.secondary) }
            ForEach(job.audit.indices, id: \.self) { index in
                let event = job.audit[index]
                if !onlyCurrentTree || event.worktreeId == nil || event.worktreeId == worktreeID {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(event.at).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                        Text(event.event).textSelection(.enabled)
                        if let id = event.worktreeId { Text(id).font(WorkbenchTypography.font(for: .technical)).textSelection(.enabled) }
                        if let code = event.code { Text(code).font(WorkbenchTypography.font(for: .technical)).textSelection(.enabled) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Divider()
                }
            }
        }
    }
}

struct WorktreeDeletionReview: Identifiable {
    let repositoryID: String
    let repositoryName: String
    let tree: ManagedWorktree
    var id: String { "\(repositoryID):\(tree.worktreeId)" }
}

struct WorktreeDeletionConfirmation: View {
    let review: WorktreeDeletionReview
    let onConfirm: () -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("Delete this Worktree?")).font(WorkbenchTypography.font(for: .pageTitle))
            Text(review.repositoryName).font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(review.tree.branchName ?? L10n("Detached HEAD")).font(.headline)
                    Text(review.tree.path).textSelection(.enabled)
                    Text(L10n("The Worktree directory and its local branch will be permanently removed. This action cannot be undone here."))
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L10n("Delete Worktree and Local Branch"), role: .destructive) {
                    dismiss()
                    onConfirm()
                }.accessibilityIdentifier("worktree.delete.confirm")
            }
        }.padding(24).frame(width: 640, height: 340).background(WorkbenchStyle.canvas)
    }
}
