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
        #expect(source.contains("importDefaultLocalAccount"))
        #expect(source.contains("请指定账号"))
        #expect(source.contains("本机发现有其他版本的 Codex"))
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
        #expect(form.stageDefaultAccount(for: selectable))
        #expect(form.values[selectable.id]?.accountId == "isolated")
        #expect(form.hasSpecifiedAccount(selectable.id))
        // A native-only machine has no selectable account: onboarding must
        // import a discovered local login rather than silently continue.
        let nativeOnly = try provider(false)
        let empty = draft(for: [nativeOnly])
        #expect(!empty.stageDefaultAccount(for: nativeOnly))
        #expect(!empty.hasSpecifiedAccount(nativeOnly.id))
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
