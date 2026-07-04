import AppKit
import Combine
import Foundation

struct SessionCompletionSoundOption: Identifiable, Equatable {
    let id: String
    let label: String
    let systemSoundName: String?
}

@MainActor
final class SessionCompletionSoundManager {
    static let defaultSoundId = "glass"
    static let noneSoundId = "none"

    static let options: [SessionCompletionSoundOption] = [
        SessionCompletionSoundOption(id: defaultSoundId, label: "Default", systemSoundName: "Glass"),
        SessionCompletionSoundOption(id: "ping", label: "Ping", systemSoundName: "Ping"),
        SessionCompletionSoundOption(id: "pop", label: "Pop", systemSoundName: "Pop"),
        SessionCompletionSoundOption(id: "tink", label: "Tink", systemSoundName: "Tink"),
        SessionCompletionSoundOption(id: "hero", label: "Hero", systemSoundName: "Hero"),
        SessionCompletionSoundOption(id: "submarine", label: "Submarine", systemSoundName: "Submarine"),
        SessionCompletionSoundOption(id: noneSoundId, label: "Off", systemSoundName: nil)
    ]

    private static let storageKey = "corptie.sessionCompletionSounds"

    private let client: BackendClient
    private var cancellables = Set<AnyCancellable>()
    private var previousStatusesBySessionId: [String: TaskStatus] = [:]
    private var hasObservedInitialSnapshot = false

    init(client: BackendClient) {
        self.client = client
    }

    func start() {
        client.$sessions
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                self?.handleSessionsUpdate(sessions)
            }
            .store(in: &cancellables)
    }

    func stop() {
        cancellables.removeAll()
        previousStatusesBySessionId.removeAll()
        hasObservedInitialSnapshot = false
    }

    static func selectedSoundId(for sessionId: String) -> String {
        storedSoundIdsBySessionId()[sessionId] ?? defaultSoundId
    }

    static func setSelectedSoundId(_ soundId: String, for sessionId: String) {
        var stored = storedSoundIdsBySessionId()
        if soundId == defaultSoundId {
            stored.removeValue(forKey: sessionId)
        } else {
            stored[sessionId] = soundId
        }
        CorptieAppEnvironment.userDefaults.set(stored, forKey: storageKey)
    }

    static func option(for soundId: String) -> SessionCompletionSoundOption {
        options.first { $0.id == soundId } ?? options[0]
    }

    private func handleSessionsUpdate(_ sessions: [TaskSession]) {
        let currentIds = Set(sessions.map(\.id))
        previousStatusesBySessionId = previousStatusesBySessionId.filter { currentIds.contains($0.key) }

        guard hasObservedInitialSnapshot else {
            previousStatusesBySessionId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0.status) })
            hasObservedInitialSnapshot = true
            return
        }

        for session in sessions {
            let previousStatus = previousStatusesBySessionId[session.id]
            if previousStatus == .running && shouldNotifyCompletion(for: session.status) {
                playCompletionSound(for: session)
            }
            previousStatusesBySessionId[session.id] = session.status
        }
    }

    private func shouldNotifyCompletion(for status: TaskStatus) -> Bool {
        status == .complete || status == .blocked
    }

    private func playCompletionSound(for session: TaskSession) {
        let option = Self.option(for: Self.selectedSoundId(for: session.id))
        guard let soundName = option.systemSoundName else {
            return
        }
        if let sound = NSSound(named: NSSound.Name(soundName)) {
            sound.play()
        } else {
            NSSound.beep()
        }
    }

    private static func storedSoundIdsBySessionId() -> [String: String] {
        CorptieAppEnvironment.userDefaults.dictionary(forKey: storageKey) as? [String: String] ?? [:]
    }
}
