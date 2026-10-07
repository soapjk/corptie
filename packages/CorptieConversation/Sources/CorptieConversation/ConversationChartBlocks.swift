import Foundation
import SwiftUI
import Charts
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif

/// A chart is a presentation of text already owned by one assistant message.
/// Parsing never changes the authoritative message or creates a timeline item.
public struct ConversationChartSpec: Hashable, Sendable {
    public enum Kind: String, Decodable, Hashable, Sendable { case bar, line, pie }
    public enum X: Hashable, Sendable { case number(Double), date(Date, source: String) }

    public struct Datum: Hashable, Sendable {
        public let label: String?
        public let x: X?
        public let value: Double
    }

    public let kind: Kind
    public let title: String
    public let unit: String?
    public let sourceNote: String?
    public let data: [Datum]
}

/// Data-table and TSV text must not round a small nonzero value to zero or
/// discard a timestamp's seconds/timezone. The plotted Double/Date remains
/// separate from the original display value.
enum ConversationChartDataText {
    static func label(for point: ConversationChartSpec.Datum, index: Int) -> String {
        if let label = point.label { return label }
        switch point.x {
        case .number(let value): return number(value)
        case .date(_, let source): return source
        case nil: return "\(index + 1)"
        }
    }

    static func value(for point: ConversationChartSpec.Datum, unit: String?) -> String {
        let exact = number(point.value)
        return unit.map { "\(exact) \($0)" } ?? exact
    }

    private static func number(_ value: Double) -> String {
        let text = String(value) // Shortest representation that round-trips to this Double.
        return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
    }
}

public enum ConversationContentBlock: Equatable, Sendable {
    case markdown(String)
    case table(ConversationMarkdownTable)
    case chart(ConversationChartSpec, originalText: String)
    case invalidChart(originalText: String, reason: String)
}

/// Identity is local to the authoritative message. Append-only streaming keeps
/// every complete block's UTF-16 start stable, even when a later fence closes.
public struct ConversationLocatedContentBlock: Identifiable, Equatable, Sendable {
    public let id: String
    public let startUTF16: Int
    public let content: ConversationContentBlock

    public init(messageID: String, startUTF16: Int, content: ConversationContentBlock) {
        self.id = "\(messageID):\(startUTF16)"
        self.startUTF16 = startUTF16
        self.content = content
    }
}

public enum ConversationChartBlocks {
    public static let maximumCharts = 4
    public static let maximumFenceBytes = 32 * 1_024
    public static let maximumPoints = 100

    private struct Fence {
        let marker: Character
        let length: Int
        let info: String
    }

    /// CommonMark permits up to three leading spaces; four spaces create an
    /// indented code block instead. The chart protocol itself requires exactly
    /// three opening backticks and the exact `corptie-chart` info string.
    private static func openingFence(_ line: Substring) -> Fence? {
        let leadingSpaces = line.prefix(while: { $0 == " " }).count
        guard leadingSpaces <= 3 else { return nil }
        let content = line.dropFirst(leadingSpaces)
        guard let marker = content.first, marker == "`" || marker == "~" else { return nil }
        let length = content.prefix(while: { $0 == marker }).count
        guard length >= 3 else { return nil }
        let info = String(content.dropFirst(length)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard marker != "`" || !info.contains("`") else { return nil }
        return Fence(marker: marker, length: length, info: info)
    }

    private static func closes(_ line: Substring, fence: Fence) -> Bool {
        guard let candidate = openingFence(line) else { return false }
        return candidate.marker == fence.marker && candidate.length >= fence.length
            && candidate.info.isEmpty
    }

    /// A complete, valid fenced block is replaced in-place. Every other byte
    /// remains Markdown, including an unfinished block during streaming.
    public static func parse(_ text: String) -> [ConversationContentBlock] {
        parseLocated(text, messageID: "").map(\.content)
    }

    public static func parseLocated(_ text: String, messageID: String) -> [ConversationLocatedContentBlock] {
        var result: [ConversationLocatedContentBlock] = []
        var ordinaryStart = text.startIndex
        var ordinaryStartOffset = 0
        var cursor = text.startIndex
        var cursorOffset = 0
        var ordinaryFence: Fence?
        var chartCount = 0
        var invalidChartCount = 0

        while cursor < text.endIndex {
            let lineEnd = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
            let next = lineEnd < text.endIndex ? text.index(after: lineEnd) : lineEnd
            let nextOffset = cursorOffset + text[cursor..<next].utf16.count
            let line = text[cursor..<lineEnd]

            if let activeFence = ordinaryFence {
                if closes(line, fence: activeFence) { ordinaryFence = nil }
                cursor = next
                cursorOffset = nextOffset
                continue
            }
            let opening = openingFence(line)
            if let opening, opening.marker == "`", opening.length == 3,
               opening.info == "corptie-chart" {
                var closingStart = next
                var closingStartOffset = nextOffset
                var closingEnd: String.Index?
                var closingEndOffset = nextOffset
                while closingStart < text.endIndex {
                    let end = text[closingStart...].firstIndex(of: "\n") ?? text.endIndex
                    let after = end < text.endIndex ? text.index(after: end) : end
                    let afterOffset = closingStartOffset + text[closingStart..<after].utf16.count
                    if closes(text[closingStart..<end], fence: opening) {
                        closingEnd = after
                        closingEndOffset = afterOffset
                        break
                    }
                    closingStart = after
                    closingStartOffset = afterOffset
                }
                if let closingEnd {
                    let payload = String(text[next..<closingStart])
                    let original = String(text[cursor..<closingEnd])
                    let candidate: ConversationContentBlock
                    if chartCount >= maximumCharts {
                        candidate = .invalidChart(originalText: original,
                            reason: "每条消息最多展示 4 个图表，已保留原文")
                    } else if payload.utf8.count > maximumFenceBytes {
                        candidate = .invalidChart(originalText: original,
                            reason: "图表数据超过 32 KiB，已保留原文")
                    } else if let spec = decode(payload) {
                        candidate = .chart(spec, originalText: original)
                    } else {
                        candidate = .invalidChart(originalText: original,
                            reason: "图表格式或数据无效，已保留原文")
                    }
                    // Keep invalid/excess fences as ordinary Markdown after a
                    // bounded number of diagnostics. This preserves every byte
                    // without creating an unbounded number of error subviews.
                    if case .invalidChart = candidate, invalidChartCount >= maximumCharts {
                        cursor = closingEnd
                        cursorOffset = closingEndOffset
                        continue
                    }
                    if ordinaryStart < cursor {
                        result.append(.init(messageID: messageID, startUTF16: ordinaryStartOffset,
                            content: .markdown(String(text[ordinaryStart..<cursor]))))
                    }
                    result.append(.init(messageID: messageID, startUTF16: cursorOffset,
                        content: candidate))
                    if case .chart = candidate { chartCount += 1 }
                    if case .invalidChart = candidate { invalidChartCount += 1 }
                    ordinaryStart = closingEnd
                    ordinaryStartOffset = closingEndOffset
                    cursor = closingEnd
                    cursorOffset = closingEndOffset
                    continue
                }
                // An unfinished stream remains exactly as ordinary Markdown.
                break
            }
            if let opening { ordinaryFence = opening }
            cursor = next
            cursorOffset = nextOffset
        }
        if ordinaryStart < text.endIndex {
            result.append(.init(messageID: messageID, startUTF16: ordinaryStartOffset,
                content: .markdown(String(text[ordinaryStart...]))))
        }
        return result
    }

    private struct RawSpec: Decodable {
        let version: Int
        let type: ConversationChartSpec.Kind
        let title: String
        let unit: String?
        let sourceNote: String?
        let data: [RawDatum]
    }

    private struct RawDatum: Decodable {
        let label: String?
        let x: RawX?
        let value: Double
    }

    private enum RawX: Decodable {
        case number(Double), text(String)

        init(from decoder: Decoder) throws {
            let value = try decoder.singleValueContainer()
            if let number = try? value.decode(Double.self) { self = .number(number) }
            else { self = .text(try value.decode(String.self)) }
        }
    }

    private static func decode(_ payload: String) -> ConversationChartSpec? {
        guard let data = payload.data(using: .utf8),
              let raw = try? JSONDecoder().decode(RawSpec.self, from: data),
              raw.version == 1, !raw.data.isEmpty,
              raw.data.count <= (raw.type == .pie ? 7 : maximumPoints),
              validText(raw.title, limit: 120),
              raw.unit.map({ validText($0, limit: 40) }) ?? true,
              raw.sourceNote.map({ validText($0, limit: 300) }) ?? true else { return nil }

        var points: [ConversationChartSpec.Datum] = []
        var lineXKind: Int?
        var previousNumber: Double?
        var previousDate: Date?
        var categoryLabels = Set<String>()
        let dateParser = ISO8601DateFormatter()
        dateParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let basicDateParser = ISO8601DateFormatter()
        basicDateParser.formatOptions = [.withInternetDateTime]
        let dateOnlyParser = ISO8601DateFormatter()
        dateOnlyParser.formatOptions = [.withFullDate]
        // A date without a timezone is a calendar day, not a GMT instant.
        // Keep the plotted day stable in the viewer's local calendar.
        dateOnlyParser.timeZone = .current

        for item in raw.data {
            guard item.value.isFinite else { return nil }
            switch raw.type {
            case .bar, .pie:
                guard let label = item.label, validText(label, limit: 100), item.x == nil,
                      raw.type != .pie || item.value > 0 else { return nil }
                // Swift Charts stacks bars with the same categorical Y value
                // and assigns equal pie labels the same style. V1 has no
                // aggregation semantics, so never silently change the data.
                guard categoryLabels.insert(label.trimmingCharacters(in: .whitespacesAndNewlines)).inserted
                else { return nil }
                points.append(.init(label: label, x: nil, value: item.value))
            case .line:
                guard item.label == nil, let x = item.x else { return nil }
                let projected: ConversationChartSpec.X
                switch x {
                case .number(let number):
                    guard number.isFinite, lineXKind == nil || lineXKind == 0,
                          previousNumber.map({ number > $0 }) ?? true else { return nil }
                    lineXKind = 0
                    previousNumber = number
                    projected = .number(number)
                case .text(let value):
                    guard value.count <= 40, lineXKind == nil || lineXKind == 1,
                          strictISO8601DateText(value, dayParser: dateOnlyParser),
                          let date = dateParser.date(from: value) ?? basicDateParser.date(from: value)
                            ?? dateOnlyParser.date(from: value),
                          previousDate.map({ date > $0 }) ?? true else { return nil }
                    lineXKind = 1
                    previousDate = date
                    projected = .date(date, source: value)
                }
                points.append(.init(label: nil, x: projected, value: item.value))
            }
        }
        guard raw.type != .pie || points.reduce(0, { $0 + $1.value }).isFinite else { return nil }
        return .init(kind: raw.type, title: raw.title, unit: raw.unit,
                     sourceNote: raw.sourceNote, data: points)
    }

    private static func strictISO8601DateText(_ value: String, dayParser: ISO8601DateFormatter) -> Bool {
        // ISO8601DateFormatter accepts valid prefixes with trailing garbage.
        // It also normalizes impossible dates and accepts out-of-range UTC
        // offsets, so check the calendar day and offset before parsing.
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$"#,
                          options: .regularExpression) != nil else { return false }
        let day = String(value.prefix(10))
        guard let parsedDay = dayParser.date(from: day),
              dayParser.string(from: parsedDay) == day else { return false }
        guard value.count > 10, !value.hasSuffix("Z") else { return true }
        let offset = value.suffix(6)
        guard let hours = Int(offset.dropFirst().prefix(2)),
              let minutes = Int(offset.suffix(2)) else { return false }
        return hours <= 23 && minutes <= 59
    }

    private static func validText(_ value: String, limit: Int) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && value.count <= limit
            && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
}

/// Keeps chart JSON decoding out of repeated SwiftUI body evaluation. The
/// authoritative text, not an append-only stream offset, decides invalidation.
@MainActor
public final class ConversationChartBlockCache {
    public static let shared = ConversationChartBlockCache()

    private struct Entry {
        let text: String
        let blocks: [ConversationLocatedContentBlock]
        let byteCount: Int
        var access: UInt64
    }

    private var entries: [String: Entry] = [:]
    private var accessSequence: UInt64 = 0
    private var retainedBytes = 0
    private let maximumEntries = 128
    private let maximumBytes = 8 * 1_024 * 1_024

    public func blocks(messageID: String, authoritativeText: String) -> [ConversationContentBlock] {
        locatedBlocks(messageID: messageID, authoritativeText: authoritativeText).map(\.content)
    }

    public func locatedBlocks(messageID: String, authoritativeText: String) -> [ConversationLocatedContentBlock] {
        accessSequence &+= 1
        if var entry = entries[messageID], entry.text == authoritativeText {
            entry.access = accessSequence
            entries[messageID] = entry
            return entry.blocks
        }
        if let previous = entries.removeValue(forKey: messageID) {
            retainedBytes -= previous.byteCount
        }
        let blocks = ConversationMarkdownTables.expanding(
            ConversationChartBlocks.parseLocated(authoritativeText, messageID: messageID),
            messageID: messageID)
        let bytes = authoritativeText.utf16.count * 2
            + blocks.reduce(0) { total, block in
                switch block.content {
                case .markdown(let value): total + value.utf16.count * 2
                case .table(let table): total + table.originalText.utf16.count * 6 + 512
                case .chart(_, let original), .invalidChart(let original, _):
                    total + original.utf16.count * 2 + 512
                }
            }
        if bytes > maximumBytes { return blocks }
        entries[messageID] = Entry(text: authoritativeText, blocks: blocks,
                                   byteCount: bytes, access: accessSequence)
        retainedBytes += bytes
        while entries.count > maximumEntries || retainedBytes > maximumBytes {
            guard let oldest = entries.min(by: { $0.value.access < $1.value.access })?.key,
                  let removed = entries.removeValue(forKey: oldest) else { break }
            retainedBytes -= removed.byteCount
        }
        return blocks
    }
}

/// Both clients render the same validated specification; this view has no
/// network, script, or file access. It is hosted only for visible message rows.
public struct ConversationChartView: View {
    public static let contentHeight: CGFloat = 150
    public let spec: ConversationChartSpec
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var titleSize: CGFloat = 11
    @State private var showsData = false
    private let measuresLayoutOnly: Bool

    public init(spec: ConversationChartSpec) {
        self.spec = spec
        measuresLayoutOnly = false
    }

    private init(spec: ConversationChartSpec, measuresLayoutOnly: Bool) {
        self.spec = spec
        self.measuresLayoutOnly = measuresLayoutOnly
    }

    #if os(macOS)
    private struct MeasurementRoot: View {
        let spec: ConversationChartSpec
        let width: CGFloat

        var body: some View {
            ConversationChartView(spec: spec, measuresLayoutOnly: true)
                .frame(width: width)
        }
    }

    @MainActor private static var measurementHost: NSHostingView<MeasurementRoot>?

    @MainActor public static func measuredHeight(spec: ConversationChartSpec, width: CGFloat) -> CGFloat {
        let root = MeasurementRoot(spec: spec, width: width)
        let host: NSHostingView<MeasurementRoot>
        if let existing = measurementHost {
            existing.rootView = root
            host = existing
        } else {
            host = NSHostingView(rootView: root)
            measurementHost = host
        }
        host.frame = NSRect(x: 0, y: 0, width: width, height: 1)
        host.layoutSubtreeIfNeeded()
        return ceil(host.fittingSize.height)
    }
    #endif

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(spec.title).font(.system(size: titleSize, weight: .semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let unit = spec.unit {
                    Text(unit).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(unit)
                }
            }
            if showsData {
                ScrollView { dataRows.frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(height: Self.contentHeight)
            } else if measuresLayoutOnly {
                Color.clear.frame(height: Self.contentHeight)
            } else {
                chartPlot
                .frame(height: Self.contentHeight)
                .accessibilityLabel("\(spec.title)，\(spec.data.count) 个数据点")
            }

            if let note = spec.sourceNote {
                Text("模型注明：\(note)").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button(showsData ? "查看图表" : "查看数据") {
                    showsData.toggle()
                }
                .lineLimit(1)
                .accessibilityValue(showsData ? "数据已展开" : "数据已收起")
                Button("复制数据", systemImage: "doc.on.doc") { copyData() }
            }
            .font(.caption2)
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
        }
        .padding(9)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 9))
        .accessibilityIdentifier("conversation-inline-chart")
    }

    @ViewBuilder private var chartPlot: some View {
        let plot = Chart {
            switch spec.kind {
            case .bar:
                ForEach(spec.data.indices, id: \.self) { index in
                    BarMark(x: .value("数值", spec.data[index].value),
                            y: .value("类别", spec.data[index].label ?? ""))
                        .foregroundStyle(.tint)
                }
            case .pie:
                ForEach(spec.data.indices, id: \.self) { index in
                    SectorMark(angle: .value("数值", spec.data[index].value))
                        .foregroundStyle(by: .value("类别", spec.data[index].label ?? ""))
                }
            case .line:
                ForEach(spec.data.indices, id: \.self) { index in
                    if let x = spec.data[index].x {
                        switch x {
                        case .number(let value):
                            LineMark(x: .value("X", value), y: .value("数值", spec.data[index].value))
                                .foregroundStyle(.tint)
                        case .date(let value, _):
                            LineMark(x: .value("时间", value), y: .value("数值", spec.data[index].value))
                                .foregroundStyle(.tint)
                        }
                    }
                }
            }
        }
        if spec.kind == .bar && spec.data.count > 7 {
            // Apple's categorical visible domain is expressed as a count of
            // categories. Keep seven readable bars in the fixed-height card;
            // the remaining validated data stays available by scrolling.
            plot.chartScrollableAxes(.vertical)
                .chartYVisibleDomain(length: 7)
        } else {
            plot
        }
    }

    private var symbol: String {
        switch spec.kind {
        case .bar: "chart.bar.xaxis"
        case .line: "chart.xyaxis.line"
        case .pie: "chart.pie"
        }
    }

    private var dataRows: some View {
        LazyVStack(alignment: .leading, spacing: 3) {
            ForEach(spec.data.indices, id: \.self) { index in
                HStack {
                    Text(ConversationChartDataText.label(for: spec.data[index], index: index))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    Spacer(minLength: 8)
                    Text(ConversationChartDataText.value(for: spec.data[index], unit: spec.unit))
                        .monospacedDigit()
                }
                .font(.caption2)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(ConversationChartDataText.label(for: spec.data[index], index: index))，\(ConversationChartDataText.value(for: spec.data[index], unit: spec.unit))")
            }
        }
    }

    private func copyData() {
        let rows = [spec.title] + spec.data.indices.map {
            "\(ConversationChartDataText.label(for: spec.data[$0], index: $0))\t\(ConversationChartDataText.value(for: spec.data[$0], unit: spec.unit))"
        }
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(rows.joined(separator: "\n"), forType: .string)
        #else
        UIPasteboard.general.string = rows.joined(separator: "\n")
        #endif
    }
}
