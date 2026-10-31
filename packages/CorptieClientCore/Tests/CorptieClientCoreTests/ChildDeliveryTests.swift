import Foundation
import Testing
@testable import CorptieClientCore

struct ChildDeliveryTests {
    @Test func bothNativeSurfacesUseUserAcceptanceAndOneStableSubmission() async throws {
        for surface in [ClientTaskHierarchyAPI.Surface.local, .pairedDevice] {
            let transport=BackendTransport(endpoint:try BackendEndpoint(URL(string:"https://unit-test.invalid")!),data:{ request in
                let url=try #require(request.url)
                let prefix=surface == .local ? "" : "/client/v1"
                let bytes=try #require(request.httpBody)
                let body=try #require(JSONSerialization.jsonObject(with:bytes) as? [String:Any])
                #expect(body["actor"] == nil)
                #expect(body["skipConfirmation"] == nil)
                #expect(body["requestId"] as? String == "user_click_123")
                let response: String
                if url.path.hasSuffix("completion-intents") {
                    #expect(url.path == prefix + "/tasks/task:c/completion-intents")
                    #expect(body["displayedTaskTitle"] as? String == "Child")
                    response = #"{"intentToken":"fixed-token","requestId":"user_click_123","taskId":"task:c"}"#
                } else {
                    #expect(url.path == prefix + "/tasks/task:c/confirm-completion")
                    #expect(body["idempotencyKey"] as? String == "child-acceptance:user_click_123")
                    response = #"{"childDelivery":{"operationId":"delivery:1","taskId":"task:c","parentTaskId":"task:p","title":"Child","state":"queued","phase":"code","errorMessage":null,"canRetry":false,"artifacts":[]}}"#
                }
                return (Data(response.utf8),HTTPURLResponse(url:url,statusCode:200,httpVersion:nil,headerFields:nil)!)
            },bytes:{_ in throw ClientConnectionError.invalidResponse})
            let api=ClientTaskHierarchyAPI(transport:transport,surface:surface)
            let intent=try await api.prepareChildAcceptance(taskID:"task:c",title:"Child",requestID:"user_click_123")
            let first=try await api.acceptChild(intent)
            let retry=try await api.acceptChild(intent)
            #expect(first.id == retry.id)
        }
    }
    @Test func recordsDecodeWithoutInternalPathsOrProviderDependencies() throws {
        let page=try JSONDecoder().decode(ClientChildDeliveryPage.self,from:Data(#"{"items":[{"operationId":"d","taskId":"c","parentTaskId":"p","title":"Child","state":"completed","phase":"completed","errorMessage":null,"canRetry":false,"artifacts":[{"artifactId":"a","title":"Result","version":2}]}],"nextCursor":"5"}"#.utf8))
        #expect(page.items.first?.artifacts.first?.version == 2)
        #expect(page.nextCursor == "5")
    }
}
