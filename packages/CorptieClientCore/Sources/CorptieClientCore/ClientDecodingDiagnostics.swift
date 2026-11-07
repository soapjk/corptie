import Foundation
import OSLog

public enum ClientDecodingDiagnostics {
    /// Never logs payload bytes or the decoder's debug description (which can
    /// contain message text). Keep only route/context, category and coding path.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data, context: String) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch {
            ClientFailureDiagnostics.log(error, operation: "ClientDecodingDiagnostics.decode")
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

    public static func log(_ error: any Error, operation: String) {
        guard !Task.isCancelled, !(error is CancellationError) else { return }
        let root = error as NSError
        guard !(root.domain == NSURLErrorDomain && root.code == NSURLErrorCancelled) else { return }
        guard gate.allows(operation) else { return }
        var current: NSError? = root
        var seen = Set<ObjectIdentifier>()
        var chain: [String] = []
        while let item = current, chain.count < 8, seen.insert(ObjectIdentifier(item)).inserted {
            // Only fixed system domains are safe for persisted public diagnostics.
            let domains = [NSPOSIXErrorDomain, NSURLErrorDomain, NSCocoaErrorDomain, NSOSStatusErrorDomain, "HTTP"]
            let domain = domains.contains(item.domain) ? item.domain : "custom-domain"
            chain.append("\(domain):\(item.code)")
            current = item.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        logger.error("operation=\(operation, privacy: .public) causes=\(chain.joined(separator: " <- "), privacy: .public)")
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
