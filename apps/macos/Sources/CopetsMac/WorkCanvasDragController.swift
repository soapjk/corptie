import SwiftUI
import Observation

@Observable @MainActor
final class WorkCanvasCardMotion {
    var offset = CGSize.zero
}

/// Only the grabbed card moves during dragging. Resolve once on drop, then
/// animate with SwiftUI. There is no physics world or per-frame clock.
@Observable @MainActor
final class WorkCanvasDragController {
    private(set) var activeID: String?
    private(set) var snapshot: [String: CGRect] = [:]
    @ObservationIgnored private var motions: [String: WorkCanvasCardMotion] = [:]
    @ObservationIgnored private var current: [String: CGRect] = [:]
    @ObservationIgnored private var completion: (([String: CGRect]) -> Void)?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var reducedMotion = false

    func motion(for id: String) -> WorkCanvasCardMotion {
        if let motion = motions[id] { return motion }
        let motion = WorkCanvasCardMotion()
        motions[id] = motion
        return motion
    }

    @discardableResult
    func begin(id: String, frames: [String: CGRect], reducedMotion: Bool = false) -> Bool {
        var initial = frames
        if activeID != nil {
            guard completion != nil else { return false }
            initial = current
            commit()
        }
        guard initial[id] != nil else { return false }
        current = initial
        snapshot = initial
        activeID = id
        generation = UUID()
        self.reducedMotion = reducedMotion
        motions = motions.filter { initial[$0.key] != nil }
        return true
    }

    func update(id: String, translation: CGSize) {
        guard activeID == id, completion == nil, let home = snapshot[id],
              translation.width.isFinite, translation.height.isFinite else { return }
        let target = FreeWorkCanvasGeometry.moved(home.origin, by: translation)
        current[id] = CGRect(origin: target, size: home.size)
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            motion(for: id).offset = CGSize(width: target.x - home.minX, height: target.y - home.minY)
        }
    }

    static func landingFrames(_ frames: [String: CGRect], active: String) -> [String: CGRect] {
        guard frames[active] != nil else { return frames }
        // The dropped card owns its exact free coordinate. Reuse the existing
        // deterministic canvas collision layout for other cards.
        let ids = [active] + frames.keys.filter { $0 != active }.sorted {
            let a = frames[$0]!, b = frames[$1]!
            return a.minY == b.minY ? $0 < $1 : a.minY < b.minY
        }
        let items = ids.map { WorkPackingEngine.Item(id: $0, size: frames[$0]!.size) }
        let resolved = FreeWorkCanvasGeometry.frames(items: items, positions: frames.mapValues(\.origin), initialWidth: 1)
        return Dictionary(uniqueKeysWithValues: zip(ids, resolved))
    }

    func finish(id: String, onSettled: @escaping ([String: CGRect]) -> Void) {
        guard activeID == id, completion == nil else { return }
        completion = onSettled
        let resolved = Self.landingFrames(current, active: id)
        let changed = resolved != current
        current = resolved
        guard changed, !reducedMotion else { commit(); return }
        let token = generation
        withAnimation(.easeOut(duration: 0.18), completionCriteria: .removed) {
            for (key, frame) in resolved {
                guard let home = snapshot[key] else { continue }
                motion(for: key).offset = CGSize(width: frame.minX - home.minX, height: frame.minY - home.minY)
            }
        } completion: { [weak self] in
            guard let self, self.generation == token else { return }
            self.commit()
        }
    }

    private func commit() {
        let result = current
        let callback = completion
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            cancel()
            callback?(result)
        }
    }

    func cancel() {
        generation = UUID()
        completion = nil
        for motion in motions.values where motion.offset != .zero { motion.offset = .zero }
        activeID = nil
        snapshot = [:]
        current = [:]
    }
}

struct WorkCanvasMotionModifier: ViewModifier {
    let motion: WorkCanvasCardMotion
    let frozenSize: CGSize?

    func body(content: Content) -> some View {
        content
            .frame(width: frozenSize?.width, height: frozenSize?.height, alignment: .topLeading)
            .clipped()
            .offset(motion.offset)
    }
}
