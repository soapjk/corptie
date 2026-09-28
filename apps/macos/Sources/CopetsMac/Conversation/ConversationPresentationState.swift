import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum SessionDetailContentPhase: Equatable {
    case live
    case cached
    case loading
    case failed
    case empty
}

func sessionDetailContentPhase(
    hasLiveDetail: Bool,
    cachedSessionID: String?,
    selectedSessionID: String,
    isLoading: Bool,
    hasError: Bool
) -> SessionDetailContentPhase {
    if hasLiveDetail { return .live }
    if cachedSessionID == selectedSessionID { return .cached }
    if isLoading { return .loading }
    if hasError { return .failed }
    return .empty
}

struct TimelineRestorationIntent: Equatable {
    private(set) var requestedAnchorRowID: String?
    private(set) var lastObservedPosition: AppKitChatTimelinePosition?
    private var isAwaitingRestoration: Bool
    private var restorationClosed = false

    init(initialPosition: AppKitChatTimelinePosition?) {
        let anchorRowID = initialPosition?.followsLatest == false
            ? initialPosition?.rowID
            : nil
        requestedAnchorRowID = anchorRowID
        lastObservedPosition = nil
        isAwaitingRestoration = anchorRowID != nil
    }

    mutating func reset(initialPosition: AppKitChatTimelinePosition?) {
        self = TimelineRestorationIntent(initialPosition: initialPosition)
    }

    mutating func offerRestoration(_ position: AppKitChatTimelinePosition) -> Bool {
        guard !restorationClosed else { return false }
        guard !position.followsLatest else { return false }
        if requestedAnchorRowID == position.rowID { return true }
        guard lastObservedPosition == nil else { return false }
        requestedAnchorRowID = position.rowID
        isAwaitingRestoration = true
        return true
    }

    mutating func observeViewport(_ position: AppKitChatTimelinePosition) {
        lastObservedPosition = position
        if !position.followsLatest {
            if position.rowID == requestedAnchorRowID {
                isAwaitingRestoration = false
            }
            return
        }
        if !isAwaitingRestoration {
            requestedAnchorRowID = nil
        }
    }

    mutating func clearAnchor() {
        restorationClosed = true
        requestedAnchorRowID = nil
        isAwaitingRestoration = false
    }
}

func nativeTimelineTimestampText(createdAt: String?) -> String {
    ConversationTimestampText.messageLabel(createdAt: createdAt)
}

typealias DetailView = SessionConversationContent

struct ConversationUserInputSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: CodexThreadItem
    let submit: ([String: [String]], String) async throws -> Void
    @State private var selected: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var submitting = false
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("需要你的输入").font(.title3.weight(.semibold))
            if let request = item.userInput, request.schemaVersion == 1 {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ConversationInputFields(request: request, selected: $selected, typed: $typed)
                            .disabled(submitting)
                    }
                    .padding(.trailing, 8)
                }
                if let errorText { Text(errorText).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("关闭") { dismiss() }.disabled(submitting)
                    if request.canCancel == true {
                        Button("取消请求") { Task { await send(request, cancelling: true) } }.disabled(submitting)
                    }
                    Spacer()
                    Button("提交答案") { Task { await send(request) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(submitting || answers(for: request) == nil)
                        .accessibilityIdentifier("user-input-submit")
                }
            } else {
                Text("当前客户端无法处理这种问题，请更新客户端。")
                    .foregroundStyle(.secondary)
                Button("关闭") { dismiss() }
            }
        }
        .padding(20)
        .frame(width: 480, height: 440)
        .accessibilityIdentifier("conversation-user-input")
    }

    private func answers(for request: ConversationUserInput) -> [String: [String]]? {
        request.answers(selected: selected, typed: typed)
    }

    private func send(_ request: ConversationUserInput, cancelling: Bool = false) async {
        guard !submitting, let answers = cancelling ? [:] : answers(for: request) else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            try await submit(answers, cancelling ? "cancel" : "submit")
            typed.removeAll()
            selected.removeAll()
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
