import AppKit
import Combine
import SwiftUI

@MainActor
final class DetachedSessionManager: ObservableObject {
    private static let orbWindowSize = NSSize(width: 88, height: 88)

    private let client: BackendClient
    private let openSession: (TaskSession) -> Void
    private let showMain: () -> Void
    private let isMainVisible: () -> Bool
    private var controllers: [String: DetachedSessionWindowController] = [:]
    private var avoidanceLoopTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    init(
        client: BackendClient,
        showMain: @escaping () -> Void,
        isMainVisible: @escaping () -> Bool,
        openSession: @escaping (TaskSession) -> Void
    ) {
        self.client = client
        self.showMain = showMain
        self.isMainVisible = isMainVisible
        self.openSession = openSession

        client.sessionReplacements
            .sink { [weak self] replacement in
                self?.rebindFloatingSession(replacement)
            }
            .store(in: &cancellables)
    }

    func float(session: TaskSession) {
        float(session: session, initialOrigin: nil)
    }

    private func float(session: TaskSession, initialOrigin preservedOrigin: NSPoint?) {
        let id = session.id
        if let controller = controllers[id] {
            controller.show()
            return
        }

        let targetScreen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        let visibleFrame = targetScreen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let initialOrigin = preservedOrigin ?? DetachedOrbPlacementGeometry.origin(
            visibleFrame: visibleFrame,
            windowSize: Self.orbWindowSize,
            occupiedFrames: controllers.values.map(\.frame)
        )
        let controller = DetachedSessionWindowController(
            sessionId: id,
            initialOrigin: initialOrigin,
            client: client,
            occupiedFrames: { [weak self] excludingSessionId in
                self?.controllers.compactMap { sessionId, controller in
                    sessionId == excludingSessionId ? nil : controller.frame
                } ?? []
            },
            showMain: { [weak self] in
                self?.showMain()
            },
            isMainVisible: { [weak self] in
                self?.isMainVisible() ?? false
            },
            openSession: { [weak self] session in
                self?.openSession(session)
            },
            close: { [weak self] sessionId in
                self?.controllers[sessionId] = nil
                self?.stopAvoidanceLoopIfIdle()
            },
            requestBatchObservation: { [weak self] in
                self?.ensureAvoidanceLoop()
            }
        )
        controllers[id] = controller
        controller.show()
        ensureAvoidanceLoop()
    }

    private func rebindFloatingSession(_ replacement: SessionReplacement) {
        guard DetachedSessionReplacementLogic.shouldRebind(
            previousSessionId: replacement.previousSessionId,
            replacementSessionId: replacement.session.id,
            floatingSessionIds: Set(controllers.keys)
        ), let previousController = controllers.removeValue(forKey: replacement.previousSessionId) else {
            return
        }

        let preservedOrigin = previousController.frame.origin
        previousController.close()
        float(session: replacement.session, initialOrigin: preservedOrigin)
    }

    func floatForMainWindowCloseIfNeeded(session: TaskSession) {
        guard DetachedSessionCloseBehavior.shouldCreateOrb(
            status: session.status,
            isAlreadyFloating: controllers[session.id] != nil
        ) else {
            return
        }
        float(session: session)
    }

    func close(sessionId: String) {
        controllers[sessionId]?.close()
        controllers[sessionId] = nil
        stopAvoidanceLoopIfIdle()
    }

    func closeAll() {
        for controller in controllers.values {
            controller.close()
        }
        controllers.removeAll()
        avoidanceLoopTask?.cancel()
        avoidanceLoopTask = nil
    }

    private func ensureAvoidanceLoop() {
        guard avoidanceLoopTask == nil, !controllers.isEmpty else {
            return
        }
        avoidanceLoopTask = Task { [weak self] in
            guard let self else {
                return
            }
            var cadence = DetachedOrbObservationCadence()
            var delay = cadence.activeInterval
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(delay))
                    try Task.checkCancellation()
                } catch {
                    return
                }
                let batchStartedAt = Date()
                let outcome = await self.runAvoidanceBatch()
                let interval = cadence.nextInterval(after: outcome)
                self.logDevelopment(
                    "[orb-avoidance] cadence outcome=\(outcome) interval=\(interval)"
                )
                delay = DetachedOrbBatchCoordinatorLogic.nextDelay(
                    interval: interval,
                    batchDuration: Date().timeIntervalSince(batchStartedAt)
                )
            }
        }
    }

    private func stopAvoidanceLoopIfIdle() {
        guard controllers.isEmpty else {
            return
        }
        avoidanceLoopTask?.cancel()
        avoidanceLoopTask = nil
    }

    private func runAvoidanceBatch() async -> DetachedOrbBatchOutcome {
        guard DetachedOrbSmartAvoidancePreferences.shared.canCapture else {
            return .idle
        }
        let batchControllers = controllers
            .sorted { $0.key < $1.key }
            .map(\.value)
        guard !batchControllers.isEmpty else {
            return .idle
        }
        logDevelopment("[orb-avoidance] batch_started orbs=\(batchControllers.count)")

        var pendingObservations: [DetachedOrbPendingObservation] = []
        pendingObservations.reserveCapacity(batchControllers.count)
        for controller in batchControllers {
            guard controllers[controller.sessionId] === controller,
                  let request = controller.makeBatchObservationRequest() else {
                continue
            }
            pendingObservations.append(
                DetachedOrbPendingObservation(controller: controller, request: request)
            )
        }
        let hasSkippedControllers = pendingObservations.count < batchControllers.count
        guard !pendingObservations.isEmpty else {
            return .active
        }

        var evaluations: [DetachedOrbBatchEvaluation] = []
        evaluations.reserveCapacity(pendingObservations.count)
        var hasIncompleteEvaluation = false
        var hasCaptureFailure = false
        let observationsByDisplay = Dictionary(
            grouping: pendingObservations,
            by: { $0.request.target.displayID }
        )
        logDevelopment(
            "[orb-avoidance] batch_captures displays=\(observationsByDisplay.count) "
                + "requests=\(pendingObservations.count)"
        )
        for displayID in observationsByDisplay.keys.sorted() {
            guard let displayObservations = observationsByDisplay[displayID],
                  let firstObservation = displayObservations.first else {
                continue
            }
            let sharedSampleRect = displayObservations.reduce(CGRect.null) {
                $0.union($1.request.target.sampleRect)
            }
            let sharedTarget = ScreenContentCaptureTarget(
                displayID: displayID,
                screenFrame: firstObservation.request.target.screenFrame,
                sampleRect: sharedSampleRect,
                maximumOutputDimension:
                    DetachedOrbBatchCoordinatorLogic.sharedCaptureMaximumDimension(
                        sharedSampleRect: sharedSampleRect,
                        individualSampleRects: displayObservations.map {
                            $0.request.target.sampleRect
                        }
                    )
            )
            let sharedRegions = displayObservations.flatMap(\.request.regions)
            do {
                let observation = try await ScreenContentSampler.shared.analyze(
                    target: sharedTarget,
                    regions: sharedRegions
                )
                try Task.checkCancellation()
                var regionOffset = 0
                for pendingObservation in displayObservations {
                    let controller = pendingObservation.controller
                    let request = pendingObservation.request
                    let regionEnd = regionOffset + request.regions.count
                    guard regionEnd <= observation.regions.count else {
                        controller.noteBatchAnalysisFailure(
                            ScreenContentSamplerError.pixelConversionFailed
                        )
                        hasIncompleteEvaluation = true
                        break
                    }
                    let controllerObservation = ScreenContentAnalysisObservation(
                        sourceRect: observation.sourceRect,
                        pixelWidth: observation.pixelWidth,
                        pixelHeight: observation.pixelHeight,
                        durationMilliseconds: observation.durationMilliseconds,
                        regions: Array(observation.regions[regionOffset..<regionEnd])
                    )
                    regionOffset = regionEnd
                    guard controllers[controller.sessionId] === controller,
                          let evaluation = controller.evaluateBatchObservation(
                            controllerObservation,
                            request: request
                          ) else {
                        hasIncompleteEvaluation = true
                        continue
                    }
                    evaluations.append(evaluation)
                }
            } catch is CancellationError {
                return .idle
            } catch {
                for pendingObservation in displayObservations {
                    pendingObservation.controller.noteBatchAnalysisFailure(error)
                }
                hasIncompleteEvaluation = true
                hasCaptureFailure = true
            }
        }

        guard DetachedOrbBatchCoordinatorLogic.canCommitBatch(
            evaluatedCount: evaluations.count,
            expectedCount: pendingObservations.count,
            hasIncompleteEvaluation: hasIncompleteEvaluation
        ) else {
            logDevelopment(
                "[orb-avoidance] batch_aborted reason=incomplete_evaluation "
                    + "evaluated=\(evaluations.count) expected=\(pendingObservations.count)"
            )
            return hasCaptureFailure ? .captureFailure : .active
        }

        var reservedDestinationFrames: [CGRect] = []
        var moves: [DetachedOrbBatchMove] = []
        let evaluationsByIdentifier = Dictionary(
            uniqueKeysWithValues: evaluations.map { ($0.controller.sessionId, $0) }
        )
        let orderedIdentifiers = DetachedOrbBatchCoordinatorLogic.orderedIdentifiers(
            evaluations.map {
                DetachedOrbBatchPriority(
                    identifier: $0.controller.sessionId,
                    currentRisk: $0.currentRisk
                )
            }
        )
        for identifier in orderedIdentifiers {
            guard let evaluation = evaluationsByIdentifier[identifier] else {
                continue
            }
            let plan = evaluation.controller.planBatchMove(
                evaluation,
                additionalOccupiedFrames: reservedDestinationFrames
            )
            if let move = evaluation.controller.acceptBatchPlan(
                plan,
                evaluation: evaluation
            ) {
                reservedDestinationFrames.append(move.destinationFrame)
                moves.append(move)
            }
        }
        logDevelopment(
            "[orb-avoidance] batch_planned evaluated=\(evaluations.count) moves=\(moves.count)"
        )
        moveTogether(moves)
        return hasSkippedControllers
            || !moves.isEmpty
            || evaluations.contains(where: \.isCurrentPositionRisky)
            ? .active
            : .stable
    }

    private func moveTogether(_ moves: [DetachedOrbBatchMove]) {
        guard !moves.isEmpty else {
            return
        }
        let animation = DetachedOrbTeleportAnimation.configuration(
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        )
        for move in moves {
            move.controller.prepareBatchMove(move)
        }
        beginBatchMoveDisappearance(moves, animation: animation)

        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(animation.disappearDuration))
            guard let self else {
                return
            }
            let continuingMoves = moves.filter {
                self.controllers[$0.controller.sessionId] === $0.controller
                    && $0.controller.canContinueBatchMove($0)
            }
            for move in continuingMoves {
                move.controller.teleportBatchMove(move)
            }
            self.beginBatchMoveAppearance(continuingMoves, animation: animation)

            try? await Task.sleep(for: .seconds(animation.appearDuration))
            let appearingMoves = continuingMoves.filter {
                self.controllers[$0.controller.sessionId] === $0.controller
                    && $0.controller.canContinueBatchMove($0)
            }
            for move in appearingMoves {
                move.controller.settleBatchMoveAppearance(
                    move,
                    animation: animation
                )
            }

            if animation.settleDuration > 0 {
                try? await Task.sleep(for: .seconds(animation.settleDuration))
            }
            for move in appearingMoves where self.controllers[move.controller.sessionId]
                === move.controller && move.controller.canContinueBatchMove(move) {
                move.controller.finishBatchMove(move)
            }
            for move in moves where !move.controller.canContinueBatchMove(move) {
                if self.controllers[move.controller.sessionId] === move.controller {
                    move.controller.restoreBatchMoveAppearanceIfNeeded()
                }
            }
        }
    }

    private func beginBatchMoveDisappearance(
        _ moves: [DetachedOrbBatchMove],
        animation: DetachedOrbTeleportAnimation
    ) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = animation.disappearDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            for move in moves {
                move.controller.beginBatchMoveDisappearance(
                    move,
                    animation: animation
                )
            }
        }
    }

    private func beginBatchMoveAppearance(
        _ moves: [DetachedOrbBatchMove],
        animation: DetachedOrbTeleportAnimation
    ) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = animation.appearDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for move in moves {
                move.controller.beginBatchMoveAppearance(
                    move,
                    animation: animation
                )
            }
        }
    }

    private func logDevelopment(_ message: @autoclosure () -> String) {
        guard CorptieAppEnvironment.isDevelopment else {
            return
        }
        print(message())
        fflush(stdout)
    }
}

@MainActor
private final class DetachedReplyPreviewState: ObservableObject {
    @Published var text = ""
    @Published var isVisible = false
    @Published var placement = DetachedReplyPlacement.right
    @Published var isQuickReplyVisible = false
    @Published var quickReplyDraft = ""
    @Published var dismissedOptionsFingerprint: String?
    @Published var hoveredOptionId: String?
}

@MainActor
private final class DetachedOrbAnimationState: ObservableObject {
    @Published var scale: CGFloat = 1
}

private enum DetachedReplyPlacement {
    case left
    case right
    case top
    case bottom
}

private func detachedOptionsFingerprint(for session: TaskSession) -> String {
    let summary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
    let prompt = (session.suggestedPrompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let labels = (session.suggestedOptions ?? [])
        .map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
        .joined(separator: "\u{1f}")
    return "\(summary)\u{1e}\(prompt)\u{1e}\(labels)"
}

private final class DetachedSessionPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

private final class DetachedFirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

@MainActor
private final class DetachedAccessoryWindowController {
    private let panel: NSPanel
    private let contentContainer: NSView
    private let hostingView: DetachedFirstMouseHostingView<DetachedSessionAccessoryView>
    private let state: DetachedReplyPreviewState
    private let client: BackendClient
    private let sessionId: String
    private let dismissPreview: () -> Void
    private let dismissQuickReply: () -> Void
    private let didResignKey: () -> Void
    private var resignKeyObserver: NSObjectProtocol?

    private let orbSize: CGFloat = 72
    private let orbHaloPadding: CGFloat = 8
    private let spacing: CGFloat = 5
    private let previewTotalWidth: CGFloat = 324
    private let replyComposerTotalHeight: CGFloat = 194
    private let suggestedPromptTotalHeight: CGFloat = 146
    private let collaborationConfirmationTotalHeight: CGFloat = 276
    private let optionWidth: CGFloat = 246

    init(
        state: DetachedReplyPreviewState,
        client: BackendClient,
        sessionId: String,
        dismissPreview: @escaping () -> Void,
        dismissQuickReply: @escaping () -> Void,
        didResignKey: @escaping () -> Void
    ) {
        self.state = state
        self.client = client
        self.sessionId = sessionId
        self.dismissPreview = dismissPreview
        self.dismissQuickReply = dismissQuickReply
        self.didResignKey = didResignKey
        self.contentContainer = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        self.hostingView = DetachedFirstMouseHostingView(
            rootView: DetachedSessionAccessoryView(
                client: client,
                sessionId: sessionId,
                previewState: state,
                dismissPreview: dismissPreview,
                dismissQuickReply: dismissQuickReply
            )
        )

        self.panel = DetachedSessionPanel(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false

        contentContainer.wantsLayer = true
        contentContainer.layer?.backgroundColor = NSColor.clear.cgColor
        contentContainer.translatesAutoresizingMaskIntoConstraints = true
        hostingView.translatesAutoresizingMaskIntoConstraints = true
        hostingView.autoresizingMask = [.width, .height]
        hostingView.frame = contentContainer.bounds
        contentContainer.addSubview(hostingView)
        panel.contentView = contentContainer
        resignKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.didResignKey()
            }
        }
    }

    func close() {
        if let resignKeyObserver {
            NotificationCenter.default.removeObserver(resignKeyObserver)
            self.resignKeyObserver = nil
        }
        panel.close()
    }

    func orderFront() {
        panel.orderFrontRegardless()
    }

    func update(for session: TaskSession?, orbCenter: NSPoint, screenFrame: NSRect?) {
        let size = accessorySize(for: session)
        guard size.width > 0, size.height > 0 else {
            panel.orderOut(nil)
            return
        }

        let placement = bestPlacement(for: size, orbCenter: orbCenter, screenFrame: screenFrame)
        state.placement = placement
        let frame = accessoryFrame(size: size, placement: placement, orbCenter: orbCenter)
        updateContentSize(size)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            context.allowsImplicitAnimation = false
            panel.setFrame(frame, display: true)
        }
        panel.orderFrontRegardless()
    }

    private func updateContentSize(_ size: NSSize) {
        let bounds = NSRect(origin: .zero, size: size)
        if contentContainer.frame != bounds {
            contentContainer.frame = bounds
        }
        if hostingView.frame != bounds {
            hostingView.frame = bounds
        }
    }

    func makeKeyIfNeeded() {
        guard state.isQuickReplyVisible else {
            return
        }
        panel.makeKeyAndOrderFront(nil)
    }

    var isKeyWindow: Bool {
        panel.isKeyWindow
    }

    var visibleFrame: NSRect? {
        panel.isVisible ? panel.frame : nil
    }

    func contains(window: NSWindow?) -> Bool {
        window === panel
    }

    private func accessorySize(for session: TaskSession?) -> NSSize {
        if session?.pendingCollaborationConfirmation != nil {
            return NSSize(width: previewTotalWidth, height: collaborationConfirmationTotalHeight)
        }
        let hasPreview = state.isVisible && !state.text.isEmpty
        let hasQuickReply = state.isQuickReplyVisible
        let optionCount = min(visibleOptionCount(for: session), 5)
        let hasOptions = optionCount > 0
        let hasSuggestedPrompt = hasOptions && !(session?.suggestedPrompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        let stackHeight = floatingAccessoryHeight(hasPreview: hasPreview, hasQuickReply: hasQuickReply, hasSuggestedPrompt: hasSuggestedPrompt)
        let optionsHeight = hasOptions ? optionAreaHeight(for: session, optionCount: optionCount) : 0
        let width = max(hasPreview || hasQuickReply || hasSuggestedPrompt ? previewTotalWidth : 0, hasOptions ? optionWidth : 0)
        var height = stackHeight
        if hasOptions {
            if height > 0 {
                height += spacing
            }
            height += optionsHeight
        }
        return NSSize(width: width, height: height)
    }

    private func optionAreaHeight(for session: TaskSession?, optionCount: Int) -> CGFloat {
        min(138, CGFloat(optionCount) * 34 + 8)
    }

    private func visibleOptionCount(for session: TaskSession?) -> Int {
        guard let session else {
            return 0
        }
        let options = session.suggestedOptions ?? []
        guard !options.isEmpty else {
            return 0
        }
        if state.dismissedOptionsFingerprint == detachedOptionsFingerprint(for: session) {
            state.hoveredOptionId = nil
            return 0
        }
        return options.count
    }

    private func floatingAccessoryHeight(hasPreview: Bool, hasQuickReply: Bool, hasSuggestedPrompt: Bool) -> CGFloat {
        if hasSuggestedPrompt {
            return suggestedPromptTotalHeight
        }
        if hasPreview && hasQuickReply {
            return replyComposerTotalHeight
        }
        return 0
    }

    private func bestPlacement(for size: NSSize, orbCenter: NSPoint, screenFrame: NSRect?) -> DetachedReplyPlacement {
        guard let screenFrame else {
            return .right
        }
        let candidates: [DetachedReplyPlacement] = [.right, .left, .top, .bottom]
        let scored = candidates.map { placement in
            let frame = accessoryFrame(size: size, placement: placement, orbCenter: orbCenter)
            let visible = frame.intersection(screenFrame.insetBy(dx: 8, dy: 8))
            let visibleArea = visible.isNull ? 0 : visible.width * visible.height
            let ratio = visibleArea / max(1, frame.width * frame.height)
            return (placement, ratio)
        }
        if let exact = scored.first(where: { $0.1 >= 0.999 }) {
            return exact.0
        }
        return scored.max(by: { $0.1 < $1.1 })?.0 ?? .right
    }

    private func accessoryFrame(size: NSSize, placement: DetachedReplyPlacement, orbCenter: NSPoint) -> NSRect {
        let orbRenderSize = orbSize + orbHaloPadding * 2
        switch placement {
        case .right:
            return NSRect(x: orbCenter.x + orbRenderSize / 2 + spacing, y: orbCenter.y + orbRenderSize / 2 - size.height, width: size.width, height: size.height)
        case .left:
            return NSRect(x: orbCenter.x - orbRenderSize / 2 - spacing - size.width, y: orbCenter.y + orbRenderSize / 2 - size.height, width: size.width, height: size.height)
        case .top:
            return NSRect(x: orbCenter.x - size.width / 2, y: orbCenter.y + orbRenderSize / 2 + spacing, width: size.width, height: size.height)
        case .bottom:
            return NSRect(x: orbCenter.x - size.width / 2, y: orbCenter.y - orbRenderSize / 2 - spacing - size.height, width: size.width, height: size.height)
        }
    }
}

@MainActor
private struct DetachedOrbObservationRequest {
    let target: ScreenContentCaptureTarget
    let regions: [ScreenContentAnalysisRegion]
    let currentOrigin: CGPoint
    let userAnchor: CGPoint
    let visibleFrame: CGRect
    let placementFrame: CGRect
    let candidateOrigins: [CGPoint]
    let occupiedFrames: [CGRect]
    let excludedFrames: [CGRect]
}

@MainActor
private struct DetachedOrbPendingObservation {
    let controller: DetachedSessionWindowController
    let request: DetachedOrbObservationRequest
}

private struct DetachedOrbRecentAutomaticPosition {
    let origin: CGPoint
    let date: Date
}

@MainActor
private struct DetachedOrbBatchEvaluation {
    let controller: DetachedSessionWindowController
    let request: DetachedOrbObservationRequest
    let currentRisk: Double
    let currentCaptureConfidence: Double
    let isCurrentPositionRisky: Bool
    let candidates: [OrbPlacementCandidate]
    let recentAutomaticOrigins: [CGPoint]
    let cooldownActive: Bool
    let bestCandidateRisk: Double?
}

@MainActor
private struct DetachedOrbBatchMove {
    let controller: DetachedSessionWindowController
    let origin: CGPoint
    let previousOrigin: CGPoint
    let destinationFrame: CGRect
    let currentRisk: Double
    let candidateRisk: Double
}

@MainActor
private final class DetachedSessionWindowController: NSObject, NSWindowDelegate {
    let sessionId: String
    private let client: BackendClient
    private let occupiedFrames: (String) -> [CGRect]
    private let showMain: () -> Void
    private let isMainVisible: () -> Bool
    private let openSession: (TaskSession) -> Void
    private let closeHandler: (String) -> Void
    private let requestBatchObservation: () -> Void
    private let panel: NSPanel
    private let previewState = DetachedReplyPreviewState()
    private let animationState = DetachedOrbAnimationState()
    private lazy var accessoryController = DetachedAccessoryWindowController(
        state: previewState,
        client: client,
        sessionId: sessionId,
        dismissPreview: { [weak self] in
            self?.hideReplyPreview(markDismissed: true)
            self?.updateAccessory(for: self?.currentSession)
        },
        dismissQuickReply: { [weak self] in
            self?.hideQuickReply()
            self?.updateAccessory(for: self?.currentSession)
        },
        didResignKey: { [weak self] in
            self?.handleAccessoryResignKey()
        }
    )
    private var cancellables = Set<AnyCancellable>()
    private var outsideClickMonitor: Any?
    private var localOutsideClickMonitor: Any?
    private var ignoreOutsideClickUntil = Date.distantPast
    private var lastSummary: String?
    private var lastStatus: TaskStatus?
    private var lastPreviewText: String?
    private var dismissedPreviewText: String?
    private var recentAutomaticPositions: [DetachedOrbRecentAutomaticPosition] = []
    private var luminanceSignatures: [String: OrbLuminanceSignature] = [:]
    private var safeRegionHistory = OrbSafeRegionHistory()
    private var cooldownUntil = Date.distantPast
    private var captureFailureCount = 0
    private var isPointerDown = false
    private var isPointerHovering = false
    private var isMovingAutomatically = false
    private var automaticMoveDestination: CGPoint?
    private var automaticMoveDidTeleport = false
    private var isClosing = false
    private var userSelectedLeftRegion = false

    private let orbSize: CGFloat = 72
    private let orbHaloPadding: CGFloat = 8
    private let automaticMoveCooldown: TimeInterval = 2.5
    private let placementConfiguration = OrbPlacementPlannerConfiguration()

    var frame: NSRect {
        panel.frame
    }

    init(
        sessionId: String,
        initialOrigin: NSPoint,
        client: BackendClient,
        occupiedFrames: @escaping (String) -> [CGRect],
        showMain: @escaping () -> Void,
        isMainVisible: @escaping () -> Bool,
        openSession: @escaping (TaskSession) -> Void,
        close: @escaping (String) -> Void,
        requestBatchObservation: @escaping () -> Void
    ) {
        self.sessionId = sessionId
        self.client = client
        self.occupiedFrames = occupiedFrames
        self.showMain = showMain
        self.isMainVisible = isMainVisible
        self.openSession = openSession
        self.closeHandler = close
        self.requestBatchObservation = requestBatchObservation
        let size = NSSize(width: orbSize + orbHaloPadding * 2, height: orbSize + orbHaloPadding * 2)
        self.panel = DetachedSessionPanel(
            contentRect: NSRect(origin: initialOrigin, size: size),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        super.init()

        if let initialVisibleFrame = panel.screen?.visibleFrame
            ?? NSScreen.screens.first(where: { $0.visibleFrame.intersects(panel.frame) })?.visibleFrame {
            userSelectedLeftRegion = !DetachedOrbPlacementRegion.isFullyInRightThird(
                windowFrame: panel.frame,
                visibleFrame: initialVisibleFrame
            )
        }

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        // DetachedOrbEventLayer owns the complete click-versus-drag gesture.
        // Leaving background dragging enabled gives this transparent event view
        // a second AppKit window mover and makes both implementations fight over
        // the panel origin.
        panel.isMovableByWindowBackground = false
        panel.delegate = self
        panel.contentView = DetachedFirstMouseHostingView(
            rootView: DetachedSessionOrbView(
                client: client,
                sessionId: sessionId,
                previewState: previewState,
                animationState: animationState,
                primaryAction: { [weak self] in
                    self?.showQuickReply()
                },
                showMain: { [weak self] in
                    self?.showMain()
                },
                openSession: { [weak self] session in
                    self?.hideReplyPreview()
                    self?.hideQuickReply()
                    self?.updateAccessory(for: session)
                    self?.openSession(session)
                },
                dismissPreview: { [weak self] in
                    self?.hideReplyPreview(markDismissed: true)
                    self?.updateAccessory(for: self?.currentSession)
                },
                dismissQuickReply: { [weak self] in
                    self?.hideQuickReply()
                    self?.updateAccessory(for: self?.currentSession)
                },
                close: { [weak self] in
                    self?.close()
                },
                interactionBegan: { [weak self] in
                    self?.handlePointerInteractionBegan()
                },
                interactionEnded: { [weak self] didDrag in
                    self?.handlePointerInteractionEnded(didDrag: didDrag)
                },
                hoverChanged: { [weak self] hovering in
                    self?.handleHoverChanged(hovering)
                }
            )
        )

        client.$sessions
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                guard let self else { return }
                let session = sessions.first { $0.id == self.sessionId }
                self.updateReplyPreview(for: session)
                self.updateAccessory(for: session)
                self.scheduleObservationIfNeeded(delay: 1)
            }
            .store(in: &cancellables)

        DetachedOrbSmartAvoidancePreferences.shared.$isEnabled
            .combineLatest(
                DetachedOrbSmartAvoidancePreferences.shared.$permissionStatus,
                DetachedOrbSmartAvoidancePreferences.shared.$isCaptureSuspended
            )
            .receive(on: RunLoop.main)
            .sink { [weak self] isEnabled, permissionStatus, isSuspended in
                guard let self else {
                    return
                }
                if isEnabled, permissionStatus == .authorized, !isSuspended {
                    self.scheduleObservationIfNeeded(delay: 0.4)
                } else {
                    self.safeRegionHistory.reset()
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.invalidatePlacementAndReschedule(delay: 1)
            }
            .store(in: &cancellables)

        NSWorkspace.shared.notificationCenter.publisher(
            for: NSWorkspace.didActivateApplicationNotification
        )
        .merge(with: NSWorkspace.shared.notificationCenter.publisher(
            for: NSWorkspace.activeSpaceDidChangeNotification
        ))
        .receive(on: RunLoop.main)
        .sink { [weak self] _ in
            self?.invalidatePlacementAndReschedule(delay: 0.8)
        }
        .store(in: &cancellables)
    }

    func show() {
        panel.orderFrontRegardless()
        updateAccessory(for: currentSession)
        let preferences = DetachedOrbSmartAvoidancePreferences.shared
        logDevelopment(
            "[orb-avoidance] shown session=\(sessionId) " +
            "enabled=\(preferences.isEnabled) " +
            "permission=\(preferences.permissionStatus) " +
            "suspended=\(preferences.isCaptureSuspended)"
        )
        scheduleObservationIfNeeded(delay: 0.8)
    }

    func close() {
        isClosing = true
        accessoryController.close()
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        isClosing = true
        removeOutsideClickMonitor()
        closeHandler(sessionId)
    }

    func windowDidResignKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            guard !self.panel.isKeyWindow, !self.accessoryController.isKeyWindow else {
                self.updateAccessory(for: self.currentSession)
                return
            }
            self.hideReplyPreview(markDismissed: true)
            self.hideQuickReply()
            self.updateAccessory(for: self.currentSession)
        }
    }

    func windowDidMove(_ notification: Notification) {
        updateAccessory(for: currentSession)
    }

    private func handleAccessoryResignKey() {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }
            guard !self.panel.isKeyWindow, !self.accessoryController.isKeyWindow else {
                self.updateAccessory(for: self.currentSession)
                return
            }
            self.hideReplyPreview(markDismissed: true)
            self.hideQuickReply()
            self.updateAccessory(for: self.currentSession)
        }
    }

    private func showQuickReply() {
        previewState.isQuickReplyVisible = true
        showLatestReplyPreviewIfNeeded()
        ignoreOutsideClickUntil = Date().addingTimeInterval(0.35)
        DispatchQueue.main.async { [weak self] in
            self?.installOutsideClickMonitor()
        }
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        updateAccessory(for: currentSession)
        accessoryController.makeKeyIfNeeded()
    }

    private func hideQuickReply() {
        previewState.isQuickReplyVisible = false
        scheduleObservationIfNeeded(delay: 1)
    }

    private func updateAccessory(for session: TaskSession?) {
        accessoryController.update(for: session, orbCenter: currentOrbCenter, screenFrame: panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame)
    }

    private func scheduleObservationIfNeeded(delay: TimeInterval) {
        guard !isClosing else {
            return
        }
        requestBatchObservation()
    }

    func makeBatchObservationRequest() -> DetachedOrbObservationRequest? {
        let reconciledInteraction = DetachedOrbInteractionRecovery.reconcile(
            reportedPointerDown: isPointerDown,
            reportedPointerHovering: isPointerHovering,
            pressedMouseButtons: NSEvent.pressedMouseButtons,
            mouseLocation: NSEvent.mouseLocation,
            windowFrame: panel.frame
        )
        isPointerDown = reconciledInteraction.isPointerDown
        isPointerHovering = reconciledInteraction.isPointerHovering

        guard !isInteractionFrozen,
              let screen = panel.screen,
              let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
                as? CGDirectDisplayID else {
            return nil
        }

        let currentOrigin = panel.frame.origin
        // Persistent user anchoring is intentionally disabled. Every batch searches
        // from the orb's current position, including after a manual drag.
        let searchOrigin = currentOrigin
        let placementFrame = DetachedOrbPlacementRegion.automaticPlacementFrame(
            in: screen.visibleFrame,
            userSelectedLeftRegion: userSelectedLeftRegion
        )
        let occupied = occupiedFrames(sessionId)
        let excluded = accessoryController.visibleFrame.map { [$0] } ?? []
        let candidates = OrbPlacementPlanner.candidateOrigins(
            currentOrigin: currentOrigin,
            userAnchor: searchOrigin,
            windowSize: panel.frame.size,
            visibleFrame: placementFrame,
            occupiedFrames: occupied,
            excludedFrames: excluded
        )
        guard !candidates.isEmpty else {
            return nil
        }
        let analysisOrigins = DetachedOrbObservationGeometry.analysisOrigins(
            currentOrigin: currentOrigin,
            candidateOrigins: candidates
        )

        let coverage = analysisOrigins.reduce(CGRect.null) { partial, origin in
            partial.union(contentFrame(forPanelOrigin: origin))
        }
        let searchRect = coverage
            .insetBy(dx: -8, dy: -8)
            .intersection(screen.visibleFrame)
        guard !searchRect.isNull, !searchRect.isEmpty else {
            return nil
        }

        let regions = analysisOrigins.map { origin in
            let identifier = Self.originIdentifier(origin)
            return ScreenContentAnalysisRegion(
                identifier: identifier,
                frame: contentFrame(forPanelOrigin: origin),
                previousSignature: luminanceSignatures[identifier]
            )
        }
        return DetachedOrbObservationRequest(
            target: ScreenContentCaptureTarget(
                displayID: displayID,
                screenFrame: screen.frame,
                sampleRect: searchRect
            ),
            regions: regions,
            currentOrigin: currentOrigin,
            userAnchor: searchOrigin,
            visibleFrame: screen.visibleFrame,
            placementFrame: placementFrame,
            candidateOrigins: candidates,
            occupiedFrames: occupied,
            excludedFrames: excluded
        )
    }

    func evaluateBatchObservation(
        _ observation: ScreenContentAnalysisObservation,
        request: DetachedOrbObservationRequest
    ) -> DetachedOrbBatchEvaluation? {
        guard DetachedOrbSmartAvoidancePreferences.shared.canCapture else {
            logInvalidEvaluation("capture_disabled")
            return nil
        }
        guard !isClosing else {
            logInvalidEvaluation("closing")
            return nil
        }
        guard Self.distance(panel.frame.origin, request.currentOrigin) <= 0.5 else {
            logInvalidEvaluation("position_changed")
            return nil
        }
        guard panel.screen?.visibleFrame == request.visibleFrame else {
            logInvalidEvaluation("screen_changed")
            return nil
        }

        var analysesByIdentifier: [String: OrbContentAnalysis] = [:]
        for region in observation.regions {
            analysesByIdentifier[region.identifier] = region.analysis
            if case let .known(_, signature) = region.analysis {
                luminanceSignatures[region.identifier] = signature
            }
        }

        let currentIdentifier = Self.originIdentifier(request.currentOrigin)
        guard let currentAnalysis = analysesByIdentifier[currentIdentifier] else {
            logInvalidEvaluation("current_region_missing")
            return nil
        }
        guard case let .known(currentRisk, _) = currentAnalysis else {
            if case let .unknown(reason) = currentAnalysis {
                logInvalidEvaluation("current_region_\(reason)")
            }
            return nil
        }

        let observationDate = Date()
        safeRegionHistory.prune(at: observationDate)
        let observedCandidates = request.candidateOrigins.compactMap {
            origin -> (origin: CGPoint, risk: OrbContentRisk)? in
            let identifier = Self.originIdentifier(origin)
            guard case let .known(risk, _)? = analysesByIdentifier[identifier] else {
                return nil
            }
            return (origin, risk)
        }
        safeRegionHistory.record(
            frames: observedCandidates
                .filter {
                    $0.risk.captureConfidence
                        >= placementConfiguration.minimumCaptureConfidence
                        && $0.risk.totalRisk <= placementConfiguration.safeRisk
                }
                .sorted { $0.risk.totalRisk < $1.risk.totalRisk }
                .map { contentFrame(forPanelOrigin: $0.origin) },
            at: observationDate
        )
        let candidates = observedCandidates.map { observedCandidate in
            let origin = observedCandidate.origin
            let risk = observedCandidate.risk
            let candidateFrame = contentFrame(forPanelOrigin: origin)
            let historicalMatch = safeRegionHistory.match(for: candidateFrame)
            return OrbPlacementCandidate(
                origin: origin,
                contentRisk: risk.totalRisk,
                captureConfidence: risk.captureConfidence,
                historicalOverlapCount: historicalMatch.overlapCount,
                historicalCoverage: historicalMatch.coverage
            )
        }
        captureFailureCount = 0
        let bestCandidateRisk = candidates
            .filter { Self.distance($0.origin, request.currentOrigin) > 0.5 }
            .map(\.contentRisk)
            .min()
        return DetachedOrbBatchEvaluation(
            controller: self,
            request: request,
            currentRisk: currentRisk.totalRisk,
            currentCaptureConfidence: currentRisk.captureConfidence,
            isCurrentPositionRisky:
                currentRisk.totalRisk >= placementConfiguration.triggerRisk,
            candidates: candidates,
            recentAutomaticOrigins: recentAutomaticPositions.compactMap {
                Date().timeIntervalSince($0.date) <= 15 ? $0.origin : nil
            },
            cooldownActive: Date() < cooldownUntil,
            bestCandidateRisk: bestCandidateRisk
        )
    }

    func planBatchMove(
        _ evaluation: DetachedOrbBatchEvaluation,
        additionalOccupiedFrames: [CGRect]
    ) -> OrbPlacementPlan {
        let input = OrbPlacementPlanningInput(
            currentOrigin: evaluation.request.currentOrigin,
            userAnchor: evaluation.request.userAnchor,
            windowSize: panel.frame.size,
            visibleFrame: evaluation.request.placementFrame,
            occupiedFrames: evaluation.request.occupiedFrames + additionalOccupiedFrames,
            excludedFrames: evaluation.request.excludedFrames,
            currentRisk: evaluation.currentRisk,
            currentCaptureConfidence: evaluation.currentCaptureConfidence,
            candidates: evaluation.candidates,
            recentAutomaticOrigins: evaluation.recentAutomaticOrigins,
            interactionFrozen: isInteractionFrozen,
            cooldownActive: evaluation.cooldownActive
        )
        let plan = OrbPlacementPlanner.plan(
            input: input,
            configuration: placementConfiguration
        )
        if case .move = plan.action {
            let diagnostics = OrbPlacementPlanner.directionalDiagnostics(
                input: input,
                configuration: placementConfiguration
            )
            logDevelopment(
                "[orb-avoidance] direction_candidates session=\(sessionId) "
                    + "right=\(Self.logDirectionStatistic(diagnostics.right)) "
                    + "top=\(Self.logDirectionStatistic(diagnostics.top)) "
                    + "left=\(Self.logDirectionStatistic(diagnostics.left)) "
                    + "bottom=\(Self.logDirectionStatistic(diagnostics.bottom))"
            )
        }
        return plan
    }

    func acceptBatchPlan(
        _ plan: OrbPlacementPlan,
        evaluation: DetachedOrbBatchEvaluation
    ) -> DetachedOrbBatchMove? {
        switch plan.action {
        case let .hold(reason):
            let bestScoreDescription =
                evaluation.bestCandidateRisk.map(Self.logScore) ?? "unknown"
            logDevelopment(
                "[orb-avoidance] evaluated session=\(sessionId) " +
                "risk=\(Self.logScore(evaluation.currentRisk)) " +
                "best=\(bestScoreDescription) " +
                "decision=\(reason)"
            )
            return nil
        case let .move(proposal):
            guard !isInteractionFrozen,
                  Self.distance(panel.frame.origin, evaluation.request.currentOrigin) <= 0.5 else {
                return nil
            }
            let previousOrigin = panel.frame.origin
            return DetachedOrbBatchMove(
                controller: self,
                origin: proposal.origin,
                previousOrigin: previousOrigin,
                destinationFrame: CGRect(
                    origin: proposal.origin,
                    size: panel.frame.size
                ),
                currentRisk: evaluation.currentRisk,
                candidateRisk: proposal.contentRisk
            )
        }
    }

    func prepareBatchMove(_ move: DetachedOrbBatchMove) {
        isMovingAutomatically = true
        automaticMoveDestination = move.origin
        automaticMoveDidTeleport = false
    }

    func beginBatchMoveDisappearance(
        _ move: DetachedOrbBatchMove,
        animation: DetachedOrbTeleportAnimation
    ) {
        guard canContinueBatchMove(move) else {
            return
        }
        withAnimation(.easeIn(duration: animation.disappearDuration)) {
            animationState.scale = animation.collapsedScale
        }
        panel.animator().alphaValue = 0
    }

    func teleportBatchMove(_ move: DetachedOrbBatchMove) {
        guard canContinueBatchMove(move) else {
            return
        }
        panel.alphaValue = 0
        panel.setFrameOrigin(move.origin)
        recentAutomaticPositions.append(
            DetachedOrbRecentAutomaticPosition(origin: move.previousOrigin, date: Date())
        )
        recentAutomaticPositions = Array(recentAutomaticPositions.suffix(4))
        automaticMoveDidTeleport = true
    }

    func beginBatchMoveAppearance(
        _ move: DetachedOrbBatchMove,
        animation: DetachedOrbTeleportAnimation
    ) {
        guard canContinueBatchMove(move) else {
            return
        }
        withAnimation(.easeOut(duration: animation.appearDuration)) {
            animationState.scale = animation.overshootScale
        }
        panel.animator().alphaValue = 1
    }

    func settleBatchMoveAppearance(
        _ move: DetachedOrbBatchMove,
        animation: DetachedOrbTeleportAnimation
    ) {
        guard canContinueBatchMove(move) else {
            return
        }
        guard animation.settleDuration > 0 else {
            animationState.scale = 1
            return
        }
        withAnimation(.easeInOut(duration: animation.settleDuration)) {
            animationState.scale = 1
        }
    }

    func canContinueBatchMove(_ move: DetachedOrbBatchMove) -> Bool {
        guard isMovingAutomatically, !isClosing, let automaticMoveDestination else {
            return false
        }
        return Self.distance(automaticMoveDestination, move.origin) <= 0.5
    }

    func restoreBatchMoveAppearanceIfNeeded() {
        panel.alphaValue = 1
        animationState.scale = 1
    }

    func finishBatchMove(_ move: DetachedOrbBatchMove) {
        isMovingAutomatically = false
        automaticMoveDestination = nil
        automaticMoveDidTeleport = false
        restoreBatchMoveAppearanceIfNeeded()
        cooldownUntil = Date().addingTimeInterval(automaticMoveCooldown)
        updateAccessory(for: currentSession)
        logDevelopment(
            "[orb-avoidance] batch_moved session=\(sessionId) " +
            "from=\(Self.logPoint(move.previousOrigin)) to=\(Self.logPoint(move.origin)) " +
            "actual=\(Self.logPoint(panel.frame.origin)) " +
            "risk=\(Self.logScore(move.currentRisk))->\(Self.logScore(move.candidateRisk))"
        )
    }

    func noteBatchAnalysisFailure(_ error: Error) {
        captureFailureCount += 1
        let category = (error as? ScreenContentSamplerError)?.description
            ?? String(describing: type(of: error))
        logDevelopment(
            "[orb-avoidance] batch_analysis_failed session=\(sessionId) " +
            "category=\(category) failures=\(captureFailureCount)"
        )
    }

    private func logInvalidEvaluation(_ reason: String) {
        logDevelopment(
            "[orb-avoidance] evaluation_invalid session=\(sessionId) reason=\(reason)"
        )
    }

    private func handlePointerInteractionBegan() {
        cancelAutomaticMoveForInteraction()
        isPointerDown = true
    }

    private func handlePointerInteractionEnded(didDrag: Bool) {
        isPointerDown = false
        guard didDrag else {
            scheduleObservationIfNeeded(delay: 1)
            return
        }
        recentAutomaticPositions.removeAll()
        if let visibleFrame = panel.screen?.visibleFrame {
            userSelectedLeftRegion = !DetachedOrbPlacementRegion.isFullyInRightThird(
                windowFrame: panel.frame,
                visibleFrame: visibleFrame
            )
        }
        cooldownUntil = Date().addingTimeInterval(0.8)
        scheduleObservationIfNeeded(delay: 0.85)
    }

    private func handleHoverChanged(_ hovering: Bool) {
        isPointerHovering = hovering
        if hovering {
            cancelAutomaticMoveForInteraction()
        }
        if !hovering {
            scheduleObservationIfNeeded(delay: 0.8)
        }
    }

    private func invalidatePlacementAndReschedule(delay: TimeInterval) {
        luminanceSignatures.removeAll()
        safeRegionHistory.reset()
        scheduleObservationIfNeeded(delay: delay)
    }

    private func cancelAutomaticMoveForInteraction() {
        guard isMovingAutomatically else {
            return
        }
        let didTeleport = automaticMoveDidTeleport
        isMovingAutomatically = false
        automaticMoveDestination = nil
        automaticMoveDidTeleport = false
        restoreBatchMoveAppearanceIfNeeded()
        if didTeleport {
            cooldownUntil = Date().addingTimeInterval(automaticMoveCooldown)
            updateAccessory(for: currentSession)
        }
        logDevelopment(
            "[orb-avoidance] batch_animation_cancelled session=\(sessionId) "
                + "phase=\(didTeleport ? "after_teleport" : "before_teleport")"
        )
    }

    private var isInteractionFrozen: Bool {
        isPointerDown
            || isPointerHovering
            || isMovingAutomatically
            || isClosing
            || accessoryController.isKeyWindow
            || accessoryController.visibleFrame != nil
            || previewState.isQuickReplyVisible
    }

    private func contentFrame(forPanelOrigin origin: CGPoint) -> CGRect {
        CGRect(
            x: origin.x + orbHaloPadding,
            y: origin.y + orbHaloPadding,
            width: orbSize,
            height: orbSize
        )
    }

    private static func originIdentifier(_ origin: CGPoint) -> String {
        "\(Int(origin.x.rounded())):\(Int(origin.y.rounded()))"
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }

    private static func logPoint(_ point: CGPoint) -> String {
        "\(Int(point.x.rounded())),\(Int(point.y.rounded()))"
    }

    private static func logScore(_ score: Double) -> String {
        String(format: "%.3f", score)
    }

    private static func logDirectionStatistic(
        _ statistic: OrbPlacementDirectionStatistic
    ) -> String {
        let risk = statistic.minimumRisk.map(logScore) ?? "none"
        return "\(statistic.safeCandidateCount)/\(risk)"
    }

    private func logDevelopment(_ message: @autoclosure () -> String) {
        guard CorptieAppEnvironment.isDevelopment else {
            return
        }
        print(message())
        fflush(stdout)
    }

    private func updateReplyPreview(for session: TaskSession?) {
        guard let session else {
            hideReplyPreview()
            lastSummary = nil
            lastStatus = nil
            lastPreviewText = nil
            dismissedPreviewText = nil
            return
        }
        guard !isSessionOpenInMainView(session) else {
            hideReplyPreview()
            lastSummary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            lastStatus = session.status
            return
        }

        let summary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let previousStatus = lastStatus
        defer {
            if !summary.isEmpty {
                lastSummary = summary
            }
            lastStatus = session.status
        }

        guard session.status != .running else {
            return
        }

        guard let previousSummary = lastSummary else {
            if session.status == .blocked || session.status == .complete || session.status == .failed || session.status == .cancelled {
                fetchDetailPreviewIfNeeded(for: session, fallbackSummary: summary, allowFallback: true)
            }
            return
        }

        if summary != previousSummary, !summary.isEmpty {
            fetchDetailPreviewIfNeeded(for: session, fallbackSummary: summary, allowFallback: true)
        } else if previousStatus == .running {
            fetchDetailPreviewIfNeeded(for: session, fallbackSummary: summary, allowFallback: true)
        }
    }

    private func hideReplyPreview(markDismissed: Bool = false) {
        if markDismissed {
            let text = previewState.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                dismissedPreviewText = text
            }
        }
        previewState.isVisible = false
        previewState.isQuickReplyVisible = false
        removeOutsideClickMonitor()
    }

    private func fetchDetailPreviewIfNeeded(for session: TaskSession, fallbackSummary: String, allowFallback: Bool) {
        Task { [weak self] in
            guard let self else { return }
            let detail = await client.fetchDetail(for: session)
            let text = Self.latestFinalAgentPreviewText(from: detail, includeActiveTurn: false) ?? (allowFallback ? fallbackSummary : "")
            await MainActor.run {
                guard let current = self.currentSession,
                      current.id == session.id,
                      current.status != .running,
                      !self.isSessionOpenInMainView(current) else {
                    return
                }
                self.showReplyPreview(text, for: current)
            }
        }
    }

    private func showLatestReplyPreviewIfNeeded() {
        dismissedPreviewText = nil
        if !previewState.isVisible && !previewState.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            previewState.isVisible = true
        }
        guard let session = currentSession, !isSessionOpenInMainView(session) else {
            return
        }

        let fallbackSummary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if previewState.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           session.status != .running,
           !fallbackSummary.isEmpty {
            showReplyPreview(fallbackSummary, for: session, force: true)
        }
        fetchLatestReplyPreview(
            for: session,
            fallbackSummary: fallbackSummary,
            allowFallback: session.status != .running,
            includeActiveTurn: true,
            force: true
        )
    }

    private func fetchLatestReplyPreview(
        for session: TaskSession,
        fallbackSummary: String,
        allowFallback: Bool,
        includeActiveTurn: Bool,
        force: Bool = false
    ) {
        Task { [weak self] in
            guard let self else { return }
            let detail = await client.fetchDetail(for: session)
            let text = Self.latestFinalAgentPreviewText(from: detail, includeActiveTurn: includeActiveTurn) ?? (allowFallback ? fallbackSummary : "")
            await MainActor.run {
                guard let current = self.currentSession,
                      current.id == session.id,
                      !self.isSessionOpenInMainView(current) else {
                    return
                }
                self.showReplyPreview(text, for: current, force: force)
            }
        }
    }

    private func showReplyPreview(_ text: String, for session: TaskSession, force: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !force, trimmed == dismissedPreviewText {
            return
        }
        guard !trimmed.isEmpty, force || trimmed != lastPreviewText || !previewState.isVisible else {
            return
        }
        if trimmed != dismissedPreviewText {
            dismissedPreviewText = nil
        }
        lastPreviewText = trimmed
        previewState.text = trimmed
        previewState.isVisible = true
        previewState.isQuickReplyVisible = true
        ignoreOutsideClickUntil = Date().addingTimeInterval(0.35)
        DispatchQueue.main.async { [weak self] in
            self?.installOutsideClickMonitor()
        }
        updateAccessory(for: session)
    }

    private func isSessionOpenInMainView(_ session: TaskSession) -> Bool {
        isMainVisible() && client.selectedSession?.id == session.id
    }

    private static func latestFinalAgentPreviewText(from detail: CodexThreadDetail?, includeActiveTurn: Bool) -> String? {
        guard let detail else {
            return nil
        }

        var turnIds: [String] = []
        var itemsByTurnId: [String: [CodexThreadItem]] = [:]
        for item in detail.items {
            if itemsByTurnId[item.turnId] == nil {
                turnIds.append(item.turnId)
                itemsByTurnId[item.turnId] = []
            }
            itemsByTurnId[item.turnId]?.append(item)
        }

        if detail.status == .running && !includeActiveTurn && !turnIds.isEmpty {
            turnIds.removeLast()
        }

        for turnId in turnIds.reversed() {
            guard let turnItems = itemsByTurnId[turnId] else {
                continue
            }
            if let text = turnItems.reversed().first(where: { item in
                item.type == "agentMessage" && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            })?.text.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                return text
            }
        }
        return nil
    }

    private var currentSession: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }

    private func installOutsideClickMonitor() {
        removeOutsideClickMonitor()
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                guard let self else {
                    return
                }
                guard Date() >= self.ignoreOutsideClickUntil else {
                    return
                }
                self.hideReplyPreview(markDismissed: true)
                self.hideQuickReply()
                self.updateAccessory(for: self.currentSession)
            }
        }
        localOutsideClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self else {
                return event
            }
            guard Date() >= self.ignoreOutsideClickUntil else {
                return event
            }
            guard event.window !== self.panel, !self.accessoryController.contains(window: event.window) else {
                return event
            }
            self.hideReplyPreview(markDismissed: true)
            self.hideQuickReply()
            self.updateAccessory(for: self.currentSession)
            return event
        }
    }

    private func removeOutsideClickMonitor() {
        if let outsideClickMonitor {
            NSEvent.removeMonitor(outsideClickMonitor)
            self.outsideClickMonitor = nil
        }
        if let localOutsideClickMonitor {
            NSEvent.removeMonitor(localOutsideClickMonitor)
            self.localOutsideClickMonitor = nil
        }
    }

    private var currentOrbCenter: NSPoint {
        NSPoint(x: panel.frame.minX + orbHaloPadding + orbSize / 2, y: panel.frame.maxY - orbHaloPadding - orbSize / 2)
    }
}

private struct DetachedSessionOrbView: View {
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @ObservedObject var client: BackendClient
    let sessionId: String
    @ObservedObject var previewState: DetachedReplyPreviewState
    @ObservedObject var animationState: DetachedOrbAnimationState
    let primaryAction: () -> Void
    let showMain: () -> Void
    let openSession: (TaskSession) -> Void
    let dismissPreview: () -> Void
    let dismissQuickReply: () -> Void
    let close: () -> Void
    let interactionBegan: () -> Void
    let interactionEnded: (Bool) -> Void
    let hoverChanged: (Bool) -> Void

    var body: some View {
        Group {
            if let session {
                orb(session: session)
                    .help(session.status.label)
            } else {
                EmptyView()
                    .onAppear {
                        close()
                }
            }
        }
        .frame(width: orbRenderSize, height: orbRenderSize, alignment: .topLeading)
        .scaleEffect(animationState.scale)
        .background(Color.clear)
        .environment(\.locale, appLanguage.locale)
    }

    @ViewBuilder
    private func orb(session: TaskSession) -> some View {
        SessionAvatarView(session: session, avatarSize: 52)
        .frame(width: 72, height: 72)
        .transaction { transaction in
            transaction.animation = nil
        }
        .contentShape(Circle())
        .overlay(
            DetachedOrbEventLayer(
                sessionId: session.id,
                open: {
                    primaryAction()
                },
                openSession: {
                    openSession(session)
                },
                showMain: showMain,
                close: close,
                interactionBegan: interactionBegan,
                interactionEnded: interactionEnded,
                hoverChanged: hoverChanged
            )
            .frame(width: 72, height: 72)
        )
        .padding(orbHaloPadding)
    }

    private var orbRenderSize: CGFloat {
        88
    }

    private var orbHaloPadding: CGFloat {
        8
    }

    private var session: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }
}

private struct DetachedSessionAccessoryView: View {
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @ObservedObject var client: BackendClient
    let sessionId: String
    @ObservedObject var previewState: DetachedReplyPreviewState
    let dismissPreview: () -> Void
    let dismissQuickReply: () -> Void

    var body: some View {
        Group {
            if let session {
                ZStack(alignment: .topLeading) {
                    floatingAccessory(session: session)

                    if !visibleOptions.isEmpty {
                        optionList(session: session)
                            .offset(y: contentOffsetBeforeOptionList)
                    }

                    if let hoveredOption {
                        DetachedOptionTooltip(text: hoveredOption.label)
                            .offset(x: 8, y: optionTooltipY(for: hoveredOption))
                            .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
                            .zIndex(8)
                            .allowsHitTesting(false)
                    }
                }
                .frame(width: contentWidth, height: contentHeight, alignment: .topLeading)
                .background(Color.clear)
            } else {
                EmptyView()
            }
        }
        .environment(\.locale, appLanguage.locale)
    }

    @ViewBuilder
    private func floatingAccessory(session: TaskSession) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let confirmation = session.pendingCollaborationConfirmation {
                DetachedCollaborationConfirmationCard(
                    confirmation: confirmation,
                    isSending: client.isSendingMessage,
                    approve: {
                        client.respondToCollaborationConfirmation(
                            confirmationId: confirmation.confirmationId,
                            approve: true,
                            in: session
                        )
                    },
                    reject: {
                        client.respondToCollaborationConfirmation(
                            confirmationId: confirmation.confirmationId,
                            approve: false,
                            in: session
                        )
                    }
                )
                .padding(10)
                .frame(width: previewTotalWidth, height: collaborationConfirmationTotalHeight, alignment: .topLeading)
            } else if let suggestedPromptText {
                DetachedReplyPreviewBubble(
                    text: suggestedPromptText,
                    dismiss: {
                        previewState.dismissedOptionsFingerprint = detachedOptionsFingerprint(for: session)
                        previewState.hoveredOptionId = nil
                    }
                )
                .padding(10)
                .frame(width: previewTotalWidth, height: suggestedPromptTotalHeight, alignment: .topLeading)
            } else if shouldShowReplyPreview && previewState.isQuickReplyVisible {
                DetachedReplyComposerCard(
                    text: previewState.text,
                    draft: $previewState.quickReplyDraft,
                    send: {
                        sendQuickReply(to: session)
                    },
                    dismiss: {
                        dismissPreview()
                        dismissQuickReply()
                    }
                )
                .padding(10)
                .frame(width: previewTotalWidth, height: replyComposerTotalHeight, alignment: .topLeading)
            }
        }
        .frame(width: previewTotalWidth, height: accessoryHeight, alignment: .topLeading)
    }

    @ViewBuilder
    private func optionList(session: TaskSession) -> some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(visibleOptions) { option in
                    DetachedOptionButton(
                        option: option,
                        background: optionBackground,
                        hoverChanged: { hovering in
                            let shouldShowTooltip = hovering && isOptionLabelTruncated(option)
                            previewState.hoveredOptionId = shouldShowTooltip ? option.id : (previewState.hoveredOptionId == option.id ? nil : previewState.hoveredOptionId)
                        },
                        send: {
                            previewState.dismissedOptionsFingerprint = detachedOptionsFingerprint(for: session)
                            previewState.hoveredOptionId = nil
                            dismissPreview()
                            dismissQuickReply()
                            if option.role?.localizedCaseInsensitiveContains("approve") == true
                                || option.role?.localizedCaseInsensitiveContains("deny") == true {
                                client.respondToCodexApproval(option: option, to: session)
                            } else {
                                client.sendMessage(option.label, to: session, isChoiceSelection: true)
                            }
                        }
                    )
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .frame(width: optionWidth, height: optionListHeight, alignment: .topLeading)
    }

    private func sendQuickReply(to session: TaskSession) {
        let trimmed = previewState.quickReplyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }
        previewState.quickReplyDraft = ""
        dismissQuickReply()
        dismissPreview()
        client.sendMessage(trimmed, to: session)
    }

    private var session: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }

    private var visibleOptions: [CodexApprovalOption] {
        guard let session else {
            return []
        }
        if previewState.dismissedOptionsFingerprint == detachedOptionsFingerprint(for: session) {
            return []
        }
        return Array((session.suggestedOptions ?? []).prefix(5))
    }

    private var hoveredOption: CodexApprovalOption? {
        guard let hoveredOptionId = previewState.hoveredOptionId else {
            return nil
        }
        return visibleOptions.first { $0.id == hoveredOptionId }
    }

    private var sessionHasOptions: Bool {
        !visibleOptions.isEmpty
    }

    private var shouldShowReplyPreview: Bool {
        previewState.isVisible && !previewState.text.isEmpty
    }

    private var suggestedPromptText: String? {
        guard sessionHasOptions, let session else {
            return nil
        }
        let text = (session.suggestedPrompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private var contentWidth: CGFloat {
        max(accessoryHeight > 0 ? previewTotalWidth : 0, sessionHasOptions ? optionWidth : 0)
    }

    private var contentHeight: CGFloat {
        accessoryHeight + (accessoryHeight > 0 && sessionHasOptions ? spacing : 0) + (sessionHasOptions ? optionListHeight : 0)
    }

    private var accessoryHeight: CGFloat {
        if session?.pendingCollaborationConfirmation != nil {
            return collaborationConfirmationTotalHeight
        }
        if suggestedPromptText != nil {
            return suggestedPromptTotalHeight
        }
        if shouldShowReplyPreview && previewState.isQuickReplyVisible {
            return replyComposerTotalHeight
        }
        return 0
    }

    private var previewTotalWidth: CGFloat {
        324
    }

    private var replyComposerTotalHeight: CGFloat {
        194
    }

    private var suggestedPromptTotalHeight: CGFloat {
        146
    }

    private var collaborationConfirmationTotalHeight: CGFloat {
        276
    }

    private var spacing: CGFloat {
        10
    }

    private var optionWidth: CGFloat {
        246
    }

    private func optionTooltipY(for option: CodexApprovalOption) -> CGFloat {
        guard let index = visibleOptions.firstIndex(of: option) else {
            return 0
        }
        let optionListOriginY = contentOffsetBeforeOptionList
        let optionTop = optionListOriginY + CGFloat(index) * 34 + 8
        let tooltipHeight: CGFloat = 44
        let tooltipReserveY = tooltipHeight + 8
        let aboveY = optionTop - tooltipHeight - 3
        let maxTopY = max(0, contentHeight - tooltipHeight - 4)
        if optionTop > tooltipReserveY {
            return max(0, min(aboveY, maxTopY))
        }
        return min(optionTop + 34, maxTopY)
    }

    private func isOptionLabelTruncated(_ option: CodexApprovalOption) -> Bool {
        let font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        let measuredWidth = (option.label as NSString).size(withAttributes: attributes).width
        let scrollPadding: CGFloat = 16
        let textPadding: CGFloat = 18
        let safetyMargin: CGFloat = 6
        let availableWidth = optionWidth - scrollPadding - textPadding - safetyMargin
        return measuredWidth > availableWidth
    }

    private var contentOffsetBeforeOptionList: CGFloat {
        let topPad = accessoryHeight > 0 ? accessoryHeight + spacing : 0
        return topPad
    }

    private var optionListHeight: CGFloat {
        min(138, CGFloat(visibleOptions.count) * 34 + 8)
    }

    private var optionBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.12, alpha: 0.92)
                : NSColor(calibratedWhite: 1.0, alpha: 0.88)
        })
    }
}

private struct DetachedCollaborationConfirmationCard: View {
    let confirmation: PendingCollaborationConfirmation
    let isSending: Bool
    let approve: () -> Void
    let reject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Image(systemName: "paperplane.fill")
                    .foregroundStyle(CorptiePalette.softBlue)
                Text(L10n("确认发送协作任务"))
                    .font(.system(size: 11, weight: .bold))
                Spacer(minLength: 4)
                Text(L10n("等待确认"))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(CorptiePalette.amber)
            }

            Divider()
                .overlay(CorptiePalette.collaborationBorder.opacity(0.42))

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 8) {
                    confirmationField("目标 Agent", value: confirmation.recipientName)
                    if let recipientAgentId = confirmation.recipientAgentId,
                       !recipientAgentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        confirmationField("Agent ID", value: recipientAgentId, monospaced: true)
                    }
                    confirmationField("任务", value: confirmation.taskTitle)
                    confirmationField("指令", value: confirmation.summary)
                    if !confirmation.acceptanceCriteria.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(L10n("验收标准"))
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            ForEach(confirmation.acceptanceCriteria, id: \.self) { criterion in
                                Label(criterion, systemImage: "checkmark.circle")
                                    .font(.system(size: 9.5, weight: .medium))
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 150)

            HStack(spacing: 8) {
                Button(action: approve) {
                    Label(L10n("确认发送"), systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(CorptiePalette.softBlue)

                Button(L10n("取消"), action: reject)
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(isSending)
        }
        .padding(11)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(CorptiePalette.collaborationSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(CorptiePalette.collaborationBorder.opacity(0.62), lineWidth: 1)
        )
    }

    private func confirmationField(_ label: String, value: String, monospaced: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(L10n(label))
                .font(.system(size: 8.5, weight: .bold))
                .foregroundStyle(CorptiePalette.secondaryText)
            Text(value)
                .font(.system(size: 9.5, weight: .medium, design: monospaced ? .monospaced : .default))
                .foregroundStyle(CorptiePalette.primaryText)
                .textSelection(.enabled)
        }
    }
}

private struct DetachedReplyPreviewBubble: View {
    let text: String
    let dismiss: () -> Void
    @State private var isHovering = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            ScrollView(.vertical, showsIndicators: true) {
                MarkdownMessageView(
                    text: text,
                    fontSize: 11,
                    fontWeight: .semibold,
                    foregroundColor: CorptiePalette.primaryText
                )
                    .padding(.leading, 14)
                    .padding(.trailing, 12)
                    .padding(.top, 24)
                    .padding(.bottom, 11)
            }
            .frame(width: 300, height: 126, alignment: .leading)

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .frame(width: 16, height: 16)
                    .foregroundStyle(CorptiePalette.secondaryText)
            }
            .buttonStyle(.plain)
            .background(Color.black.opacity(0.06), in: Circle())
            .padding(7)
            .help(L10n("Dismiss"))

            CopyTextButton(text: text, isVisible: isHovering && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .frame(width: 300, height: 126, alignment: .bottomTrailing)
                .padding(.trailing, 7)
                .padding(.bottom, 7)
        }
        .background(replyBackground, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.white.opacity(0.38), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.12), radius: 7, y: 3)
        .onHover { hovering in
            isHovering = hovering
        }
    }

    private var replyBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.10, alpha: 0.94)
                : NSColor(calibratedWhite: 1.0, alpha: 0.92)
        })
    }
}

private struct DetachedReplyComposerCard: View {
    let text: String
    @Binding var draft: String
    let send: () -> Void
    let dismiss: () -> Void
    @FocusState private var isFocused: Bool
    @State private var isHoveringPreview = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                ScrollView(.vertical, showsIndicators: true) {
                    MarkdownMessageView(
                        text: text,
                        fontSize: 11,
                        fontWeight: .semibold,
                        foregroundColor: CorptiePalette.primaryText
                    )
                        .padding(.leading, 24)
                        .padding(.trailing, 6)
                        .padding(.vertical, 4)
                }
                .frame(height: 112, alignment: .leading)

                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .frame(width: 16, height: 16)
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .buttonStyle(.plain)
                .background(Color.black.opacity(0.06), in: Circle())
                .help(L10n("Dismiss"))

                CopyTextButton(text: text, isVisible: isHoveringPreview && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(.trailing, 3)
                    .padding(.bottom, 3)
            }
            .onHover { hovering in
                isHoveringPreview = hovering
            }

            HStack(spacing: 6) {
                ChatInputTextView(
                    text: $draft,
                    placeholder: L10n("Reply..."),
                    font: .systemFont(ofSize: 12, weight: .semibold),
                    autoFocus: true,
                    onFocusChange: { focused in
                        isFocused = focused
                    },
                    onSubmit: send
                )
                    .frame(height: 28)
                    .padding(.leading, 10)
                    .padding(.trailing, 2)
                    .padding(.vertical, 3)

                Button {
                    send()
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .foregroundStyle(CorptiePalette.softBlue)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.leading, 2)
            .padding(.trailing, 7)
            .padding(.vertical, 5)
            .frame(height: 38)
            .background(inputBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(CorptiePalette.softBlue.opacity(isFocused ? 0.46 : 0.20), lineWidth: 1)
            )
        }
        .padding(10)
        .frame(width: 304, height: 174, alignment: .topLeading)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(0.38), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 5, y: 2)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                isFocused = true
            }
        }
    }

    private var cardBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.10, alpha: 0.94)
                : NSColor(calibratedWhite: 1.0, alpha: 0.92)
        })
    }

    private var inputBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.13, alpha: 0.92)
                : NSColor(calibratedWhite: 0.98, alpha: 0.86)
        })
    }
}

private struct DetachedQuickReplyInput: View {
    @Binding var text: String
    let send: () -> Void
    let dismiss: () -> Void
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 6) {
            ChatInputTextView(
                text: $text,
                placeholder: L10n("Reply..."),
                font: .systemFont(ofSize: 12, weight: .semibold),
                autoFocus: true,
                onFocusChange: { focused in
                    isFocused = focused
                },
                onSubmit: send
            )
                .frame(height: 30)
                .padding(.leading, 11)
                .padding(.trailing, 2)
                .padding(.vertical, 4)

            Button {
                send()
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.softBlue)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.leading, 2)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .frame(width: 300, height: 42)
        .background(inputBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(CorptiePalette.softBlue.opacity(isFocused ? 0.46 : 0.22), lineWidth: 1)
        )
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                isFocused = true
            }
        }
    }

    private var inputBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.10, alpha: 0.95)
                : NSColor(calibratedWhite: 1.0, alpha: 0.94)
        })
    }
}

private struct DetachedOptionButton: View {
    let option: CodexApprovalOption
    let background: Color
    let hoverChanged: (Bool) -> Void
    let send: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button {
            send()
        } label: {
            Text(option.label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(CorptiePalette.primaryText)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9)
                .frame(height: 28)
        }
        .buttonStyle(.plain)
        .background(background, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(CorptiePalette.amber.opacity(0.26), lineWidth: 1)
        )
        .onHover { hovering in
            isHovering = hovering
            hoverChanged(hovering)
        }
        .help(option.label)
    }
}

private struct DetachedOptionTooltip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(CorptiePalette.primaryText)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: 240, alignment: .leading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(Color.black.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.16), radius: 14, y: 6)
            .allowsHitTesting(false)
    }
}

private struct DetachedOrbEventLayer: NSViewRepresentable {
    let sessionId: String
    let open: () -> Void
    let openSession: () -> Void
    let showMain: () -> Void
    let close: () -> Void
    let interactionBegan: () -> Void
    let interactionEnded: (Bool) -> Void
    let hoverChanged: (Bool) -> Void

    func makeNSView(context: Context) -> EventView {
        let view = EventView()
        view.sessionId = sessionId
        view.open = open
        view.openSessionAction = openSession
        view.showMainAction = showMain
        view.close = close
        view.interactionBegan = interactionBegan
        view.interactionEnded = interactionEnded
        view.hoverChanged = hoverChanged
        return view
    }

    func updateNSView(_ nsView: EventView, context: Context) {
        nsView.sessionId = sessionId
        nsView.open = open
        nsView.openSessionAction = openSession
        nsView.showMainAction = showMain
        nsView.close = close
        nsView.interactionBegan = interactionBegan
        nsView.interactionEnded = interactionEnded
        nsView.hoverChanged = hoverChanged
    }

    final class EventView: NSView {
        var sessionId = ""
        var open: (() -> Void)?
        var openSessionAction: (() -> Void)?
        var showMainAction: (() -> Void)?
        var close: (() -> Void)?
        var interactionBegan: (() -> Void)?
        var interactionEnded: ((Bool) -> Void)?
        var hoverChanged: ((Bool) -> Void)?
        private var initialMouseScreenPoint: NSPoint?
        private var initialWindowOrigin: NSPoint?
        private var didDrag = false
        private var trackingAreaReference: NSTrackingArea?

        override var acceptsFirstResponder: Bool {
            true
        }

        override var mouseDownCanMoveWindow: Bool {
            false
        }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            let center = NSPoint(x: bounds.midX, y: bounds.midY)
            let dx = point.x - center.x
            let dy = point.y - center.y
            let radius = min(bounds.width, bounds.height) / 2
            return dx * dx + dy * dy <= radius * radius ? self : nil
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let trackingAreaReference {
                removeTrackingArea(trackingAreaReference)
            }
            let trackingArea = NSTrackingArea(
                rect: bounds,
                options: [.activeAlways, .mouseEnteredAndExited],
                owner: self,
                userInfo: nil
            )
            addTrackingArea(trackingArea)
            trackingAreaReference = trackingArea
        }

        override func mouseEntered(with event: NSEvent) {
            hoverChanged?(true)
        }

        override func mouseExited(with event: NSEvent) {
            hoverChanged?(false)
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            initialMouseScreenPoint = NSEvent.mouseLocation
            initialWindowOrigin = window.frame.origin
            didDrag = false
            window.makeKey()
            interactionBegan?()
        }

        override func mouseDragged(with event: NSEvent) {
            guard let window,
                  let initialMouseScreenPoint,
                  let initialWindowOrigin else {
                return
            }

            let currentMouseScreenPoint = NSEvent.mouseLocation
            let dx = currentMouseScreenPoint.x - initialMouseScreenPoint.x
            let dy = currentMouseScreenPoint.y - initialMouseScreenPoint.y
            if abs(dx) > 2 || abs(dy) > 2 {
                didDrag = true
            }

            window.setFrameOrigin(
                DetachedWindowDragGeometry.windowOrigin(
                    initialWindowOrigin: initialWindowOrigin,
                    initialMouseScreenPoint: initialMouseScreenPoint,
                    currentMouseScreenPoint: currentMouseScreenPoint
                )
            )
        }

        override func mouseUp(with event: NSEvent) {
            let completedDrag = didDrag
            interactionEnded?(completedDrag)
            switch DetachedOrbClickBehavior.action(clickCount: event.clickCount, didDrag: didDrag) {
            case .none:
                break
            case .primary:
                open?()
            case .openSession:
                openSessionAction?()
            }
            initialMouseScreenPoint = nil
            initialWindowOrigin = nil
            didDrag = false
        }

        override func rightMouseDown(with event: NSEvent) {
            interactionBegan?()
            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: L10n("Show Main Window"), action: #selector(showMain), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: L10n("Open Session"), action: #selector(openSession), keyEquivalent: ""))
            menu.addItem(.separator())
            menu.addItem(completionSoundMenuItem())
            menu.addItem(.separator())
            menu.addItem(NSMenuItem(title: L10n("Close Floating Orb"), action: #selector(closeOrb), keyEquivalent: ""))
            menu.items.forEach { $0.target = self }
            menu.popUp(positioning: nil, at: convert(event.locationInWindow, from: nil), in: self)
            interactionEnded?(false)
        }

        private func completionSoundMenuItem() -> NSMenuItem {
            let parent = NSMenuItem(title: L10n("Completion Sound"), action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            let selectedSoundId = SessionCompletionSoundManager.selectedSoundId(for: sessionId)
            for option in SessionCompletionSoundManager.options {
                let item = NSMenuItem(title: option.label, action: #selector(selectCompletionSound(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = option.id
                item.state = option.id == selectedSoundId ? .on : .off
                submenu.addItem(item)
            }
            parent.submenu = submenu
            return parent
        }

        @objc private func showMain() {
            showMainAction?()
        }

        @objc private func openSession() {
            openSessionAction?()
        }

        @objc private func closeOrb() {
            close?()
        }

        @objc private func selectCompletionSound(_ sender: NSMenuItem) {
            guard let soundId = sender.representedObject as? String else {
                return
            }
            SessionCompletionSoundManager.setSelectedSoundId(soundId, for: sessionId)
        }
    }
}
