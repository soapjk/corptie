import Foundation
import CryptoKit
import Testing
@testable import CorptieClientCore

@Suite struct ClientImageUploadTests {
    @Test func largeImageResumesConfirmedChunksAndCommitsReferencesOnly() async throws {
        let probe = ImageUploadProbe()
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { try await probe.handle($0) }, bytes: { _ in throw URLError(.cancelled) }))
        let data = Data(repeating: 7, count: 7 * 1024 * 1024)
        let image = ClientDraftImage(fileName: "large.png", data: data)
        do {
            _ = try await api.reconcileOrDeliver(sessionId: "session", requestId: "request_image",
                createdAt: "now", text: "", images: [image], previousAttempts: 0)
            Issue.record("Injected lost chunk ACK must interrupt the attempt")
        } catch let error as URLError { #expect(error.code == .networkConnectionLost) }
        let receipt = try await api.reconcileOrDeliver(sessionId: "session", requestId: "request_image",
            createdAt: "now", text: "", images: [image], previousAttempts: 1)
        #expect(receipt.status == "accepted")
        #expect(await probe.uploaded == data)
        #expect(await probe.offsets.filter { $0 == 0 }.count == 1)
        #expect(await probe.maximumBody < 720 * 1024)
        #expect(await probe.submissions == 1)
        _ = try await api.reconcileOrDeliver(sessionId: "session", requestId: "request_image",
            createdAt: "now", text: "", images: [image], previousAttempts: 2)
        #expect(await probe.submissions == 1)
    }
    @Test func uploadProgressIsNotUnconfirmed() {
        let progress = UserMessageStatusPresentation(authoritativeStatus: nil, legacyStatus: nil, localDeliveryState: "上传图片 45%")
        #expect(progress?.kind == .uploading)
        #expect(progress?.shortLabel(languageCode: "zh") == "上传中 45%")
        #expect(UserMessageStatusPresentation(authoritativeStatus: nil, legacyStatus: nil,
            localDeliveryState: "图片已上传，正在提交")?.kind == .submitting)
    }
}

private actor ImageUploadProbe {
    var uploaded = Data()
    var offsets: [Int] = []
    var maximumBody = 0
    var submissions = 0
    private var metadata: [String: Any] = [:]
    private var injected = false
    func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        maximumBody = max(maximumBody, request.httpBody?.count ?? 0)
        let path = request.url!.path
        var result: [String: Any]
        if path.contains("/commands/") {
            guard submissions > 0 else { throw ClientServiceFailure(statusCode: 404, code: "COMMAND_NOT_FOUND") }
            result = receipt
        } else if path.hasSuffix("/capabilities") {
            result = ["schemaVersion": 1, "sessionId": "session", "readMessages": true,
                "send": ["available": true], "stop": ["available": true], "sendImages": true,
                "imageUploads": ["version": 1, "maximumImages": 8, "maximumBytes": 20971520, "chunkBytes": 524288, "maximumAgeSeconds": 604800]]
        } else if path.contains("/image-uploads") {
            let input = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            if request.httpMethod == "POST" { metadata = input }
            else {
                let offset = input["offset"] as! Int
                #expect(offset == uploaded.count)
                let bytes = Data(base64Encoded: input["dataBase64"] as! String)!
                let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                #expect(sha == input["sha256"] as? String)
                offsets.append(offset); uploaded.append(bytes)
                if !injected { injected = true; throw URLError(.networkConnectionLost) }
            }
            result = ["schemaVersion": 1, "uploadId": metadata["uploadId"]!, "offset": uploaded.count,
                "byteLength": metadata["byteLength"]!, "sha256": metadata["sha256"]!]
        } else {
            let input = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            #expect(input["images"] == nil)
            #expect(input["imageUploadIds"] as? [String] == ["request_image-0"])
            submissions += 1
            result = receipt
        }
        return (try JSONSerialization.data(withJSONObject: result),
            HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    private var receipt: [String: Any] { ["schemaVersion": 1, "sessionId": "session", "requestId": "request_image",
        "kind": "send", "status": "accepted", "updatedAt": "now", "messageId": "client:accepted"] }
}
