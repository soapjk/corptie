import Foundation
import CorptieClientCore
#if canImport(AppKit)
import AppKit
private typealias ExecutionFont = NSFont
private typealias ExecutionColor = NSColor
#else
import UIKit
private typealias ExecutionFont = UIFont
private typealias ExecutionColor = UIColor
#endif

@MainActor
public enum ExecutionTimelineAttributedText {
    public static func make(steps: [ConversationExecutionStep], localize: (String) -> String = { $0 }) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        for (index, step) in steps.enumerated() {
            let marker = NSMutableAttributedString(
                string: "\(step.state.marker)  ",
                attributes: [
                    .font: ExecutionFont.systemFont(ofSize: 10.5, weight: .bold),
                    .foregroundColor: markerColor(step.state)
                ]
            )
            result.append(marker)
            result.append(NSAttributedString(
                string: "\(localize(step.kind.label).uppercased())  ",
                attributes: [
                    .font: ExecutionFont.systemFont(ofSize: 8.5, weight: .bold),
                    .foregroundColor: kindColor(step.kind)
                ]
            ))
            result.append(NSAttributedString(
                string: localize(step.title),
                attributes: [
                    .font: ExecutionFont.systemFont(ofSize: 10.5, weight: .semibold),
                    .foregroundColor: secondaryText
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
                        .foregroundColor: mutedText,
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

    private static func markerColor(_ state: ConversationExecutionStep.State) -> ExecutionColor {
        switch state {
        case .running: accentColor
        case .completed: .systemGreen
        case .failed: .systemRed
        case .cancelled: secondaryColor
        }
    }

    private static func kindColor(_ kind: ConversationExecutionStep.Kind) -> ExecutionColor {
        switch kind {
        case .context: secondaryColor
        case .action: accentColor
        case .result: .systemOrange
        }
    }

    private static func detailFont(_ kind: ConversationExecutionStep.Kind) -> ExecutionFont {
        kind == .action
            ? .monospacedSystemFont(ofSize: 9.5, weight: .regular)
            : .systemFont(ofSize: 10, weight: .regular)
    }

    #if canImport(AppKit)
    private static let accentColor = ExecutionColor.controlAccentColor
    private static let secondaryColor = ExecutionColor.secondaryLabelColor
    private static let secondaryText = ExecutionColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    private static let mutedText = ExecutionColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
    #else
    private static let accentColor = ExecutionColor.tintColor
    private static let secondaryColor = ExecutionColor.secondaryLabel
    private static let secondaryText = ExecutionColor(red: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    private static let mutedText = ExecutionColor(red: 0.38, green: 0.41, blue: 0.43, alpha: 1)
    #endif
}

