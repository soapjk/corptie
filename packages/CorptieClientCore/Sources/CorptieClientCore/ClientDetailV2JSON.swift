import Foundation

/// Raw-token validation runs before Codable can discard duplicate keys.
/// Wire object keys are printable ASCII; content string values remain Unicode.
enum ClientDetailV2JSON {
    static func decode(_ data: Data) throws -> ClientInspectorValue {
        guard data.count <= 256 * 1024 else { throw ClientDetailV2Canonical.Failure.limit }
        guard String(data: data, encoding: .utf8) != nil else { throw ClientDetailV2Canonical.Failure.shape }
        var scanner = Scanner(bytes: Array(data)); try scanner.value(depth: 0); scanner.space()
        guard scanner.offset == scanner.bytes.count else { throw ClientDetailV2Canonical.Failure.shape }
        let value = try JSONDecoder().decode(ClientInspectorValue.self, from: data)
        _ = try ClientDetailV2Canonical.encode(value)
        return value
    }
    private struct Scanner {
        let bytes: [UInt8]
        var offset = 0
        var current: UInt8? { offset < bytes.count ? bytes[offset] : nil }
        mutating func space() { while let c = current, [9, 10, 13, 32].contains(c) { offset += 1 } }
        mutating func string() throws -> String {
            guard current == 34 else { throw ClientDetailV2Canonical.Failure.shape }
            let start = offset; offset += 1
            while let c = current {
                offset += 1
                if c == 92 { guard current != nil else { throw ClientDetailV2Canonical.Failure.shape }; offset += 1 }
                else if c == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<offset])) }
            }
            throw ClientDetailV2Canonical.Failure.shape
        }
        mutating func value(depth: Int) throws {
            guard depth <= 32 else { throw ClientDetailV2Canonical.Failure.depth }
            space(); guard let c = current else { throw ClientDetailV2Canonical.Failure.shape }
            if c == 34 { _ = try string(); return }
            if c == 123 || c == 91 {
                let end: UInt8 = c == 123 ? 125 : 93; offset += 1; space()
                if current == end { offset += 1; return }
                var keys = Set<String>()
                while current != nil {
                    if c == 123 {
                        space(); let key = try string()
                        guard !key.isEmpty, key.utf8.allSatisfy({ (32...126).contains($0) }), keys.insert(key).inserted else { throw ClientDetailV2Canonical.Failure.shape }
                        space(); guard current == 58 else { throw ClientDetailV2Canonical.Failure.shape }; offset += 1
                    }
                    try value(depth: depth + 1); space()
                    guard let separator = current else { throw ClientDetailV2Canonical.Failure.shape }; offset += 1
                    if separator == end { return }
                    guard separator == 44 else { throw ClientDetailV2Canonical.Failure.shape }
                }
                throw ClientDetailV2Canonical.Failure.shape
            }
            // The final Codable decode checks literal/number grammar. This
            // scanner only needs to delimit tokens without losing object keys.
            let start = offset
            while let next = current, ![9, 10, 13, 32, 44, 93, 125].contains(next) { offset += 1 }
            guard offset > start else { throw ClientDetailV2Canonical.Failure.shape }
        }
    }
    static func keys(_ value: ClientInspectorValue, allowed: Set<String>, required: Set<String>) throws {
        guard case .object(let fields) = value, Set(fields.keys).isSubset(of: allowed), required.isSubset(of: Set(fields.keys)) else { throw ClientDetailV2Canonical.Failure.shape }
    }
    static func validateEnvelope(_ value: ClientInspectorValue, commit: Bool) throws {
        let common: Set<String> = ["protocolVersion", "documentId", "sessionId", "generation", "revision", "templates"]
        let extra: Set<String> = commit ? ["baseRevision", "baseStateHash", "resultStateHash", "manifestChange", "instanceChanges", "removeInstanceIds"] : ["stateHash", "manifest", "instances"]
        try keys(value, allowed: common.union(extra), required: common.union(extra))
        let manifest = value[commit ? "manifestChange" : "manifest"]
        if manifest != .null {
            try keys(manifest, allowed: ["revision", "hash", "cards", "order"], required: ["revision", "hash", "cards", "order"])
            for ref in manifest["cards"].fields.values { try keys(ref, allowed: ["templateId", "templateHash"], required: ["templateId", "templateHash"]) }
        }
        for template in value["templates"].fields.values { try keys(template, allowed: ["templateId", "templateVersion", "card"], required: ["templateId", "templateVersion", "card"]) }
        func instance(_ value: ClientInspectorValue) throws {
            try keys(value, allowed: ["revision", "hash", "fields", "collections", "actions"], required: ["revision", "hash", "fields", "collections", "actions"])
        }
        if commit {
            for change in value["instanceChanges"].items {
                if change.fields["replacement"] != nil {
                    try keys(change, allowed: ["cardId", "replacement"], required: ["cardId", "replacement"])
                    try instance(change["replacement"])
                } else {
                    let fields: Set<String> = ["cardId", "baseRevision", "revision", "baseHash", "resultHash", "fields", "actions"]
                    try keys(change, allowed: fields, required: fields)
                    for key in ["fields", "actions"] { try keys(change[key], allowed: ["set", "remove"], required: ["set", "remove"]) }
                }
            }
        } else { for item in value["instances"].fields.values { try instance(item) } }
    }
}
