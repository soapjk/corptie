import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class SharedExecutionTextTests: XCTestCase {
    func testAllKindsAndStatesMatchDesktopAttributedRuns() {
        let kinds: [NativeExecutionTimelineStep.Kind] = [.context, .action, .result]
        let states: [NativeExecutionTimelineStep.State] = [.running, .completed, .failed, .cancelled]
        let steps = kinds.flatMap { kind in states.map { state in
            NativeExecutionTimelineStep(id: "\(kind)-\(state)", kind: kind, state: state,
                title: "Read source 标题", detail: "path/to/source.swift · output")
        } }
        XCTAssertTrue(NativeExecutionTimelineAttributedText.make(steps: steps)
            .isEqual(to: FrozenExecutionText.make(steps: steps)))
    }
}

@MainActor
private enum FrozenExecutionText {
    static func make(steps: [NativeExecutionTimelineStep]) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for (index, step) in steps.enumerated() {
            let marker = NSMutableAttributedString(
                string: "\(step.state.marker)  ",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 10.5, weight: .bold),
                    .foregroundColor: markerColor(step.state)
                ]
            )
            result.append(marker)
            result.append(NSAttributedString(
                string: "\(L10n(step.kind.label).uppercased())  ",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 8.5, weight: .bold),
                    .foregroundColor: kindColor(step.kind)
                ]
            ))
            result.append(NSAttributedString(
                string: L10n(step.title),
                attributes: [
                    .font: NSFont.systemFont(ofSize: 10.5, weight: .semibold),
                    .foregroundColor: NSColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
                ]
            ))
            if let detail = step.detail {
                let paragraph = NSMutableParagraphStyle()
                paragraph.headIndent = 20
                paragraph.firstLineHeadIndent = 20
                paragraph.paragraphSpacingBefore = 3
                paragraph.lineBreakMode = .byCharWrapping
                result.append(NSAttributedString(
                    string: "\n│  \(detail)",
                    attributes: [
                        .font: detailFont(step.kind),
                        .foregroundColor: NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1),
                        .paragraphStyle: paragraph
                    ]
                ))
            }
            if index < steps.count - 1 {
                result.append(NSAttributedString(string: "\n\n"))
            }
        }
        return result
    }

    private static func markerColor(_ state: NativeExecutionTimelineStep.State) -> NSColor {
        switch state {
        case .running: .controlAccentColor
        case .completed: .systemGreen
        case .failed: .systemRed
        case .cancelled: .secondaryLabelColor
        }
    }

    private static func kindColor(_ kind: NativeExecutionTimelineStep.Kind) -> NSColor {
        switch kind {
        case .context: .secondaryLabelColor
        case .action: .controlAccentColor
        case .result: .systemOrange
        }
    }

    private static func detailFont(_ kind: NativeExecutionTimelineStep.Kind) -> NSFont {
        kind == .action
            ? .monospacedSystemFont(ofSize: 9.5, weight: .regular)
            : .systemFont(ofSize: 10, weight: .regular)
    }
}

