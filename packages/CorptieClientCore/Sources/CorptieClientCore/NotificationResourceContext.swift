import Foundation

/// Provider-neutral Work and Task context for user-facing notifications.
public struct NotificationResourceContext: Equatable, Sendable {
    public let workName: String?
    public let taskTitle: String?

    public init(workName: String? = nil, taskTitle: String? = nil) {
        self.workName = Self.nonEmpty(workName)
        self.taskTitle = Self.nonEmpty(taskTitle)
    }

    public var isEmpty: Bool { workName == nil && taskTitle == nil }

    public func displayLine(workLabel: String = "Work", taskLabel: String = "Task") -> String? {
        let parts = [
            workName.map { "\(workLabel)：\($0)" },
            taskTitle.map { "\(taskLabel)：\($0)" }
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

/// A compact lookup built from the current inventory. Exact Session IDs win;
/// provider/logical aliases are only used when their suffix has one match.
public struct NotificationResourceIndex: Sendable {
    public struct Work: Sendable {
        public let id: String
        public let name: String
        public init(id: String, name: String) { self.id = id; self.name = name }
    }

    public struct Task: Sendable {
        public let id: String
        public let title: String
        public let workID: String
        public init(id: String, title: String, workID: String) {
            self.id = id; self.title = title; self.workID = workID
        }
    }

    public struct Session: Sendable {
        public let id: String
        public let workID: String?
        public let taskID: String?
        public init(id: String, workID: String?, taskID: String?) {
            self.id = id; self.workID = workID; self.taskID = taskID
        }
    }

    private let worksByID: [String: Work]
    private let tasksByID: [String: Task]
    private let sessionsByID: [String: Session]
    private let uniqueSessionsByAlias: [String: Session]

    public init(works: [Work] = [], tasks: [Task] = [], sessions: [Session] = []) {
        worksByID = Dictionary(uniqueKeysWithValues: works.map { ($0.id, $0) })
        tasksByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        sessionsByID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })

        let groups = Dictionary(grouping: sessions, by: { Self.alias(for: $0.id) })
        uniqueSessionsByAlias = groups.reduce(into: [:]) { result, entry in
            if entry.value.count == 1 { result[entry.key] = entry.value[0] }
        }
    }

    public init(works: [ClientWork], tasks: [ClientTask], sessions: [ClientSession]) {
        self.init(
            works: works.map { Work(id: $0.id, name: $0.name) },
            tasks: tasks.map { Task(id: $0.id, title: $0.title, workID: $0.workId) },
            sessions: sessions.map { Session(id: $0.id, workID: $0.workId, taskID: $0.taskId) }
        )
    }

    public func context(forSessionID sessionID: String?) -> NotificationResourceContext {
        guard let sessionID else { return NotificationResourceContext() }
        let session = sessionsByID[sessionID] ?? uniqueSessionsByAlias[Self.alias(for: sessionID)]
        guard let session else { return NotificationResourceContext() }
        let task = session.taskID.flatMap { tasksByID[$0] }
        let workID = task?.workID ?? session.workID
        return NotificationResourceContext(
            workName: workID.flatMap { worksByID[$0]?.name },
            taskTitle: task?.title
        )
    }

    private static func alias(for sessionID: String) -> String {
        let parts = sessionID.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        return parts.count == 2 ? String(parts[1]) : sessionID
    }
}
