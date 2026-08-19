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
    /// When `false`, the owning bubble provides a measured width. Markdown then
    /// wraps inside that proposal instead of owning the card's width policy.
    var fillWidth = true
    /// 当 `fillWidth == false` 时气泡收缩到的最大宽度（对应 Rudder `max-w-[72ch]`）。
    var maxContentWidth: CGFloat? = nil

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
        let preparedContent = MarkdownRenderCache.shared.content(
            text: text,
            baseDirectory: baseDirectory
        )
        let content = Markdown(preparedContent)
            .markdownTheme(.corptieMessage)
            .font(.system(size: fontSize, weight: fontWeight))
            .foregroundStyle(foregroundColor)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.openURL, OpenURLAction { url in
                MessageLinkOpener.open(url, baseDirectory: baseDirectory)
            })
        return Group {
            if fillWidth {
                content.frame(maxWidth: .infinity, alignment: .leading)
            } else if let maxContentWidth {
                // maxContentWidth 只是富文本安全上限；真正的气泡宽度由外层共享策略决定。
                content.frame(maxWidth: maxContentWidth, alignment: .leading)
            } else {
                content.fixedSize()
            }
        }
    }
}

/// Caches both Corptie's link preparation and MarkdownUI's parsed block tree.
///
/// Keeping only the session snapshot warm still leaves Markdown parsing on the
/// main-thread click path. SessionsView preheats this cache incrementally, and
/// normal rendering uses the same entry point so a miss is still correct.
@MainActor
final class MarkdownRenderCache {
    private struct Key: Hashable {
        let text: String
        let baseDirectory: String?
    }

    private struct Entry {
        let content: MarkdownContent
        let characterCost: Int
    }

    static let shared = MarkdownRenderCache()

    private var entries: [Key: Entry] = [:]
    private var recency: [Key] = []
    private var totalCharacterCost = 0
    private let entryLimit = 512
    private let characterLimit = 2_000_000

    func content(text: String, baseDirectory: String?) -> MarkdownContent {
        let key = Key(text: text, baseDirectory: normalized(baseDirectory))
        if let entry = entries[key] {
            touch(key)
            return entry.content
        }

        let content = ChatPerformanceTrace.measure("markdown.preprocess") {
            ChatPerformanceRecorder.shared.increment(.markdownPreprocesses)
            ChatPerformanceRecorder.shared.increment(.markdownCharacters, by: Int64(text.count))
            let preparedMarkdown = ClickableMessageText.markdown(
                from: text,
                baseDirectory: key.baseDirectory
            )
            return MarkdownContent(preparedMarkdown)
        }
        // The source and parsed tree are both retained. A conservative source
        // multiplier bounds the cache without walking the parsed tree again.
        let characterCost = max(1, text.count * 2)
        entries[key] = Entry(content: content, characterCost: characterCost)
        recency.append(key)
        totalCharacterCost += characterCost
        evictIfNeeded()
        return content
    }

    func contains(text: String, baseDirectory: String?) -> Bool {
        entries[Key(text: text, baseDirectory: normalized(baseDirectory))] != nil
    }

    func removeAllForTesting() {
        entries.removeAll(keepingCapacity: false)
        recency.removeAll(keepingCapacity: false)
        totalCharacterCost = 0
    }

    private func normalized(_ baseDirectory: String?) -> String? {
        guard let value = baseDirectory?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private func touch(_ key: Key) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }

    private func evictIfNeeded() {
        while recency.count > entryLimit || totalCharacterCost > characterLimit,
              let oldest = recency.first {
            recency.removeFirst()
            guard let removed = entries.removeValue(forKey: oldest) else { continue }
            totalCharacterCost = max(0, totalCharacterCost - removed.characterCost)
        }
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

    @MainActor
    static func markdown(from text: String, baseDirectory: String?) -> String {
        ClickableMessageTextCache.shared.markdown(from: text, baseDirectory: baseDirectory)
    }

    static func rewriteLinks(in text: String, baseDirectory: String?) -> String {
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

/// 缓存链接重写结果。此前 `ClickableMessageText.markdown` 在每次消息行重建时都会
/// 重跑两个正则 + 对文件路径候选做磁盘 IO，而结果并未缓存（`NativeMarkdownTextCache`
/// 只缓存了后续的 attributed-string 转换）。这里补上输入侧缓存，与 MarkdownUI 的
/// `MarkdownRenderCache` 对称。
@MainActor
final class ClickableMessageTextCache {
    private struct Key: Hashable {
        let text: String
        let baseDirectory: String?
    }

    static let shared = ClickableMessageTextCache()

    private var values: [Key: String] = [:]
    private var recency: [Key] = []
    private var totalCharacterCost = 0
    private let entryLimit = 1_000
    private let characterLimit = 2_000_000

    func markdown(from text: String, baseDirectory: String?) -> String {
        let key = Key(text: text, baseDirectory: normalized(baseDirectory))
        if let cached = values[key] {
            touch(key)
            return cached
        }
        let result = ClickableMessageText.rewriteLinks(in: text, baseDirectory: key.baseDirectory)
        values[key] = result
        recency.append(key)
        totalCharacterCost += max(1, text.count)
        evictIfNeeded()
        return result
    }

    func contains(text: String, baseDirectory: String?) -> Bool {
        values[Key(text: text, baseDirectory: normalized(baseDirectory))] != nil
    }

    func removeAllForTesting() {
        values.removeAll(keepingCapacity: false)
        recency.removeAll(keepingCapacity: false)
        totalCharacterCost = 0
    }

    private func normalized(_ baseDirectory: String?) -> String? {
        guard let value = baseDirectory?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private func touch(_ key: Key) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }

    private func evictIfNeeded() {
        while recency.count > entryLimit || totalCharacterCost > characterLimit,
              let oldest = recency.first {
            recency.removeFirst()
            guard values.removeValue(forKey: oldest) != nil else { continue }
            totalCharacterCost = max(0, totalCharacterCost - max(1, oldest.text.count))
        }
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
