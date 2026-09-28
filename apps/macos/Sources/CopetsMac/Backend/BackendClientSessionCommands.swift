import Foundation

extension BackendClient {
    func refreshArchivedSessions(sessionKind: SessionKind? = nil) async {
        await archivedSessionController.refreshArchivedSessions(sessionKind: sessionKind)
    }

    func loadMoreArchivedSessions() async {
        await archivedSessionController.loadMoreArchivedSessions()
    }

    func loadArchivedSession(id: String) async -> TaskSession? {
        await archivedSessionController.loadArchivedSession(id: id)
    }

    func createPtyTask(title: String, command: String, arguments: [String], initialInput: String,
                       cwd: String, onNameConflict: @escaping (String) -> Void = { _ in },
                       onSuccess: @escaping () -> Void = {}) {
        sessionCreationController.createPtyTask(
            title: title, command: command, arguments: arguments, initialInput: initialInput,
            cwd: cwd, onNameConflict: onNameConflict, onSuccess: onSuccess
        )
    }

    func createCodexPtyTask(
        title: String, prompt: String, cwd: String, existingSessionId: String = "",
        sandbox: String = "workspace-write", approvalPolicy: String = "on-request",
        model: String = "", reasoningLevel: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        sessionCreationController.createCodexPtyTask(
            title: title, prompt: prompt, cwd: cwd, existingSessionId: existingSessionId,
            sandbox: sandbox, approvalPolicy: approvalPolicy, model: model,
            reasoningLevel: reasoningLevel, onNameConflict: onNameConflict, onSuccess: onSuccess
        )
    }

    func createClaudeTask(
        title: String, prompt: String, cwd: String,
        sandbox: String = "workspace-write", approvalPolicy: String = "on-request",
        model: String = "", onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        sessionCreationController.createClaudeTask(
            title: title, prompt: prompt, cwd: cwd, sandbox: sandbox,
            approvalPolicy: approvalPolicy, model: model,
            onNameConflict: onNameConflict, onSuccess: onSuccess
        )
    }

    func createProviderTask(
        providerId: String, title: String, prompt: String, cwd: String,
        sandbox: String = "workspace-write", approvalPolicy: String = "on-request",
        model: String = "", reasoningLevel: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        sessionCreationController.createProviderTask(
            providerId: providerId, title: title, prompt: prompt, cwd: cwd,
            sandbox: sandbox, approvalPolicy: approvalPolicy, model: model,
            reasoningLevel: reasoningLevel, onNameConflict: onNameConflict, onSuccess: onSuccess
        )
    }

    func respondToCodexApproval(option: CodexApprovalOption) {
        sessionChoiceController.respondToCodexApproval(option: option)
    }

    func respondToCodexApproval(option: CodexApprovalOption, to session: TaskSession) {
        sessionChoiceController.respondToCodexApproval(option: option, to: session)
    }

    func respondToCodexApproval(approved: Bool) {
        let fallback = CodexApprovalOption(
            id: approved ? "approve" : "deny",
            label: approved ? L10n("Approve") : L10n("Deny"),
            role: approved ? "approve" : "deny",
            index: approved ? 0 : 1,
            selected: approved
        )
        respondToCodexApproval(option: fallback)
    }

    func respondToUserInput(sessionID: String, itemID: String,
                            answers: [String: [String]], action: String = "submit") async throws {
        try await sessionChoiceController.respondToUserInput(
            sessionID: sessionID, itemID: itemID, answers: answers, action: action
        )
    }

    func respondToPtyChoice(option: CodexApprovalOption, choiceId: String? = nil, in targetSession: TaskSession? = nil) {
        sessionChoiceController.respondToPtyChoice(
            option: option, choiceId: choiceId, in: targetSession
        )
    }

    func respondToSuggestedOption(_ option: CodexApprovalOption, in session: TaskSession) {
        sessionChoiceController.respondToSuggestedOption(option, in: session)
    }
    func createCodexTask(
        prompt: String, cwd: String,
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        sessionCreationController.createCodexTask(
            prompt: prompt, cwd: cwd, onNameConflict: onNameConflict, onSuccess: onSuccess
        )
    }
}
