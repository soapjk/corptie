import Foundation
import AppKit
import SwiftUI
import Combine
import Testing
@testable import CorptieMac

struct FirstRunSetupTests {
    @Test @MainActor
    func multiVersionSelectionDecodesAndRendersWithoutImplicitTesting() throws {
        let provider = try JSONDecoder().decode(FirstRunProvider.self, from: Data("""
        {"id":"codex-app-server","name":"Codex","path":"/tmp/new codex","executable":true,
         "enabled":false,"checkState":"unknown","program":{"mode":"auto","recommendedPath":"/tmp/new codex",
          "adoptedPath":"/tmp/old codex","model":"example-model","effectiveModel":"example-model",
          "running":[{"profileId":"native","path":"/tmp/old codex","pid":123,"initialized":true}],
          "candidates":[{"id":"new","path":"/tmp/new codex","resolvedPath":"/tmp/new codex","sources":["ChatGPT"],
            "version":"0.155.0-alpha.16","state":"discovered","prerelease":true}]}}
        """.utf8))
        #expect(provider.program?.mode == "auto")
        #expect(provider.program?.candidates.first?.prerelease == true)
        #expect(provider.program?.running.first?.path != provider.path)
        let draft = draft(for: [provider])
        let view = NSHostingView(rootView: FirstRunProviderCard(provider: provider, busy: false,
            scanGeneration: 0, isDefault: false, updated: { _ in }, settingsDraft: draft).frame(width: 480))
        view.frame = NSRect(x: 0, y: 0, width: 480, height: 600)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize.width <= 480)
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/FirstRunSetupView.swift"), encoding: .utf8)
        #expect(source.contains(".task(id: autoCheckTrigger)"))
        // The manual check button is gone: edits and first-run preparation
        // save the shared draft and run the check in the background.
        #expect(!source.contains("Button(L10n(\"检测连接\")"))
        #expect(source.contains("private func commitAndCheck()"))
        #expect(source.contains("autoCheckGeneration"))
        #expect(source.contains("private func autoPrepareIfNeeded()"))
        #expect(source.contains("FirstRunAccountImport.importAll"))
        #expect(source.contains("automaticallyChecksChanges: false"))
        #expect(source.contains("guard automaticallyChecksChanges else { return }"))
        #expect(source.contains("first-run/check-and-complete"))
        #expect(source.contains("进入客户端"))
        #expect(source.contains("请指定账号"))
        #expect(source.contains("添加指定二进制文件路径"))
        #expect(!source.contains("private var pathField:"))
        #expect(!source.contains("private func programSelection("))
        #expect(!source.contains("private func chooseHome()"))
        #expect(!source.contains("Picker(L10n(\"运行环境\")"))
        #expect(!source.contains("Text(L10n(\"检测模型\"))"))
        // Onboarding and Settings must not diverge into an immediate-submit
        // path again: one draft, one save action, no onboarding-only branches.
        #expect(!source.contains("settingsDraft?"))
        #expect(!source.contains("if let settingsDraft"))
        #expect(!source.contains("pathChanged"))
        #expect(!source.contains("adoptProgram"))
        #expect(source.contains("@State private var providerDraft = ProviderSettingsDraft()"))
        #expect(source.contains("try await providerDraft.save()"))
        let accounts = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Settings/ProviderAccountsView.swift"), encoding: .utf8)
        #expect(accounts.contains("let draft: ProviderSettingsDraft"))
        // Account switches are staged in the shared draft; only account
        // operations use the provider's own accounts endpoint.
        #expect(!accounts.contains("first-run/settings"))
        #expect(accounts.contains("draft.edit(provider.id, accountId: id)"))
        // Accounts are listed inline: registered accounts plus every detected
        // local login, no separate "管理账号" sheet, and one trailing plus.
        #expect(!accounts.contains("管理账号…"))
        #expect(!accounts.contains("ProviderAccountManagerSheet"))
        #expect(!accounts.contains(".sheet(isPresented:"))
        #expect(!accounts.contains("Picker(L10n(\"当前使用账号\")"))
        #expect(accounts.contains("Label(L10n(\"添加账号\"), systemImage: \"plus\")"))
        #expect(accounts.contains("ForEach(availableLocalSources)"))
        #expect(accounts.contains("perform(\"discover\")"))
        #expect(accounts.contains("L10n(\"使用本机已有登录\")"))
        #expect(accounts.contains("L10n(\"登录 Codex\")"))
        #expect(accounts.contains("importSource(kind: source.kind, path: source.path)"))
        #expect(accounts.contains("result.accountId"))
        // Missing account is stated plainly and choosing one triggers the
        // automatic save + background check instead of a manual button.
        #expect(accounts.contains("尚未指定账号"))
        #expect(accounts.contains("accountChanged()"))
        #expect(!accounts.contains("切换账号在点击页面底部"))
        #expect(!accounts.contains("first-run/settings"))
        // The card reports its state through the status line and the error
        // line only. Do not grow a standing block of self-explaining prose
        // (duplicated save/check notes, raw timestamps, privacy boilerplate)
        // under the account list again.
        #expect(!source.contains("最近检测："))
        #expect(!source.contains("无需手动检测"))
        #expect(!source.contains("检测会发送最小测试请求"))
        #expect(!source.contains("已验证模型："))
        #expect(!accounts.contains("无需手动操作"))
        #expect(!accounts.contains("新会话使用此账号"))
        // Missing-account guidance belongs next to the account list only. The
        // card status line already says "请指定账号"; do not repeat the same
        // orange warning underneath the list a second time.
        #expect(!source.contains("请指定账号："))
        #expect(accounts.contains("尚未指定账号"))
    }

    @Test
    func programListUsesDiscoveryRecommendationAndRetainsManualChoices() {
        let program = ProviderProgramInventory(mode: "auto", recommendedPath: "/new/codex",
            adoptedPath: "/old/codex", model: "", candidates: [
                .init(id: "old", path: "/old/codex", resolvedPath: "/old/codex", sources: ["cli"], version: "1.0", state: "discovered", prerelease: false),
                .init(id: "new", path: "/new/codex", resolvedPath: "/new/codex", sources: ["App"], version: "2.0", state: "discovered", prerelease: false)
            ], running: [])
        let rows = ProviderProgramChoice.rows(program: program, selectedPath: "/custom/codex",
            addedPaths: ["/custom/codex", "/other/codex", "/old/codex"])
        #expect(rows.map(\.path) == ["/new/codex", "/old/codex", "/custom/codex", "/other/codex"])
        #expect(rows.first?.recommended == true)
        #expect(rows.filter(\.recommended).count == 1)
        #expect(ProviderProgramChoice.rows(program: nil, selectedPath: "").isEmpty)
        #expect(ProviderProgramChoice.rows(program: nil, selectedPath: "/local/claude").count == 1)
    }

    @Test @MainActor
    func importsAllSourcesAndContinuesAfterOneFailure() async {
        let sources = (0..<4).map { DiscoveredAccountSource(kind: "file", path: "/fixture/\($0)", label: "Account \($0)") }
        var attempted: [String] = []
        let failures = await FirstRunAccountImport.importAll(sources) { source in
            attempted.append(source.path)
            if source.path == "/fixture/1" { throw NSError(domain: "fixture", code: 1) }
        }
        #expect(attempted == sources.map(\.path))
        #expect(failures == 1)
    }

    @Test @MainActor
    func explicitEntryRequiresEveryEnabledConfigurationButNotPriorReplyProof() {
        let codex = FirstRunProvider(id: "codex", name: "Codex", path: "/fixture/codex",
            executable: true, enabled: true, checkState: "unknown", message: nil)
        let missing = FirstRunProvider(id: "other", name: "Other", path: "",
            executable: false, enabled: false, checkState: "missing", message: nil)
        let form = draft(for: [codex, missing])
        #expect(form.canEnterFirstRun)
        form.edit("other", enabled: true)
        #expect(!form.canEnterFirstRun)
        form.edit("other", path: "/fixture/other")
        #expect(form.canEnterFirstRun)
        form.edit("codex", enabled: false)
        form.edit("other", enabled: false)
        #expect(!form.canEnterFirstRun)
    }

    @Test @MainActor
    func firstRunStagesASelectableDefaultAccountAndReportsWhenNoneExists() throws {
        let json = """
        {"id":"codex-app-server","name":"Codex","path":"/tmp/codex","executable":true,
         "enabled":true,"checkState":"unknown","accounts":{"selectedAccountId":null,
          "accounts":[{"id":"isolated","name":"本机账号","accountLabel":"","state":"ready",
            "origin":"imported","runtimeDirectory":"/tmp/isolated","credentialPath":"/tmp/isolated/auth.json",
            "sessionCount":0,"canSelect":CAN_SELECT,"canDelete":false,"canReauthorize":true}],
          "sourceKinds":["directory"],"candidates":[],"activeLogin":null}}
        """
        func provider(_ selectable: Bool) throws -> FirstRunProvider {
            try JSONDecoder().decode(FirstRunProvider.self,
                from: Data(json.replacingOccurrences(of: "CAN_SELECT", with: String(selectable)).utf8))
        }
        let selectable = try provider(true)
        let form = draft(for: [selectable])
        #expect(!form.hasSpecifiedAccount(selectable.id))
        #expect(!form.canEnterFirstRun)
        #expect(form.stageDefaultAccount(for: selectable))
        #expect(form.values[selectable.id]?.accountId == "isolated")
        #expect(form.hasSpecifiedAccount(selectable.id))
        #expect(form.canEnterFirstRun)
        #expect(!form.stageDefaultAccount(for: selectable))
        #expect(form.values[selectable.id]?.accountId == "isolated")
        // A native-only machine has no selectable account: onboarding must
        // import a discovered local login rather than silently continue.
        let nativeOnly = try provider(false)
        let empty = draft(for: [nativeOnly])
        #expect(!empty.stageDefaultAccount(for: nativeOnly))
        #expect(!empty.hasSpecifiedAccount(nativeOnly.id))
    }
    @Test @MainActor
    func firstRunAutoEnablesOnlyLocallyReadyProvidersAndRefreshKeepsManualDisable() throws {
        func provider(_ id: String, executable: Bool, accountReady: Bool) throws -> FirstRunProvider {
            try JSONDecoder().decode(FirstRunProvider.self, from: Data("""
            {"id":"\(id)","name":"Engine","path":"/fixture/engine","executable":\(executable),
             "enabled":false,"checkState":"unknown","accounts":{"selectedAccountId":null,
             "accounts":[{"id":"account","name":"Account","accountLabel":"","state":"ready",
              "runtimeDirectory":"/fixture","credentialPath":"/fixture/auth.json",
              "sessionCount":0,"canSelect":\(accountReady),"canDelete":false,"canReauthorize":true}],
             "sourceKinds":["file"],"candidates":[],"activeLogin":null}}
            """.utf8))
        }
        let ready = try provider("ready", executable: true, accountReady: true)
        let missingBinary = try provider("missing-binary", executable: false, accountReady: true)
        let missingAccount = try provider("missing-account", executable: true, accountReady: false)
        let form = draft(for: [ready, missingBinary, missingAccount])
        form.stageReadyFirstRunProviders()
        #expect(form.values[ready.id]?.enabled == true)
        #expect(form.values[ready.id]?.accountId == "account")
        #expect(form.values[missingBinary.id]?.enabled == false)
        #expect(form.values[missingAccount.id]?.enabled == false)
        #expect(form.canEnterFirstRun)
        form.edit(ready.id, enabled: false)
        form.receive(FirstRunStatus(providers: [ready, missingBinary, missingAccount], completed: false,
            hasWorks: false, defaultProviderId: nil, assistantSessionId: nil, workSessionId: nil))
        #expect(form.values[ready.id]?.enabled == false)
        #expect(!form.canEnterFirstRun)
    }

    @Test
    func providerEnvironmentProjectionDecodesWithoutCredentials() throws {
        let provider = try JSONDecoder().decode(FirstRunProvider.self, from: Data("""
        {"id":"codex-app-server","name":"Codex","path":"/tmp/codex","executable":true,
         "enabled":false,"checkState":"unknown",
         "environment":{"profileId":"native","mode":"native","home":"/tmp/native","revision":1,
           "canImportAuthentication":false,"options":[
             {"mode":"native","title":"使用现有 Codex 环境（推荐）","home":"/tmp/native"},
             {"mode":"isolated","title":"使用独立 Corptie 环境","home":"/tmp/isolated"}]}}
        """.utf8))
        #expect(provider.environment?.mode == "native")
        #expect(provider.environment?.options.count == 2)
        #expect(provider.environment?.canImportAuthentication == false)
    }

    @Test @MainActor
    func legacyEnvironmentCardRendersWithoutLoginControls() throws {
        let environment = ProviderRuntimeEnvironment(profileId: "native", mode: "native", home: "/tmp/native",
            revision: 1, options: [
                .init(mode: "native", title: "使用现有 Codex 环境（推荐）", home: "/tmp/native"),
                .init(mode: "isolated", title: "使用独立 Corptie 环境", home: "/tmp/isolated")
            ], canImportAuthentication: false)
        let provider = FirstRunProvider(id: "codex-app-server", name: "Codex", path: "/tmp/codex",
            executable: true, enabled: false, checkState: "unknown", message: nil, environment: environment)
        let draft = draft(for: [provider])
        let view = NSHostingView(rootView: FirstRunProviderCard(provider: provider, busy: false,
            scanGeneration: 0, isDefault: false, updated: { _ in }, settingsDraft: draft).frame(width: 480))
        view.frame = NSRect(x: 0, y: 0, width: 480, height: 520)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize.height > 0)
        #expect(view.fittingSize.width <= 480)
    }
    @Test @MainActor
    func delayedStoreReadinessLoadsConfigurationWithoutManualRetry() async throws {
        let readiness = CurrentValueSubject<Bool, Never>(false)
        var loads = 0
        let status = try decode(enabled: false, executable: false, checkState: "missing")
        let view = NSHostingView(rootView: FirstRunSetupRoot(
            storeReadiness: readiness.eraseToAnyPublisher(), loadStatus: {
                loads += 1
                return status
            }
        ) { EmptyView() })
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 560, height: 820),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        view.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        // The transport may already be connected while Store readiness remains
        // false. No first-run API request may race the migration boundary.
        #expect(loads == 0)
        readiness.send(true)
        try await Task.sleep(for: .milliseconds(100))
        #expect(loads == 1)
        readiness.send(true)
        try await Task.sleep(for: .milliseconds(50))
        #expect(loads == 1)
    }

    @Test
    func discoveryAloneDoesNotUnlockSetup() throws {
        let status = try decode(enabled: false, executable: true)
        #expect(!status.canContinue)
    }

    @Test
    func testedExecutableUnlocksSetup() throws {
        #expect(try decode(enabled: true, executable: true).canContinue)
        #expect(try !decode(enabled: true, executable: false).canContinue)
    }

    @Test
    func replyProofDoesNotControlEnabledConfiguration() throws {
        #expect(try decode(enabled: true, executable: true, checkState: "failed").canContinue)
        #expect(try decode(enabled: true, executable: true, checkState: "checking").canContinue)
    }

    @Test
    func startupWaitsForConfigurationStatusAndRespectsCompletion() throws {
        #expect(FirstRunStatus.requiresSetup(nil))
        #expect(FirstRunStatus.requiresSetup(try decode(enabled: false, executable: false)))
        let completed = try JSONDecoder().decode(FirstRunStatus.self, from: Data(
            "{\"providers\":[],\"completed\":true,\"hasWorks\":false}".utf8))
        #expect(!FirstRunStatus.requiresSetup(completed))
    }

    @Test @MainActor
    func setupWindowSizingOnlyRunsForKnownIncompleteSetupAndNotOnResize() async throws {
        for completed in [false, true] {
            var sizingRequests = 0
            let status = FirstRunStatus(providers: [], completed: completed, hasWorks: false,
                defaultProviderId: nil, assistantSessionId: nil, workSessionId: nil)
            let host = NSHostingView(rootView: FirstRunSetupRoot(initialStatus: status,
                storeReadiness: Empty<Bool, Never>().eraseToAnyPublisher(),
                onSetupRequired: { sizingRequests += 1 }) { EmptyView() })
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 952, height: 695),
                styleMask: .borderless, backing: .buffered, defer: false)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            #expect(sizingRequests == (completed ? 0 : 1))
            window.setContentSize(NSSize(width: 1000, height: 720))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            #expect(sizingRequests == (completed ? 0 : 1))
            window.contentView = nil
        }
    }

    @Test @MainActor
    func firstRunKeepsActionsAndCardsInsideStandardWindowWithoutPageScrolling() async throws {
        let providers = ["Codex", "Claude Code", "OpenClacky"].map { name in
            FirstRunProvider(id: name, name: name, path: "/fixture/engine",
                executable: true, enabled: true, checkState: "unknown", message: nil)
        }
        let status = FirstRunStatus(providers: providers, completed: false, hasWorks: false,
            defaultProviderId: nil, assistantSessionId: nil, workSessionId: nil)
        let host = NSHostingView(rootView: FirstRunSetupRoot(initialStatus: status,
            storeReadiness: Empty<Bool, Never>().eraseToAnyPublisher()) { EmptyView() })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        for size in [NSSize(width: 1100, height: 720), NSSize(width: 960, height: 640)] {
            window.setContentSize(size)
            try await Task.sleep(for: .milliseconds(50))
            host.layoutSubtreeIfNeeded()
            // fittingSize asks for the unconstrained ideal; inspect presented geometry instead.
            #expect(abs(host.bounds.width - size.width) < 2)
            #expect(abs(host.bounds.height - size.height) < 2)
            func scrollers(_ view: NSView) -> [NSScrollView] {
                (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap { scrollers($0) }
            }
            let cards = scrollers(host)
            // Collapsed summaries do not mount any account/program scroll views.
            #expect(cards.isEmpty)
            #expect(host.fittingSize.width <= size.width + 2)
        }
    }

    @Test @MainActor
    func providerSummariesFollowDraftVersionAccountAndLocalReadiness() throws {
        let provider = try JSONDecoder().decode(FirstRunProvider.self, from: Data("""
        {"id":"fixture","name":"Engine","path":"/old/engine","executable":true,
         "enabled":true,"checkState":"unknown","program":{"mode":"auto",
          "recommendedPath":"/new/engine","adoptedPath":"/old/engine","model":"","running":[],
          "candidates":[
           {"id":"old","path":"/old/engine","resolvedPath":"/old/engine","sources":["cli"],
            "version":"1.0","state":"discovered","prerelease":false},
           {"id":"new","path":"/new/engine","resolvedPath":"/new/engine","sources":["cli"],
            "version":"2.0","state":"discovered","prerelease":false}]},
         "accounts":{"selectedAccountId":"a","accounts":[
          {"id":"a","name":"Account A","accountLabel":"","state":"ready","runtimeDirectory":"/fixture/a",
           "credentialPath":"/fixture/a/auth","sessionCount":0,"canSelect":true,"canDelete":false,"canReauthorize":true},
          {"id":"b","name":"Account B","accountLabel":"","state":"ready","runtimeDirectory":"/fixture/b",
           "credentialPath":"/fixture/b/auth","sessionCount":0,"canSelect":true,"canDelete":false,"canReauthorize":true}],
          "sourceKinds":[],"candidates":[],"activeLogin":null}}
        """.utf8))
        let form = draft(for: [provider])
        #expect(FirstRunProviderSummary(provider: provider, draft: form).version == L10nFormat("版本号：%@", "1.0"))
        #expect(FirstRunProviderSummary(provider: provider, draft: form).account == "Account A")
        // Local readiness is independent of a potentially slow model reply test.
        #expect(FirstRunProviderSummary(provider: provider, draft: form).ready)
        form.edit(provider.id, path: "/new/engine", accountId: "b")
        let changed = FirstRunProviderSummary(provider: provider, draft: form)
        #expect(changed.version == L10nFormat("版本号：%@", "2.0"))
        #expect(changed.account == "Account B")
        #expect(changed.ready)
        form.edit(provider.id, enabled: false)
        #expect(!FirstRunProviderSummary(provider: provider, draft: form).ready)
        form.edit(provider.id, path: "/custom/engine", enabled: true)
        #expect(!FirstRunProviderSummary(provider: provider, draft: form).ready)
        #expect(FirstRunProviderSummary(provider: provider, draft: form).version == L10n("版本号：未知"))
    }

    @Test @MainActor
    func galleryKeepsShortEditorsNaturalAndOtherSummariesCompact() async throws {
        let providers = ["Codex", "Claude Code", "OpenClacky"].map { name in
            FirstRunProvider(id: name, name: name, path: "/fixture/engine",
                executable: true, enabled: true, checkState: "available", message: nil)
        }
        let form = draft(for: providers)
        func gallery(_ selected: String?) -> some View {
            FirstRunProviderGallery(draft: form, busy: false,
                defaultProviderID: nil, expandedProviderID: .constant(selected), updated: { _ in }, save: {})
                .transaction { $0.disablesAnimations = true }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        let host = NSHostingView(rootView: gallery(nil))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 510),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func scrollers(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap { scrollers($0) }
        }
        for selected in [nil] + providers.map({ Optional($0.id) }) + [nil] {
            host.rootView = gallery(selected)
            try await Task.sleep(for: .milliseconds(40))
            host.layoutSubtreeIfNeeded()
            let editors = scrollers(host)
            #expect(editors.isEmpty) // These short editors need no scroll container.
            #expect(host.fittingSize.width <= host.bounds.width + 2)
            #expect(host.fittingSize.height <= host.bounds.height + 2)
            for editor in editors {
                let frame = editor.convert(editor.bounds, to: host)
                #expect(frame.minX >= -2 && frame.maxX <= host.bounds.maxX + 2)
                #expect(frame.minY >= -2 && frame.maxY <= host.bounds.maxY + 2)
                #expect(editor.documentView?.bounds.width ?? 0 <= editor.contentView.bounds.width + 2)
                #expect(!editor.hasHorizontalScroller)
            }
        }
    }

    @Test @MainActor
    func configurationViewportShrinksShortContentAndScrollsOverflowWithoutDoubleMounting() async {
        for (height, expected): (CGFloat, CGFloat) in [(36, 36), (900, 300)] {
            var appearances = 0
            let host = NSHostingView(rootView: FirstRunProviderConfigurationViewport {
                Color.clear.frame(height: height).onAppear { appearances += 1 }
            })
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 416, height: 300),
                styleMask: .borderless, backing: .buffered, defer: false)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(40))
            #expect(abs(host.fittingSize.height - expected) < 1)
            // Fitting an alternative must not start duplicate editor lifecycles.
            #expect(appearances == 1)
            func countScrolls(_ view: NSView) -> Int {
                (view is NSScrollView ? 1 : 0) + view.subviews.reduce(0) { $0 + countScrolls($1) }
            }
            #expect(countScrolls(host) == (height > 300 ? 1 : 0))
            window.contentView = nil
        }
    }

    @Test @MainActor
    func actualProviderConfigurationKeepsNaturalHeightAndCapsLongProgramList() async {
        for count in [1, 40] {
            let candidates = (0..<count).map { index in
                ProviderProgramInventory.Candidate(id: String(index), path: "/fixture/engine-\(index)",
                    resolvedPath: "/fixture/engine-\(index)", sources: ["cli"],
                    version: "1.0.\(index)", state: "discovered", prerelease: false)
            }
            let program = ProviderProgramInventory(mode: "manual", recommendedPath: candidates[0].path,
                adoptedPath: candidates[0].path, model: "", candidates: candidates, running: [])
            let provider = FirstRunProvider(id: "fixture", name: "Engine", path: candidates[0].path,
                executable: true, enabled: true, checkState: "available", message: nil, program: program)
            let host = NSHostingView(rootView: FirstRunProviderCard(provider: provider, busy: false,
                scanGeneration: 0, isDefault: false, updated: { _ in }, settingsDraft: draft(for: [provider]),
                automaticallyChecksChanges: false, compact: true,
                presentation: .init(expanded: true, expand: {}, save: {})))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 420),
                styleMask: .borderless, backing: .buffered, defer: false)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(40))
            #expect(host.fittingSize.height < (count == 1 ? 240 : 390))
            #expect(abs(host.fittingSize.width - 440) < 2)
            func scrolls(_ view: NSView) -> [NSScrollView] {
                (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap { scrolls($0) }
            }
            let owners = scrolls(host)
            #expect(owners.count == (count == 1 ? 0 : 1))
            if let scroll = owners.first {
                #expect(scroll.documentView!.bounds.height > scroll.contentView.bounds.height)
                #expect(!scroll.hasHorizontalScroller)
            }
            window.contentView = nil
        }
    }

    @MainActor
    private func draft(for providers: [FirstRunProvider]) -> ProviderSettingsDraft {
        let draft = ProviderSettingsDraft()
        draft.receive(FirstRunStatus(providers: providers, completed: false, hasWorks: false,
            defaultProviderId: nil, assistantSessionId: nil, workSessionId: nil))
        return draft
    }

    private func decode(enabled: Bool, executable: Bool, checkState: String = "available") throws -> FirstRunStatus {
        let data = Data("""
        {"providers":[{"id":"provider","name":"Provider","path":"/tmp/provider","executable":\(executable),"enabled":\(enabled),"checkState":"\(checkState)"}],"completed":false,"hasWorks":false}
        """.utf8)
        return try JSONDecoder().decode(FirstRunStatus.self, from: data)
    }

    @Test @MainActor
    func configurationPageRendersAtCompactAndWideSizes() throws {
        let status = FirstRunStatus(providers: [
            FirstRunProvider(id: "codex-app-server", name: "Codex", path: "/tmp/codex", executable: true,
                             enabled: true, checkState: "available", message: nil),
            FirstRunProvider(id: "claude-sdk", name: "Claude Code", path: "", executable: false,
                             enabled: false, checkState: "missing", message: nil),
            FirstRunProvider(id: "openclacky", name: "OpenClacky", path: "", executable: false,
                             enabled: false, checkState: "missing", message: nil)
        ], completed: false, hasWorks: false, defaultProviderId: "codex-app-server",
           assistantSessionId: nil, workSessionId: nil)
        for (width, appearance) in [(CGFloat(560), NSAppearance.Name.aqua), (CGFloat(960), .darkAqua)] {
            let view = NSHostingView(rootView: FirstRunSetupRoot(initialStatus: status) { EmptyView() })
            view.appearance = NSAppearance(named: appearance)
            view.frame = NSRect(x: 0, y: 0, width: width, height: 820)
            view.layoutSubtreeIfNeeded()
            let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            #expect(bitmap.pixelsWide >= Int(width))
            #expect(bitmap.pixelsHigh >= 820)
            if let directory = ProcessInfo.processInfo.environment["CORPTIE_UI_EVIDENCE_DIR"] {
                let url = URL(fileURLWithPath: directory, isDirectory: true)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try bitmap.representation(using: .png, properties: [:])?.write(
                    to: url.appendingPathComponent("first-run-\(Int(width)).png"))
            }
        }
    }
}
