import SwiftUI

/// Local presentation preference, independent of Session pinning and Task lifecycle.
@MainActor
final class TaskCardDisplayPreferences: ObservableObject {
    static let shared = TaskCardDisplayPreferences(defaults: CorptieAppEnvironment.userDefaults)
    static let key = "console.taskCards.fixedDisplay.v1"
    @Published private(set) var taskIDs: Set<String>
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
        taskIDs = Set(defaults.stringArray(forKey: Self.key) ?? [])
    }

    func setFixed(_ fixed: Bool, taskID: String) {
        guard taskIDs.contains(taskID) != fixed else { return }
        var next = taskIDs
        if fixed { next.insert(taskID) } else { next.remove(taskID) }
        defaults.set(next.sorted(), forKey: Self.key)
        taskIDs = next
    }
}

struct TaskFixedDisplayMenuItem: View {
    @ObservedObject private var preferences = TaskCardDisplayPreferences.shared
    let task: CorptieTask

    var body: some View {
        let fixed = preferences.taskIDs.contains(task.id)
        Button(fixed ? "取消固定展示" : "固定展示", systemImage: fixed ? "bookmark.slash" : "bookmark") {
            preferences.setFixed(!fixed, taskID: task.id)
        }
        .disabled(task.deletionStatus != nil || (task.archived == true && !fixed))
        .help("在本机实验卡片面板中持续展示，不受是否需要介入影响。")
    }
}
