import XCTest
@testable import CorptieComputerUse

final class ProtocolTests: XCTestCase {
    func testTargetAndTextSurviveJSONLWithoutClipboardConversion() throws {
        let data = Data(#"{"id":"request-1","method":"type","params":{"pid":42,"windowId":7,"element":[0,2],"text":"你好😀\n"}}"#.utf8)
        let request = try JSONDecoder().decode(NativeRequest.self, from: data)
        XCTAssertEqual(request.id, "request-1")
        XCTAssertEqual(request.params.pid, 42)
        XCTAssertEqual(request.params.windowId, 7)
        XCTAssertEqual(request.params.element, [0, 2])
        XCTAssertEqual(request.params.text, "你好😀\n")
    }
    func testInvalidPIDRepresentationIsRejected() {
        XCTAssertThrowsError(try JSONDecoder().decode(NativeRequest.self, from: Data(#"{"id":"x","method":"read","params":{"pid":2147483648}}"#.utf8)))
    }
    func testFailureKeepsMachineReadableCode() {
        let failure = NativeFailure("TARGET_GONE", "Refresh target")
        XCTAssertEqual(failure.code, "TARGET_GONE")
        XCTAssertEqual(failure.description, "Refresh target")
    }
}
