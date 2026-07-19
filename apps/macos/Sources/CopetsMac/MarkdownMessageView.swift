import AppKit
import SwiftUI
@preconcurrency import MarkdownUI

struct MarkdownMessageView: View {
    let text: String
    var baseDirectory: String? = nil
    var fontSize: CGFloat = 11
    var fontWeight: Font.Weight = .medium
    var foregroundColor: Color = CorptiePalette.secondaryText
    var allowsSelection = true

    @ViewBuilder
    var body: some View {
        if allowsSelection {
            markdownContent
                .textSelection(.enabled)
        } else {
            markdownContent
        }
    }

    private var markdownContent: some View {
        Markdown(ClickableMessageText.markdown(from: text, baseDirectory: baseDirectory))
            .markdownTheme(.corptieMessage)
            .font(.system(size: fontSize, weight: fontWeight))
            .foregroundStyle(foregroundColor)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                MessageLinkOpener.open(url, baseDirectory: baseDirectory)
            })
    }
}

enum MessageLinkOpener {
    @MainActor
    static func open(_ url: URL, baseDirectory: String?) -> OpenURLAction.Result {
        if let scheme = url.scheme?.lowercased(), !scheme.isEmpty, scheme != "file" {
            return NSWorkspace.shared.open(url) ? .handled : .discarded
        }

        guard let fileURL = fileURL(from: url, baseDirectory: baseDirectory) else {
            return .discarded
        }
        return NSWorkspace.shared.open(fileURL) ? .handled : .discarded
    }

    static func fileURL(from url: URL, baseDirectory: String?) -> URL? {
        if url.isFileURL {
            return existingFileURL(url) ?? url.standardizedFileURL
        }

        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty {
            path = url.relativeString.removingPercentEncoding ?? url.relativeString
        }
        guard !path.isEmpty else { return nil }

        let expanded = (path as NSString).expandingTildeInPath
        let candidate: URL
        if expanded.hasPrefix("/") {
            candidate = URL(fileURLWithPath: expanded)
        } else if let baseDirectory, !baseDirectory.isEmpty {
            candidate = URL(fileURLWithPath: baseDirectory, isDirectory: true)
                .appendingPathComponent(expanded)
        } else {
            candidate = URL(fileURLWithPath: expanded)
        }
        return existingFileURL(candidate) ?? candidate.standardizedFileURL
    }

    private static func existingFileURL(_ url: URL) -> URL? {
        let path = url.path
        guard !FileManager.default.fileExists(atPath: path) else { return url.standardizedFileURL }
        let withoutLocation = path.replacingOccurrences(
            of: #":\d+(?::\d+)?$"#,
            with: "",
            options: .regularExpression
        )
        guard withoutLocation != path, FileManager.default.fileExists(atPath: withoutLocation) else {
            return nil
        }
        return URL(fileURLWithPath: withoutLocation).standardizedFileURL
    }
}

enum ClickableMessageText {
    private static let candidateRegex = try! NSRegularExpression(
        pattern: #"https?://[^\s<>\[\]]+|file://[^\s<>\[\]]+|(?<![\w])(?:~?/|\.\.?/)[^\s<>\[\]`]+|(?<![\w])(?:[\w.-]+/)+[\w.-]+\.[A-Za-z0-9]{1,12}"#,
        options: [.caseInsensitive]
    )
    private static let protectedRegex = try! NSRegularExpression(
        pattern: #"`[^`]*`|!?\[[^\]]*\]\([^\)]*\)|<(?:(?:https?|file)://)[^>]+>"#,
        options: [.caseInsensitive]
    )

    static func markdown(from text: String, baseDirectory: String?) -> String {
        var inFence = false
        return text.components(separatedBy: "\n").map { line in
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inFence.toggle()
                return line
            }
            return inFence ? line : linkCandidates(in: line, baseDirectory: baseDirectory)
        }.joined(separator: "\n")
    }

    private static func linkCandidates(in line: String, baseDirectory: String?) -> String {
        let fullRange = NSRange(line.startIndex..<line.endIndex, in: line)
        let protectedRanges = protectedRegex.matches(in: line, range: fullRange).map(\.range)
        let matches = candidateRegex.matches(in: line, range: fullRange).reversed()
        var result = line

        for match in matches where !protectedRanges.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) {
            guard let range = Range(match.range, in: result) else { continue }
            let rawCandidate = String(result[range])
            let candidate = trimmingTrailingPunctuation(from: rawCandidate)
            guard !candidate.isEmpty else { continue }

            let destination: URL?
            if candidate.lowercased().hasPrefix("http://") || candidate.lowercased().hasPrefix("https://") {
                destination = URL(string: candidate)
            } else if candidate.lowercased().hasPrefix("file://") {
                destination = URL(string: candidate)
            } else {
                destination = existingFileURL(for: candidate, baseDirectory: baseDirectory)
            }
            guard let destination else { continue }

            let suffix = rawCandidate.dropFirst(candidate.count)
            let label = candidate
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "[", with: "\\[")
                .replacingOccurrences(of: "]", with: "\\]")
            result.replaceSubrange(range, with: "[\(label)](<\(destination.absoluteString)>)\(suffix)")
        }
        return result
    }

    private static func existingFileURL(for path: String, baseDirectory: String?) -> URL? {
        let pathWithoutLocation = path.replacingOccurrences(
            of: #":\d+(?::\d+)?$"#,
            with: "",
            options: .regularExpression
        )
        let expanded = (pathWithoutLocation as NSString).expandingTildeInPath
        let url: URL
        if expanded.hasPrefix("/") {
            url = URL(fileURLWithPath: expanded)
        } else if let baseDirectory, !baseDirectory.isEmpty {
            url = URL(fileURLWithPath: baseDirectory, isDirectory: true).appendingPathComponent(expanded)
        } else {
            return nil
        }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url.standardizedFileURL
    }

    private static func trimmingTrailingPunctuation(from value: String) -> String {
        var result = value
        while let last = result.last, ".,;:!?，。；：！？".contains(last) {
            result.removeLast()
        }
        while result.last == ")", result.filter({ $0 == ")" }).count > result.filter({ $0 == "(" }).count {
            result.removeLast()
        }
        return result
    }
}

private extension Theme {
    @MainActor
    static let corptieMessage = Theme.gitHub
        .text {
            FontSize(11)
        }
        .heading1 { configuration in
            compactHeading(configuration, size: 1.45, top: 8, bottom: 5)
        }
        .heading2 { configuration in
            compactHeading(configuration, size: 1.3, top: 7, bottom: 4)
        }
        .heading3 { configuration in
            compactHeading(configuration, size: 1.18, top: 6, bottom: 4)
        }
        .heading4 { configuration in
            compactHeading(configuration, size: 1.08, top: 5, bottom: 3)
        }
        .heading5 { configuration in
            compactHeading(configuration, size: 1, top: 5, bottom: 3)
        }
        .heading6 { configuration in
            compactHeading(configuration, size: 0.95, top: 5, bottom: 3)
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.18))
                .markdownMargin(top: 0, bottom: 7)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.18))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.9))
                    }
                    .padding(9)
            }
            .background(Color.black.opacity(0.045))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .markdownMargin(top: 1, bottom: 7)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: .em(0.12))
        }

    @MainActor
    static func compactHeading(
        _ configuration: BlockConfiguration,
        size: Double,
        top: CGFloat,
        bottom: CGFloat
    ) -> some View {
        configuration.label
            .relativeLineSpacing(.em(0.1))
            .markdownMargin(top: top, bottom: bottom)
            .markdownTextStyle {
                FontWeight(.semibold)
                FontSize(.em(size))
            }
    }
}
