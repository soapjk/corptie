import SwiftUI

enum BackgroundTaskState: Equatable {
    case running
    case succeeded
    case failed
}

struct BackgroundTaskRecord: Identifiable, Equatable {
    let id: String
    let title: String
    var state: BackgroundTaskState
    var detail: String
}

enum BackgroundTaskOutcome: Equatable {
    case success(String)
    case failure(String)
}

/// Owns user-initiated work that must outlive its presenting sheet.
///
/// A caller-supplied stable ID is both the UI identity and the duplicate-submission
/// guard. Failed operations retain their closure so the global status panel can
/// retry the exact same request rather than reconstructing input from a dismissed
/// form.
@MainActor
final class BackgroundTaskCenter: ObservableObject {
    typealias Operation = @MainActor () async -> BackgroundTaskOutcome

    static let shared = BackgroundTaskCenter()
    static let backendConnectionTaskID = "backend.connection"
    static let defaultSuccessVisibilityDuration: Duration = .seconds(3)

    @Published private(set) var records: [BackgroundTaskRecord] = []
    private var operations: [String: Operation] = [:]
    private var successfulDismissalTasks: [String: Task<Void, Never>] = [:]
    private let successVisibilityDuration: Duration

    init(successVisibilityDuration: Duration = defaultSuccessVisibilityDuration) {
        self.successVisibilityDuration = successVisibilityDuration
    }

    @discardableResult
    func start(id: String, title: String, operation: @escaping Operation) -> Bool {
        guard records.first(where: { $0.id == id }) == nil else { return false }
        successfulDismissalTasks[id]?.cancel()
        successfulDismissalTasks[id] = nil
        operations[id] = operation
        records.insert(
            BackgroundTaskRecord(id: id, title: title, state: .running, detail: L10n("正在后台执行…")),
            at: 0
        )
        run(id: id)
        return true
    }

    @discardableResult
    func retry(id: String) -> Bool {
        guard let index = records.firstIndex(where: { $0.id == id }),
              records[index].state == .failed,
              operations[id] != nil else { return false }
        successfulDismissalTasks[id]?.cancel()
        successfulDismissalTasks[id] = nil
        records[index].state = .running
        records[index].detail = L10n("正在重试…")
        run(id: id)
        return true
    }

    func dismiss(id: String) {
        guard let record = records.first(where: { $0.id == id }), record.state != .running else { return }
        successfulDismissalTasks[id]?.cancel()
        successfulDismissalTasks[id] = nil
        records.removeAll(where: { $0.id == id })
        operations[id] = nil
    }

    /// Reconciles a task whose authoritative state completed outside its
    /// original operation. Backend startup is the primary case: a cold launch
    /// may outlive the initial observation window, but a later successful sync
    /// must replace the stale failure shown in the global status bar.
    @discardableResult
    func completeSuccessfully(id: String, detail: String) -> Bool {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return false }
        records[index].state = .succeeded
        records[index].detail = detail
        operations[id] = nil
        scheduleSuccessfulDismissal(id: id)
        return true
    }

    private func run(id: String) {
        guard let operation = operations[id] else { return }
        Task { @MainActor [weak self] in
            let outcome = await operation()
            guard let self,
                  let index = self.records.firstIndex(where: { $0.id == id }),
                  self.records[index].state == .running else { return }
            switch outcome {
            case .success(let detail):
                self.records[index].state = .succeeded
                self.records[index].detail = detail
                self.operations[id] = nil
                self.scheduleSuccessfulDismissal(id: id)
            case .failure(let detail):
                self.successfulDismissalTasks[id]?.cancel()
                self.successfulDismissalTasks[id] = nil
                self.records[index].state = .failed
                self.records[index].detail = detail
            }
        }
    }

    private func scheduleSuccessfulDismissal(id: String) {
        successfulDismissalTasks[id]?.cancel()
        let delay = successVisibilityDuration
        successfulDismissalTasks[id] = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            guard let self,
                  self.records.first(where: { $0.id == id })?.state == .succeeded else { return }
            self.records.removeAll(where: { $0.id == id })
            self.operations[id] = nil
            self.successfulDismissalTasks[id] = nil
        }
    }
}

/// Adapts the app's authoritative backend reachability to a retryable entry in
/// the global background-task panel. The first run only observes the startup
/// flow that is already in progress; later runs actively request a fresh state
/// snapshot before waiting, so launch does not issue duplicate probes.
@MainActor
final class BackendConnectionStatusOperation {
    typealias IsConnected = @MainActor () -> Bool
    typealias ErrorMessage = @MainActor () -> String?
    typealias RetryConnection = @MainActor () async -> Void

    private let timeout: Duration
    private let pollInterval: Duration
    private let isConnected: IsConnected
    private let errorMessage: ErrorMessage
    private let retryConnection: RetryConnection
    private var attemptCount = 0

    init(
        timeout: Duration = .seconds(60),
        pollInterval: Duration = .milliseconds(100),
        isConnected: @escaping IsConnected,
        errorMessage: @escaping ErrorMessage,
        retryConnection: @escaping RetryConnection
    ) {
        self.timeout = timeout
        self.pollInterval = pollInterval
        self.isConnected = isConnected
        self.errorMessage = errorMessage
        self.retryConnection = retryConnection
    }

    func run() async -> BackgroundTaskOutcome {
        attemptCount += 1
        if attemptCount > 1 {
            await retryConnection()
        }

        let deadline = ContinuousClock.now + timeout
        while !isConnected(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: pollInterval)
        }

        if isConnected() {
            return .success(L10n("Connected to the server"))
        }

        if let reason = errorMessage()?.trimmingCharacters(in: .whitespacesAndNewlines),
           !reason.isEmpty {
            return .failure(L10nFormat(
                "Could not connect to the server: %@ Check that the server is running, then retry.",
                reason
            ))
        }
        return .failure(L10n("Could not connect to the server. Check that the server is running, then retry."))
    }
}

struct BackgroundTaskStatusBar: View {
    static let actionHitSize = CGSize(width: 24, height: 22)

    @ObservedObject var center: BackgroundTaskCenter

    var body: some View {
        if let record = featuredRecord {
            HStack(spacing: 4) {
                HStack(spacing: 5) {
                    statusIcon(record.state)
                        .frame(width: 14, height: 14)

                    Text(record.title)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .layoutPriority(1)

                    if center.records.count > 1 {
                        Text("+\(center.records.count - 1)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(record.title)
                .accessibilityValue(record.detail)

                if record.state == .failed {
                    Button {
                        center.retry(id: record.id)
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .medium))
                            .frame(
                                width: Self.actionHitSize.width,
                                height: Self.actionHitSize.height
                            )
                            .background(
                                Color.primary.opacity(0.055),
                                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(L10n("重试"))
                    .accessibilityLabel(L10n("重试"))
                }

                if record.state != .running {
                    Button {
                        center.dismiss(id: record.id)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .semibold))
                            .frame(
                                width: Self.actionHitSize.width,
                                height: Self.actionHitSize.height
                            )
                            .background(
                                Color.primary.opacity(0.055),
                                in: Circle()
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(L10n("关闭"))
                    .accessibilityLabel(L10n("关闭"))
                }
            }
            .fixedSize(horizontal: true, vertical: false)
            .help("\(record.title)\n\(record.detail)")
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("background-task.\(record.id)")
        }
    }

    /// Keep active work visible first, then failures that need attention, then
    /// the newest completed item. This stays useful without expanding into a
    /// notification stack over the window content.
    private var featuredRecord: BackgroundTaskRecord? {
        center.records.first(where: { $0.state == .running })
            ?? center.records.first(where: { $0.state == .failed })
            ?? center.records.first
    }

    @ViewBuilder
    private func statusIcon(_ state: BackgroundTaskState) -> some View {
        switch state {
        case .running:
            ProgressView().controlSize(.mini)
        case .succeeded:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.red)
        }
    }
}
