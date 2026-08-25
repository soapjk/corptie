import Foundation

/// Synchronous local selection authority. Selecting a row never starts I/O;
/// transports observe the committed identity afterwards.
@MainActor
final class SessionSelectionController: ObservableObject {
    @Published private(set) var selectedSessionID: String?
    private(set) var generation: UInt64 = 0

    @discardableResult
    func select(_ sessionID: String) -> UInt64 {
        guard selectedSessionID != sessionID else { return generation }
        generation &+= 1
        selectedSessionID = sessionID
        return generation
    }

    func clear() {
        guard selectedSessionID != nil else { return }
        generation &+= 1
        selectedSessionID = nil
    }
}

/// Supplementary panel state is keyed independently from Timeline state so a
/// Usage/Workspace/Automation refresh cannot rebuild rows or the Session index.
@MainActor
final class SessionSupplementaryDataController: ObservableObject {
    struct State: Equatable {
        var isLoading = false
        var error: String?
        var revision: UInt64 = 0
    }
    @Published private(set) var selectedSessionID: String?
    @Published var selectedSessionUsage: SessionUsageResponse?
    @Published var selectedContextReferences: [SessionContextReference] = []
    @Published var isLoadingContextReferences = false
    @Published var selectedProjectWorktreeStatus: ProjectWorktreeStatusResponse?
    @Published var selectedProjectIntegrationStatus: ProjectIntegrationStatusResponse?
    @Published var projectWorktreeLoadError: String?
    @Published var isLoadingProjectWorktrees = false
    @Published var workspaceRecoveryStatus: WorkspaceRecoveryStatus?
    @Published var selectedScheduledTasks: [ScheduledSessionTask] = []
    @Published var isLoadingScheduledTasks = false
    private var states: [String: State] = [:]

    func select(_ sessionID: String?) { selectedSessionID = sessionID }
    func state(for sessionID: String) -> State { states[sessionID] ?? State() }
    func update(_ sessionID: String, _ transform: (inout State) -> Void) {
        var value = states[sessionID] ?? State()
        transform(&value)
        value.revision &+= 1
        states[sessionID] = value
        if selectedSessionID == sessionID { objectWillChange.send() }
    }
}

/// Command in-flight state is isolated from selection and data projections.
@MainActor
final class SessionCommandController: ObservableObject {
    struct Key: Hashable { let sessionID: String; let command: String }
    @Published private(set) var inFlight: Set<Key> = []
    @Published var isSendingMessage = false
    @Published var sendStatusMessage: String?
    @Published var scheduledTaskMutationIds = Set<String>()
    @Published var scheduledTaskError: String?
    @Published var isSwitchingModel = false
    @Published var isSwitchingReasoning = false
    @Published var connectionTransitionSessionIds = Set<String>()
    @Published var restartingSessionIds = Set<String>()
    @Published var restartActivityBySessionId: [String: SessionRestartActivity] = [:]
    @Published var undoneCodexTurnIds = Set<String>()
    @Published var projectWorktreeActionError: String?
    @Published var projectWorktreeActionIds = Set<String>()
    @Published var isCleaningMergedProjectWorktrees = false
    @Published var isIntegratingCompletedWorktrees = false
    @Published var isCreatingIntegrationConflictWorkItem = false
    @Published var gitHubPushPreparation: GitHubPushPreparation?
    @Published var gitHubPushError: String?
    @Published var isPreparingGitHubPush = false
    @Published var isGeneratingGitHubCommitMessage = false
    @Published var gitHubPushingSessionId: String?
    @Published var isRecoveringWorkspace = false
    @Published var isGeneratingWorktreeCommitMessage = false

    func begin(sessionID: String, command: String) { inFlight.insert(Key(sessionID: sessionID, command: command)) }
    func end(sessionID: String, command: String) { inFlight.remove(Key(sessionID: sessionID, command: command)) }
    func isRunning(sessionID: String, command: String) -> Bool { inFlight.contains(Key(sessionID: sessionID, command: command)) }
}
