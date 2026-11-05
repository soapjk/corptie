import Foundation

/// A single O(n) projection per inventory change. Never scans a whole Work in
/// each row body and never treats unloaded children as a server-side count.
public struct TaskHierarchyIndex: Sendable {
    public static func visibleOrder(nodes: [Node], expanded: Set<String>) -> [String] {
        let index=TaskHierarchyIndex(nodes:nodes)
        var result:[String]=[]
        var seen = Set<String>()
        var stack = nodes.filter { $0.parentTaskId == nil && !index.invalidNodeIDs.contains($0.id) }.map(\.id).reversed().map { $0 }
        while let id = stack.popLast() {
            guard seen.insert(id).inserted else { continue }
            result.append(id)
            if expanded.contains(id) { stack.append(contentsOf: (index.childrenByParentID[id] ?? []).reversed()) }
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
    public private(set) var depthByTaskID: [String: Int] = [:]
    public private(set) var rootByTaskID: [String: String] = [:]

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
                  !invalidNodeIDs.contains(parentID) else {
                invalidNodeIDs.insert(id)
                continue
            }
            childrenByParentID[parentID, default: []].append(id)
        }
        // Resolve each chain once. Invalid cycles and cross-Work edges never
        // masquerade as roots, and depth lookups in a row stay O(1).
        for id in order where depthByTaskID[id] == nil && !invalidNodeIDs.contains(id) {
            var path: [String] = []
            var visiting = Set<String>()
            var cursor = id
            var baseDepth = -1
            var root = cursor
            var valid = true
            var unresolved = false
            while depthByTaskID[cursor] == nil {
                guard !invalidNodeIDs.contains(cursor), visiting.insert(cursor).inserted,
                      let node = byID[cursor] else { valid = false; break }
                path.append(cursor)
                guard let parentID = node.parentTaskId else { root = cursor; break }
                guard let parent = byID[parentID] else { unresolved = true; valid = false; break }
                guard parent.workId == node.workId else { valid = false; break }
                cursor = parentID
            }
            if let known = depthByTaskID[cursor] { baseDepth = known; root = rootByTaskID[cursor] ?? cursor }
            if valid {
                for member in path.reversed() { baseDepth += 1; depthByTaskID[member] = baseDepth; rootByTaskID[member] = root }
            } else if !unresolved { invalidNodeIDs.formUnion(path) }
        }
        for (parent, children) in childrenByParentID {
            childrenByParentID[parent] = children.filter { !invalidNodeIDs.contains($0) }
        }

    }
}
