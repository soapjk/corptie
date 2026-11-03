import Foundation
import SwiftUI

/// Scene-local strings use the same selected localization bundle as the workbench.
@MainActor func SceneText(_ key: String) -> String {
    AppLanguageController.shared.localizationBundle.localizedString(forKey: key, value: key, table: "Scenes")
}

enum SceneKind: Equatable {
    case checklist, measurements, unsupported
    init(_ scene: SceneInstance) { self.init(templateID: scene.templateId, version: scene.templateVersion) }
    init(templateID: String, version: Int) {
        switch (templateID, version) {
        case ("daily-checklist", 1): self = .checklist
        case ("fitness-planner", 1): self = .measurements
        default: self = .unsupported
        }
    }
    var viewID: String? {
        switch self { case .checklist: "checklist"; case .measurements: "measurements"; case .unsupported: nil }
    }
    var symbol: String {
        switch self { case .checklist: "checklist"; case .measurements: "figure.run"; case .unsupported: "square.grid.2x2" }
    }
    @MainActor var title: String {
        switch self {
        case .checklist: SceneText("Checklist")
        case .measurements: SceneText("Fitness Plan · Manual measurements")
        case .unsupported: SceneText("This template version does not support entry here.")
        }
    }
}

enum SceneInput {
    static func clean(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    static func validText(_ value: String, maximum: Int) -> Bool {
        let cleaned = clean(value)
        return !cleaned.isEmpty && cleaned.utf16.count <= maximum
    }
    /// Decimal input only. Reject grouping, partial parses, NaN and infinity.
    static func number(_ input: String, locale: Locale) -> Double? {
        let text = clean(input)
        let separator = locale.decimalSeparator ?? "."
        guard separator == "." || !text.contains(".") else { return nil }
        let normalized = text.replacingOccurrences(of: separator, with: ".")
        guard normalized.range(of: #"^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$"#, options: .regularExpression) != nil,
              let value = Double(normalized), value.isFinite, (-1_000_000...1_000_000).contains(value) else { return nil }
        return value
    }
}

@MainActor final class SceneEntryDraft: ObservableObject {
    @Published var title = ""
    @Published var value = ""
    @Published var unit = "kg"
    private var savedMetric = ""
    private var savedUnit = "kg"
    var isEmpty: Bool { title == savedMetric && value.isEmpty && unit == savedUnit }
    func markMeasurementSaved(metric: String, unit: String) { savedMetric = metric; savedUnit = unit }
    func clear() { savedMetric = ""; savedUnit = "kg"; title = ""; value = ""; unit = "kg" }
}

/// In-memory only; never evict unsaved input silently. Lookup on selection is O(1).
@MainActor final class SceneDraftStore {
    private var drafts: [String: SceneEntryDraft] = [:]
    func draft(for id: String) -> SceneEntryDraft? {
        if let draft = drafts[id] { return draft }
        if drafts.count >= 10 {
            drafts = drafts.filter { !$0.value.isEmpty }
            guard drafts.count < 10 else { return nil }
        }
        let draft = SceneEntryDraft()
        drafts[id] = draft
        return draft
    }
}

/// Prepared only when records/locale change, never on a keystroke or row click.
struct SceneRecordPresentation: Identifiable, Equatable {
    let record: SceneRecord
    let title: String
    let value: String?
    let metadata: String?
    var id: String { record.recordId }
    var completed: Bool { record.data["completed"]?.boolValue ?? false }

    @MainActor static func prepare(_ records: [SceneRecord], scene: SceneInstance, locale: Locale) -> [Self] {
        let date = DateFormatter()
        date.locale = locale
        date.timeZone = TimeZone(identifier: scene.timezone) ?? TimeZone(secondsFromGMT: 0)
        date.dateStyle = .medium; date.timeStyle = .short
        let iso = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return records.filter { $0.recordType != "List" }.map { record in
            let title = record.data["title"]?.stringValue ?? record.data["metric"]?.stringValue ?? record.recordType
            let value = record.data["value"]?.numberValue.map {
                $0.formatted(.number.locale(locale)) + " " + (record.data["unit"]?.stringValue ?? "")
            }
            var metadata: String?
            if record.recordType == "Measurement" {
                let measured = record.data["measuredAt"]?.stringValue
                let raw = measured ?? record.createdAt
                let parsed = iso.date(from: raw) ?? fractional.date(from: raw)
                let time: String
                if TimeZone(identifier: scene.timezone) == nil { time = raw + " · " + SceneText("Invalid time zone") }
                else if let parsed { time = (measured == nil ? SceneText("Recorded at") + " " : "") + date.string(from: parsed) }
                else { time = SceneText("Time unknown") }
                let source = record.data["source"]?.stringValue
                let label = source == "manual" ? SceneText("Manual entry") : source == "import" ? SceneText("Imported") : SceneText("Source unknown")
                metadata = time + " · " + label
            }
            return Self(record: record, title: title, value: value, metadata: metadata)
        }
    }
}

struct SceneRequestError: Error, LocalizedError, Sendable {
    let message: String
    let code: String?
    let uncertain: Bool
    var errorDescription: String? { message }
}

enum SceneMutationOutcome: Equatable {
    case committed, rejected, uncertain
}

@MainActor final class SceneOperationState: ObservableObject {
    @Published var isPending = false
    @Published var message: String?
    @Published var needsVerification = false
    @Published var pendingRecordID: String?
}
