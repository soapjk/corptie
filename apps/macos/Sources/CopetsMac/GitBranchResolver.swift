import Foundation

enum GitHeadState: Equatable {
    case branch(name: String, oid: String)
    case unborn(name: String)
    case detached(oid: String)
    case missingWorktree
    case notRepository
    case unavailable

    @MainActor
    var stampText: String? {
        switch self {
        case let .branch(name, _):
            name
        case let .unborn(name):
            "\(name) · unborn"
        case let .detached(oid):
            "detached@\(String(oid.prefix(8)))"
        case .missingWorktree:
            L10n("Workspace missing")
        case .unavailable:
            L10n("Git status unavailable")
        case .notRepository:
            nil
        }
    }

    @MainActor
    var helpText: String? {
        switch self {
        case let .branch(name, _):
            L10nFormat("Git branch: %@", name)
        case let .unborn(name):
            L10nFormat("Unborn Git branch: %@", name)
        case let .detached(oid):
            L10nFormat("Detached Git HEAD: %@", oid)
        case .missingWorktree:
            L10n("The session workspace no longer exists.")
        case .unavailable:
            L10n("Git status is currently unavailable.")
        case .notRepository:
            nil
        }
    }

    var isWarning: Bool {
        switch self {
        case .missingWorktree, .unavailable:
            true
        default:
            false
        }
    }
}

enum GitBranchResolver {
    static func headState(at workingDirectory: String) async -> GitHeadState {
        let path = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            return .missingWorktree
        }
        return await Task.detached(priority: .utility) {
            headStateSynchronously(at: path)
        }.value
    }

    static func headStateSynchronously(at workingDirectory: String) -> GitHeadState {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: workingDirectory, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return .missingWorktree
        }

        let repositoryCheck = runGit(
            ["rev-parse", "--is-inside-work-tree"],
            at: workingDirectory
        )
        guard repositoryCheck.didRun else {
            return .unavailable
        }
        guard repositoryCheck.status == 0,
              repositoryCheck.output == "true" else {
            return repositoryCheck.error.localizedCaseInsensitiveContains("permission denied")
                ? .unavailable
                : .notRepository
        }

        let symbolicHead = runGit(
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            at: workingDirectory
        )
        if symbolicHead.status == 0, !symbolicHead.output.isEmpty {
            let commit = runGit(["rev-parse", "--verify", "HEAD"], at: workingDirectory)
            if commit.status == 0, !commit.output.isEmpty {
                return .branch(name: symbolicHead.output, oid: commit.output)
            }
            return .unborn(name: symbolicHead.output)
        }

        let detachedHead = runGit(["rev-parse", "--verify", "HEAD"], at: workingDirectory)
        if detachedHead.status == 0, !detachedHead.output.isEmpty {
            return .detached(oid: detachedHead.output)
        }
        return .unavailable
    }

    static func branchName(at workingDirectory: String) async -> String? {
        branchName(from: await headState(at: workingDirectory))
    }

    static func branchNameSynchronously(at workingDirectory: String) -> String? {
        branchName(from: headStateSynchronously(at: workingDirectory))
    }

    private static func branchName(from state: GitHeadState) -> String? {
        switch state {
        case let .branch(name, _), let .unborn(name):
            name
        default:
            nil
        }
    }

    private static func runGit(_ arguments: [String], at workingDirectory: String) -> GitCommandResult {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", workingDirectory] + arguments
        process.standardOutput = output
        process.standardError = errors

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return GitCommandResult(didRun: false, status: -1, output: "", error: error.localizedDescription)
        }

        return GitCommandResult(
            didRun: true,
            status: process.terminationStatus,
            output: output.fileHandleForReading.readString(),
            error: errors.fileHandleForReading.readString()
        )
    }
}

private struct GitCommandResult {
    let didRun: Bool
    let status: Int32
    let output: String
    let error: String
}

private extension FileHandle {
    func readString() -> String {
        String(data: readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}
