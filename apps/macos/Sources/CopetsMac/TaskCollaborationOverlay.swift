import SwiftUI

struct TaskCardAnchors: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] { [:] }
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

struct TaskCollaborationFlowEvent: Decodable {
    let messageId: String
    let channelId: String
    let senderSessionId: String
    let createdAt: String
    struct Envelope: Decodable {
        let payload: Payload
        struct Payload: Decodable { let message: TaskCollaborationFlowEvent }
    }
}

struct TaskCollaborationEdge: Decodable, Equatable, Identifiable {
    let id: String
    let sourceTaskId: String
    let targetTaskId: String
    let sourceSessionId: String
    let targetSessionId: String
    struct Response: Decodable { let edges: [TaskCollaborationEdge] }
}

/// One drawing surface; neither messages nor animation ticks invalidate Task cards.
struct TaskCollaborationOverlay: View {
    let anchors: [String: Anchor<CGRect>]
    let active: Bool
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var edges: [TaskCollaborationEdge] = []
    @State private var pulses: [String: Pulse] = [:]
    @State private var seen: [String] = []
    @State private var enteredAt = Date()
    @State private var refreshing = false
    private struct Pulse { let date: Date; let reverse: Bool }

    var body: some View {
        GeometryReader { geometry in
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: pulses.isEmpty || reduceMotion || !active || scenePhase != .active)) { timeline in
                Canvas { context, _ in
                    var pairs = Set<String>()
                    for edge in edges {
                        guard let a = anchors[edge.sourceTaskId], let b = anchors[edge.targetTaskId] else { continue }
                        let pair = [edge.sourceTaskId, edge.targetTaskId].sorted().joined(separator: "|")
                        let startRect = geometry[a], endRect = geometry[b]
                        let goesRight = startRect.midX <= endRect.midX
                        let start = CGPoint(x: goesRight ? startRect.maxX : startRect.minX, y: startRect.midY)
                        let end = CGPoint(x: goesRight ? endRect.minX : endRect.maxX, y: endRect.midY)
                        let bend = max(24, abs(end.x - start.x) / 2)
                        let c1 = CGPoint(x: start.x + (goesRight ? bend : -bend), y: start.y)
                        let c2 = CGPoint(x: end.x + (goesRight ? -bend : bend), y: end.y)
                        var path = Path(); path.move(to: start)
                        path.addCurve(to: end, control1: c1, control2: c2)
                        if pairs.insert(pair).inserted {
                            context.stroke(path, with: .color(.accentColor.opacity(0.32)), lineWidth: 1.5)
                        }
                        if let pulse = pulses[edge.id], !reduceMotion {
                            let elapsed = timeline.date.timeIntervalSince(pulse.date) / 1.2
                            if elapsed >= 0 && elapsed < 1 {
                                let t = CGFloat(pulse.reverse ? 1 - elapsed : elapsed)
                                let u = 1 - t
                                let weights: [CGFloat] = [u*u*u, 3*u*u*t, 3*u*t*t, t*t*t]
                                let points = [start, c1, c2, end]
                                let x = zip(weights, points).reduce(CGFloat(0)) { $0 + $1.0 * $1.1.x }
                                let y = zip(weights, points).reduce(CGFloat(0)) { $0 + $1.0 * $1.1.y }
                                let point = CGPoint(x: x, y: y)
                                context.fill(Path(ellipseIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)), with: .color(.green))
                            }
                        }
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task(id: active && scenePhase == .active) {
            pulses = [:]; enteredAt = Date()
            guard active && scenePhase == .active else { return }
            // Snapshot repairs revocations/reconnections; never replays message history.
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
            }
        }
        .onReceive(backendClient.collaborationFlowEvents) { event in
            guard active, scenePhase == .active, !reduceMotion, !seen.contains(event.messageId) else { return }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = formatter.date(from: event.createdAt), date >= enteredAt else { return }
            seen.append(event.messageId); seen = Array(seen.suffix(128))
            guard pulses[event.channelId] == nil else { return }
            Task {
                if !edges.contains(where: { $0.id == event.channelId }) { await refresh() }
                guard active, scenePhase == .active, !reduceMotion,
                      let edge = edges.first(where: { $0.id == event.channelId }),
                      anchors[edge.sourceTaskId] != nil, anchors[edge.targetTaskId] != nil else { return }
                let now = Date()
                pulses[edge.id] = Pulse(date: now, reverse: event.senderSessionId != edge.sourceSessionId)
                try? await Task.sleep(for: .seconds(1.3))
                if pulses[edge.id]?.date == now { pulses.removeValue(forKey: edge.id) }
            }
        }
    }

    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let url = CorptieAppEnvironment.backendBaseURL.appending(path: "collaboration/task-edges")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200, !Task.isCancelled else { return }
            let next = try JSONDecoder().decode(TaskCollaborationEdge.Response.self, from: data).edges
            if next != edges { edges = next }
        } catch { /* Retain last known projection on a transient transport failure. */ }
    }
}
