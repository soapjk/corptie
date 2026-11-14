import AppKit
import ApplicationServices
import ScreenCaptureKit

// JSONL only on stdout. No permission prompts, activation, clipboard, telemetry,
// persistent image files or capture stream. Parent terminates this per-call
// process on cancellation, timeout, or MCP transport closure.
@main
struct CorptieComputerUse {
    @MainActor static func main() async {
        guard let line = readLine(), line.utf8.count <= 256 * 1024 else { return }
        var id = ""
        do {
            let request = try JSONDecoder().decode(NativeRequest.self, from: Data(line.utf8))
            id = request.id
            let result = try await NativeEngine().perform(request.method, request.params)
            emit(["id": id, "result": result])
        } catch {
            let failure = error as? NativeFailure
            emit(["id": id, "error": ["code": failure?.code ?? "NATIVE_ERROR", "message": failure?.description ?? String(describing: error)]])
        }
    }
    static func emit(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) { print(line) }
    }
}
