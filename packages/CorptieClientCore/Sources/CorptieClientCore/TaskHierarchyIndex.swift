import Foundation

/// A single O(n) projection per inventory change. Never scans a whole Work in
/// each row body and never treats unloaded children as a server-side count.
public struct TaskHierarchyIndex: Sendable {
    public static func visibleOrder(nodes: [Node], expanded: Set<String>) -> [String] {
        let index=TaskHierarchyIndex(nodes:nodes)
        var result:[String]=[]
        var seen = Set<String>()
        for node in nodes where node.parentTaskId == nil && !index.invalidNodeIDs.contains(node.id) {
            guard seen.insert(node.id).inserted else { continue }
            result.append(node.id)
            if expanded.contains(node.id) { result.append(contentsOf:index.childrenByParentID[node.id] ?? []) }
        }
        return result
    }
    public struct Node: Sendable, Equatable {
        public let id: String
        public let workId: String
        public let parentTaskId: String?

        public init(id: String, workId: String, parentTaskId: String?) {
            self.id = id; self.workId = workId; self.parentTaskId = parentTaskId
        }
    }
    public private(set) var rootIDsByWork: [String: [String]] = [:]
    public private(set) var childrenByParentID: [String: [String]] = [:]
    public private(set) var parentByTaskID: [String: String] = [:]
    public private(set) var unresolvedParentIDs: Set<String> = []
    public private(set) var invalidNodeIDs: Set<String> = []

    public init(nodes: [Node], ancestors: [Node] = []) {
        var byID: [String: Node] = [:]
        var order: [String] = []
        for node in nodes + ancestors {
            if let prior = byID[node.id] {
                if prior != node { invalidNodeIDs.insert(node.id) }
                continue
            }
            byID[node.id] = node
            order.append(node.id)
        }
        for id in order {
            guard let node = byID[id], !invalidNodeIDs.contains(id) else { continue }
            guard let parentID = node.parentTaskId else {
                rootIDsByWork[node.workId, default: []].append(id)
                continue
            }
            parentByTaskID[id] = parentID
            guard let parent = byID[parentID] else {
                unresolvedParentIDs.insert(parentID)
                continue
            }
            guard id != parentID, parent.workId == node.workId,
                  parent.parentTaskId == nil, !invalidNodeIDs.contains(parentID) else {
                invalidNodeIDs.insert(id)
                continue
            }
            childrenByParentID[parentID, default: []].append(id)
        }
    }
}
