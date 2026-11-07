import Foundation
import OSLog

public enum ClientDecodingDiagnostics {
    /// Never logs payload bytes or the decoder's debug description (which can
    /// contain message text). Keep only route/context, category and coding path.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data, context: String) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch {
            ClientFailureDiagnostics.log(error, operation: "ClientDecodingDiagnostics.decode")
            let category: String
            let path: [any CodingKey]
            switch error {
            case DecodingError.dataCorrupted(let detail): category = "dataCorrupted"; path = detail.codingPath
            case DecodingError.typeMismatch(_, let detail): category = "typeMismatch"; path = detail.codingPath
            case DecodingError.valueNotFound(_, let detail): category = "valueNotFound"; path = detail.codingPath
            case DecodingError.keyNotFound(let key, let detail): category = "keyNotFound"; path = detail.codingPath + [key]
            default: category = "other"; path = []
            }
            let field = path.map(\.stringValue).joined(separator: ".")
            Logger(subsystem: "com.corptie.client", category: "decoding").error(
                "context=\(context, privacy: .public) kind=\(category, privacy: .public) field=\(field, privacy: .public) bytes=\(data.count)")
            throw error
        }
    }
}

/// Logging only: no payloads, error descriptions, credentials or business state.
public enum ClientFailureDiagnostics {
    private static let logger = Logger(subsystem: "com.corptie.client", category: "failure")
    private static let gate = Gate()
    private final class Gate: @unchecked Sendable {
        let lock = NSLock()
        var last: [String: Date] = [:]
        func allows(_ operation: String) -> Bool {
            lock.lock(); defer { lock.unlock() }
            let now = Date()
            if let previous = last[operation], now.timeIntervalSince(previous) < 60 { return false }
            // Static callsite labels only; retain a bounded amount of log state.
            if last.count >= 512 { last.removeAll(keepingCapacity: true) }
            last[operation] = now
            return true
        }
    }

    static func summary(_ error: any Error) -> String {
        let root = error as NSError
        var current: NSError? = root
        var seen = Set<ObjectIdentifier>()
        var chain: [String] = []
        while let item = current, chain.count < 8, seen.insert(ObjectIdentifier(item)).inserted {
            let domains = [NSPOSIXErrorDomain, NSURLErrorDomain, NSCocoaErrorDomain, NSOSStatusErrorDomain, "HTTP"]
            let domain = domains.contains(item.domain) ? item.domain : "custom-domain"
            chain.append("\(domain):\(item.code)")
            current = item.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        if current != nil { chain.append("[cycle-or-depth-limit]") }
        var detail = chain.joined(separator: " <- ")
        if root.domain == "HTTP", let bytes = root.userInfo["responseBytes"] as? Int, bytes >= 0 {
            detail += " responseBytes=\(bytes)"
        }
        if let failure = error as? ClientServiceFailure {
            let valid = !failure.code.isEmpty && failure.code.utf8.count <= 100
                && failure.code.utf8.allSatisfy { (65...90).contains($0) || (48...57).contains($0) || $0 == 95 }
            detail += " serviceStatus=\(failure.statusCode) serviceCode=\(valid ? failure.code : "unclassified")"
        }
        return detail
    }

    public static func log(_ error: any Error, operation: String, sessionID: String? = nil) {
        guard !Task.isCancelled, !(error is CancellationError) else { return }
        let root = error as NSError
        guard !(root.domain == NSURLErrorDomain && root.code == NSURLErrorCancelled) else { return }
        let detail = summary(error)
        let safeSession: String
        if let sessionID, sessionID.utf8.count <= 200,
           sessionID.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 58, 95].contains($0) }) {
            safeSession = sessionID
        } else { safeSession = "absent" }
        guard gate.allows(operation + ":" + safeSession + ":" + detail) else { return }
        logger.error("operation=\(operation, privacy: .public) session=\(safeSession, privacy: .public) causes=\(detail, privacy: .public)")
        let category: String
        let path: [any CodingKey]
        switch error {
        case DecodingError.dataCorrupted(let detail): category = "dataCorrupted"; path = detail.codingPath
        case DecodingError.typeMismatch(_, let detail): category = "typeMismatch"; path = detail.codingPath
        case DecodingError.valueNotFound(_, let detail): category = "valueNotFound"; path = detail.codingPath
        case DecodingError.keyNotFound(let key, let detail): category = "keyNotFound"; path = detail.codingPath + [key]
        default: return
        }
        let field = path.prefix(32).map { String($0.stringValue.prefix(128)) }.joined(separator: ".")
        logger.error("operation=\(operation, privacy: .public) kind=\(category, privacy: .public) field=\(field, privacy: .private)")
    }
}
