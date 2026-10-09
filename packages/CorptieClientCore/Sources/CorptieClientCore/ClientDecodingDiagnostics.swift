import Foundation
import OSLog

public enum ClientDecodingDiagnostics {
    /// Never logs payload bytes or the decoder's debug description (which can
    /// contain message text). Keep only route/context, category and coding path.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data, context: String) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch {
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
