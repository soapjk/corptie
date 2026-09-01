import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct WorktreeManagementLoadingTests {
    @MainActor
    @Test func firstLoadPublishesTheUnchangedOrderedListAndSelection() async {
        let recorder = RequestRecorder(details: ["repository:one": Self.detail(
            repositoryId: "repository:one",
            worktrees: [Self.worktree("wt:main", branch: "main", isMain: true), Self.worktree("wt:z", branch: "zeta")]
        )])
        let client = makeClient(recorder: recorder)

        await client.loadRepositories()

        #expect(client.listLoadState == .loaded)
        #expect(client.detail?.project.worktrees.map(\.worktreeId) == ["wt:main", "wt:z"])
        #expect(client.selection.worktreeId == "wt:main")
        #expect(recorder.count(path: "/worktree-management/repositories/repository:one") == 1)
        #expect(recorder.count(path: "/projects/repository:one/development-service") == 1)
        #expect(client.lastLoadMetrics?.cacheHit == false)
    }

    @MainActor
    @Test func reopeningTabReusesFreshDetailWithoutAFullReload() async {
        let recorder = RequestRecorder(details: ["repository:one": Self.detail(
            repositoryId: "repository:one",
            worktrees: [Self.worktree("wt:main", branch: "main", isMain: true)]
        )])
        let client = makeClient(recorder: recorder)

        await client.loadRepositories()
        await client.loadRepositories()

        #expect(recorder.count(path: "/worktree-management/repositories") == 2)
        #expect(recorder.count(path: "/worktree-management/repositories/repository:one") == 1)
        #expect(recorder.count(path: "/projects/repository:one/development-service") == 1)
        #expect(client.lastLoadMetrics?.cacheHit == true)
    }

    @MainActor
    @Test func tabActivationKeepsVisibleDataAndSkipsRepeatedAutomaticReloads() async {
        var currentTime = Date(timeIntervalSince1970: 1_776_297_600)
        let recorder = RequestRecorder(details: ["repository:one": Self.detail(
            repositoryId: "repository:one",
            worktrees: [Self.worktree("wt:main", branch: "main", isMain: true)]
        )])
        let client = makeClient(
            recorder: recorder,
            automaticRefreshInterval: 60,
            now: { currentTime }
        )

        await client.activate()
        currentTime.addTimeInterval(10)
        await client.activate()

        #expect(recorder.count(path: "/worktree-management/repositories") == 1)
        #expect(client.detail?.project.worktrees.map(\.worktreeId) == ["wt:main"])
        #expect(client.isLoading == false)
    }

    @MainActor
    @Test func githubPushStatusLoadsOnlyForTheSelectedWorktree() async {
        let recorder = RequestRecorder(details: ["repository:one": Self.detail(
            repositoryId: "repository:one",
            worktrees: [
                Self.worktree("wt:main", branch: "main", isMain: true),
                Self.worktree("wt:feature", branch: "feature/one")
            ]
        )])
        let client = makeClient(recorder: recorder)

        await client.loadRepositories()
        await waitForPushInspection(client, worktreeId: "wt:main")
        #expect(recorder.count(path: RequestRecorder.pushPath("wt:main")) == 1)
        #expect(recorder.count(path: RequestRecorder.pushPath("wt:feature")) == 0)

        client.selectWorktree("wt:feature")
        await waitForPushInspection(client, worktreeId: "wt:feature")
        #expect(recorder.count(path: RequestRecorder.pushPath("wt:feature")) == 1)
        #expect(client.selectedWorktree?.gitHubPush?.available == true)
    }

    @MainActor
    @Test func switchingRepositoriesLoadsEachOnceAndPreservesEachSelection() async {
        let recorder = RequestRecorder(
            repositoryIds: ["repository:one", "repository:two"],
            details: [
                "repository:one": Self.detail(repositoryId: "repository:one", worktrees: [
                    Self.worktree("wt:one-main", branch: "main", isMain: true),
                    Self.worktree("wt:one-feature", branch: "feature/one")
                ]),
                "repository:two": Self.detail(repositoryId: "repository:two", worktrees: [
                    Self.worktree("wt:two-main", branch: "main", isMain: true)
                ])
            ]
        )
        let client = makeClient(recorder: recorder)

        await client.loadRepositories()
        client.selection.worktreeId = "wt:one-feature"
        await client.selectRepository("repository:two")
        await client.selectRepository("repository:one")

        #expect(client.detail?.repository.id == "repository:one")
        #expect(client.selection.worktreeId == "wt:one-main")
        #expect(recorder.count(path: "/worktree-management/repositories/repository:one") == 1)
        #expect(recorder.count(path: "/worktree-management/repositories/repository:two") == 1)
    }

    @MainActor
    @Test func emptyWorktreeListFinishesAsLoadedWithoutInventingASelection() async {
        let recorder = RequestRecorder(details: [
            "repository:one": Self.detail(repositoryId: "repository:one", worktrees: [])
        ])
        let client = makeClient(recorder: recorder)

        await client.loadRepositories()

        #expect(client.listLoadState == .loaded)
        #expect(client.detail?.project.worktrees.isEmpty == true)
        #expect(client.selection.worktreeId == nil)
    }

    @MainActor
    @Test func loadFailureHasAVisibleFailureStateAndCanRefreshToChangedData() async {
        let recorder = RequestRecorder(details: [:])
        let client = makeClient(recorder: recorder)

        await client.loadRepositories()
        guard case .failed(let message) = client.listLoadState else {
            Issue.record("Expected a failed list state")
            return
        }
        #expect(message.contains("simulated detail failure"))
        #expect(client.detail == nil)

        recorder.setDetail(Self.detail(repositoryId: "repository:one", worktrees: [
            Self.worktree("wt:main", branch: "main", isMain: true),
            Self.worktree("wt:new", branch: "feature/new")
        ]), for: "repository:one")
        await client.refreshSelected()

        #expect(client.listLoadState == .loaded)
        #expect(client.detail?.project.worktrees.map(\.worktreeId) == ["wt:main", "wt:new"])
        #expect(recorder.count(path: "/worktree-management/repositories/repository:one") == 2)
    }

    @MainActor
    @Test func loadingDoesNotBlockOtherMainActorInteractions() async {
        let recorder = RequestRecorder(details: [
            "repository:one": Self.detail(repositoryId: "repository:one", worktrees: [
                Self.worktree("wt:main", branch: "main", isMain: true)
            ])
        ], responseDelay: 0.05)
        let client = makeClient(recorder: recorder)

        let load = Task { await client.loadRepositories() }
        while !client.isLoading { await Task.yield() }
        client.selection.worktreeId = "interaction-remains-responsive"

        #expect(client.isLoading)
        #expect(client.selection.worktreeId == "interaction-remains-responsive")
        await load.value
        #expect(client.listLoadState == .loaded)
    }

    @MainActor
    @Test func expiredCacheAutomaticallyReloadsChangedWorktreeData() async {
        var currentTime = Date(timeIntervalSince1970: 1_776_297_600)
        let recorder = RequestRecorder(details: [
            "repository:one": Self.detail(repositoryId: "repository:one", worktrees: [
                Self.worktree("wt:main", branch: "main", isMain: true)
            ])
        ])
        let client = makeClient(
            recorder: recorder,
            cacheLifetime: 15,
            now: { currentTime }
        )

        await client.loadRepositories()
        recorder.setDetail(Self.detail(repositoryId: "repository:one", worktrees: [
            Self.worktree("wt:main", branch: "main", isMain: true),
            Self.worktree("wt:changed", branch: "feature/changed")
        ]), for: "repository:one")
        currentTime.addTimeInterval(16)
        await client.loadRepositories()

        #expect(client.detail?.project.worktrees.map(\.worktreeId) == ["wt:main", "wt:changed"])
        #expect(recorder.count(path: "/worktree-management/repositories/repository:one") == 2)
        #expect(client.lastLoadMetrics?.cacheHit == false)
    }

    @MainActor
    private func makeClient(
        recorder: RequestRecorder,
        cacheLifetime: TimeInterval = 60,
        automaticRefreshInterval: TimeInterval = 60,
        now: @escaping () -> Date = Date.init
    ) -> WorktreeManagementClient {
        WorktreeLoadingURLProtocol.recorder = recorder
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeLoadingURLProtocol.self]
        return WorktreeManagementClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            session: URLSession(configuration: configuration),
            cacheLifetime: cacheLifetime,
            automaticRefreshInterval: automaticRefreshInterval,
            now: now
        )
    }

    @MainActor
    private func waitForPushInspection(
        _ client: WorktreeManagementClient,
        worktreeId: String
    ) async {
        for _ in 0..<100 {
            if client.detail?.project.worktrees.first(where: {
                $0.worktreeId == worktreeId
            })?.gitHubPush != nil { return }
            await Task.yield()
        }
        Issue.record("GitHub push inspection did not finish for \(worktreeId)")
    }

    private static func detail(repositoryId: String, worktrees: [String]) -> String {
        let suffix = repositoryId.split(separator: ":").last ?? "repo"
        return """
        {"repository":\(repository(repositoryId)),"project":{"repositoryId":"\(repositoryId)","inventoryVersion":"inventory-\(suffix)","mainWorktreeId":"\(worktrees.first.flatMap { worktreeId(from: $0) } ?? "missing")","mainPath":"/tmp/\(suffix)","mainBranch":"main","mainHeadOid":"abc123","pendingWorktreeCount":0,"worktrees":[\(worktrees.joined(separator: ","))]},"latestJob":null}
        """
    }

    fileprivate static func repository(_ id: String) -> String {
        let suffix = id.split(separator: ":").last ?? "repo"
        return "{\"id\":\"\(id)\",\"path\":\"/tmp/\(suffix)\",\"name\":\"\(suffix)\",\"discoveredAt\":\"2026-08-20T00:00:00Z\",\"lastValidatedAt\":\"2026-08-20T00:00:00Z\",\"mainPath\":\"/tmp/\(suffix)\",\"availability\":\"available\",\"worktreeCount\":1}"
    }

    private static func worktree(_ id: String, branch: String, isMain: Bool = false) -> String {
        "{\"worktreeId\":\"\(id)\",\"path\":\"/tmp/\(id)\",\"isMain\":\(isMain),\"availability\":\"available\",\"headOid\":\"abc123\",\"branchName\":\"\(branch)\",\"isDetached\":false,\"isLocked\":false,\"lockReason\":null,\"state\":\"\(isMain ? "main" : "synced")\",\"dirty\":false,\"statusSummary\":\"\",\"diffStat\":\"\",\"changedFiles\":[],\"operationState\":null,\"conflictFiles\":[],\"mergedIntoMain\":true,\"synchronizedWithMain\":true,\"aheadOfMain\":0,\"behindMain\":0,\"pendingIntegration\":false,\"associations\":[]}"
    }

    private static func worktreeId(from json: String) -> String? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["worktreeId"] as? String
    }
}

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private let repositoryIds: [String]
    private var details: [String: String]
    private var counts: [String: Int] = [:]
    private let responseDelay: TimeInterval

    init(
        repositoryIds: [String] = ["repository:one"],
        details: [String: String],
        responseDelay: TimeInterval = 0
    ) {
        self.repositoryIds = repositoryIds
        self.details = details
        self.responseDelay = responseDelay
    }

    func response(for path: String) -> (Int, String) {
        if responseDelay > 0 { Thread.sleep(forTimeInterval: responseDelay) }
        return lock.withLock {
            counts[path, default: 0] += 1
            if path == "/worktree-management/repositories" {
                let repositories = repositoryIds.map(WorktreeManagementLoadingTests.repository).joined(separator: ",")
                return (200, "{\"repositories\":[\(repositories)]}")
            }
            if path.hasSuffix("/development-service") {
                return (500, "{\"error\":\"service status unavailable\"}")
            }
            if path.hasSuffix("/github-push-status") {
                let components = path.split(separator: "/").map(String.init)
                let repositoryId = components.count >= 6 ? components[2] : "repository:one"
                let worktreeId = components.count >= 6 ? components[4] : "missing"
                return (200, """
                {"repositoryId":"\(repositoryId)","worktreeId":"\(worktreeId)","gitHubPush":{"available":true,"pending":true,"dirty":false,"unpushedCommitCount":1,"branch":"feature","destinationUrl":"https://github.com/example/repository","error":null}}
                """)
            }
            let id = String(path.split(separator: "/").last ?? "")
            guard let detail = details[id] else {
                return (500, "{\"error\":\"simulated detail failure\"}")
            }
            return (200, detail)
        }
    }

    func count(path: String) -> Int { lock.withLock { counts[path, default: 0] } }
    func setDetail(_ detail: String, for id: String) { lock.withLock { details[id] = detail } }

    static func pushPath(_ worktreeId: String) -> String {
        "/worktree-management/repositories/repository:one/worktrees/\(worktreeId)/github-push-status"
    }
}

private final class WorktreeLoadingURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var recorder: RequestRecorder?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let recorder = Self.recorder, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, body) = recorder.response(for: url.path)
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
