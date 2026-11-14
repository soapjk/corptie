import Foundation

struct NativeRequest: Decodable {
    let id: String
    let method: String
    let params: Parameters
}
struct Parameters: Decodable {
    var pid: Int32?
    var windowId: UInt32?
    var element: [Int]?
    var text: String?
    var key: String?
    var modifiers: [String]?
    var x: Double?
    var y: Double?
    var deltaX: Int32?
    var deltaY: Int32?
}
struct NativeFailure: Error, CustomStringConvertible {
    let code: String
    let description: String
    init(_ code: String, _ message: String) { self.code = code; self.description = message }
}
func require(_ condition: Bool, _ code: String, _ message: String) throws {
    if !condition { throw NativeFailure(code, message) }
}
