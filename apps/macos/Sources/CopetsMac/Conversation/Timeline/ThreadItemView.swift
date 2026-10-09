import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ThreadItemView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    @State private var isActivityExpanded = false
    @State private var isCollaborationDetailsExpanded = false
    @State private var isHovering = false
    @State private var isConfirmingUndo = false
    @State private var isDiffActionRunning = false
    @State private var diffActionError: String?
    @State private var isTurnUndone = false
    let item: CodexThreadItem
    @Binding private var isCollaborationExpanded: Bool
    @Binding private var isCollaborationConfirmationExpanded: Bool

    init(
        item: CodexThreadItem,
        isCollaborationExpanded: Binding<Bool>,
        isCollaborationConfirmationExpanded: Binding<Bool>
    ) {
        self.item = item
        _isCollaborationExpanded = isCollaborationExpanded
        _isCollaborationConfirmationExpanded = isCollaborationConfirmationExpanded
    }

    var body: some View {
        if isCollaborationConfirmationItem {
            collaborationConfirmationView
        } else if isCollaborationItem {
            collaborationItemView
        } else if isHandledPermissionItem {
            handledPermissionView
        } else {
            fullItemView
        }
    }

    private var collaborationConfirmationView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    isCollaborationConfirmationExpanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isCollaborationConfirmationExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8.5, weight: .bold))
                        .frame(width: 10)
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Group {
                        if isSessionChannelAuthorization {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                        } else {
                            CollaborationHandshakeIcon().frame(width: 12, height: 12)
                        }
                    }
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.softBlue)
                    Text(L10n(isSessionChannelAuthorization ? "首次授权并发送" : "确认发送协作任务"))
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                    Spacer(minLength: 4)
                    Text(collaborationConfirmationStatusLabel)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(collaborationConfirmationStatusColor)
                }
                .padding(.horizontal, 9)
                .frame(maxWidth: .infinity)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .help(isCollaborationConfirmationExpanded ? "收起发送详情" : "展开发送详情")

            if isCollaborationConfirmationExpanded {
                Divider()
                    .overlay(CorptiePalette.collaborationBorder.opacity(0.42))
                if isSessionChannelAuthorization, collaborationConfirmationStatus == "pending" {
                    Text(L10n("首次与此会话建立通道，或原通道已撤销。授权仅适用于这两个 Session。"))
                        .font(.caption).foregroundStyle(CorptiePalette.secondaryText).padding(10)
                }

                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 7) {
                        if let sourceSession = nonEmpty(item.collaborationInitiatorSessionId) {
                            collaborationConfirmationField(
                                icon: "arrow.up.right",
                                label: "来源 Session",
                                value: collaborationSessionIdentity(
                                    title: item.collaborationInitiatorSessionTitle,
                                    id: sourceSession,
                                    kind: item.collaborationInitiatorSessionKind,
                                    taskId: item.collaborationSourceCorptieTaskId
                                )
                            )
                        }
                        if let recipientSession = nonEmpty(item.collaborationRecipientSessionId) {
                            collaborationConfirmationField(
                                icon: "arrow.down.left",
                                label: "目标 Session",
                                value: collaborationSessionIdentity(
                                    title: item.collaborationRecipientSessionTitle,
                                    id: recipientSession,
                                    kind: item.collaborationRecipientSessionKind,
                                    taskId: item.collaborationTargetCorptieTaskId
                                )
                            )
                        } else if isSessionChannelAuthorization {
                            collaborationConfirmationField(
                                icon: "person.badge.plus",
                                label: "目标 Session",
                                value: L10n("确认后创建目标 CorptieTask 与 Session")
                            )
                        } else {
                            collaborationConfirmationField(
                                icon: "checklist",
                                label: "目标 CorptieTask",
                                value: collaborationPendingTargetCorptieTask
                            )
                        }
                        if let sourceWork = collaborationWork(
                            name: item.collaborationSourceWorkName,
                            id: item.collaborationSourceWorkId,
                            fallback: L10n("来源 Work")
                        ) {
                            collaborationConfirmationField(icon: "arrow.up.right.square", label: "来源 Work", value: sourceWork)
                        }
                        if let targetWork = collaborationWork(
                            name: item.collaborationTargetWorkName,
                            id: item.collaborationTargetWorkId,
                            fallback: L10n("目标 Work")
                        ) {
                            collaborationConfirmationField(icon: "arrow.down.left.square", label: "目标 Work", value: targetWork)
                        }
                        collaborationConfirmationField(icon: "text.alignleft", label: "消息", value: collaborationPresentationText)
                    }

                    if !isSessionChannelAuthorization,
                       let criteria = item.collaborationAcceptanceCriteria, !criteria.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(L10n("验收标准"))
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            ForEach(criteria, id: \.self) { criterion in
                                Label(criterion, systemImage: "checkmark.circle")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(CorptiePalette.primaryText)
                            }
                        }
                    }

                    if collaborationConfirmationStatus == "pending",
                       let confirmationId = item.collaborationConfirmationId {
                        HStack(spacing: 8) {
                            Button {
                                backendClient.respondToCollaborationConfirmation(confirmationId: confirmationId, approve: true)
                            } label: {
                                Label(
                                    L10n(isSessionChannelAuthorization ? "授权并发送" : "确认发送"),
                                    systemImage: isSessionChannelAuthorization ? "checkmark.shield.fill" : "paperplane.fill"
                                )
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(CorptiePalette.softBlue)

                            Button {
                                backendClient.respondToCollaborationConfirmation(confirmationId: confirmationId, approve: false)
                            } label: {
                                Text(L10n("取消"))
                                    .frame(minWidth: 52)
                            }
                            .buttonStyle(.bordered)
                        }
                        .controlSize(.small)
                        .disabled(backendClient.isSendingMessage)

                        Text(L10n("也可以直接回复“确认”或“取消”"))
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.top, 9)
                .padding(.bottom, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if collaborationConfirmationStatus == "confirmed" {
                Divider()
                    .overlay(CorptiePalette.collaborationBorder.opacity(0.42))
                Label(L10n("已发送"), systemImage: "checkmark.circle.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(CorptiePalette.connected)
                    .padding(.horizontal, 10)
                    .frame(height: 30, alignment: .leading)
                    .accessibilityIdentifier("collaboration.confirmation.confirmed")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CorptiePalette.collaborationSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(CorptiePalette.collaborationBorder.opacity(0.62), lineWidth: 1)
                .allowsHitTesting(false)
        )
        .animation(.easeInOut(duration: 0.16), value: isCollaborationConfirmationExpanded)
        .onChange(of: collaborationConfirmationStatus) { _, status in
            if status != "pending" {
                withAnimation(.easeOut(duration: 0.16)) {
                    isCollaborationConfirmationExpanded = false
                }
            }
        }
    }

    private func collaborationConfirmationField(icon: String, label: String, value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: icon)
                .frame(width: 13)
                .foregroundStyle(CorptiePalette.softBlue)
            Text(label)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(width: 94, alignment: .leading)
            Text(value)
                .font(.system(size: 10.5, weight: .semibold, design: monospaced ? .monospaced : .default))
                .foregroundStyle(CorptiePalette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func collaborationWork(name: String?, id: String?, fallback: String) -> String? {
        guard nonEmpty(id) != nil else { return nil }
        guard let name = nonEmpty(name), name != nonEmpty(id), !looksLikeTechnicalID(name) else { return fallback }
        return name
    }

    private func collaborationSessionIdentity(title: String?, id: String, kind: String?, taskId: String?) -> String {
        guard let title = nonEmpty(title), title != id, !looksLikeTechnicalID(title) else { return L10n("会话") }
        return title
    }

    private var collaborationPendingTargetCorptieTask: String {
        let title = nonEmpty(item.collaborationTaskTitle).flatMap { looksLikeTechnicalID($0) ? nil : $0 }
        let resolvedIdentity = title ?? L10n("未命名协作任务")
        guard nonEmpty(item.collaborationTargetCorptieTaskId) == nil else { return resolvedIdentity }
        return "\(resolvedIdentity) · \(L10n("确认后在目标 Work 下新建"))"
    }

    private func looksLikeTechnicalID(_ value: String) -> Bool {
        let normalized = value.lowercased()
        return normalized.hasPrefix("session:")
            || normalized.hasPrefix("work:")
            || normalized.hasPrefix("task:")
    }

    private var isCollaborationConfirmationItem: Bool {
        ConversationPresentationKind.resolve(
            type: item.type, presentationRole: item.presentationRole) == .collaborationConfirmation
    }

    private var collaborationConfirmationStatus: String {
        (item.collaborationConfirmationStatus ?? item.status ?? "pending").lowercased()
    }

    private var isSessionChannelAuthorization: Bool {
        item.collaborationAuthorizationKind == "session_channel"
    }

    private var collaborationConfirmationStatusLabel: String {
        switch collaborationConfirmationStatus {
        case "confirmed": "已发送"
        case "submitting", "rejecting": "正在提交…"
        case "rejected": "已取消"
        default: "等待确认"
        }
    }

    private var collaborationConfirmationStatusColor: Color {
        switch collaborationConfirmationStatus {
        case "confirmed": CorptiePalette.connected
        case "rejected": CorptiePalette.mutedText
        default: CorptiePalette.amber
        }
    }

    private var collaborationItemView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(response: 0.30, dampingFraction: 0.86, blendDuration: 0.08)) {
                    isCollaborationExpanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8.5, weight: .bold))
                        .frame(width: 10)
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .rotationEffect(.degrees(isCollaborationExpanded ? 90 : 0))
                    CollaborationHandshakeIcon().frame(width: 12, height: 12)
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.softBlue)
                    Text(L10n("跨会话协作"))
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                    Text(collaborationKindLabel)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                        .padding(.horizontal, 5)
                        .frame(height: 16)
                        .background(Color.white.opacity(0.24), in: Capsule())
                    Text("· \(collaborationSourceSessionName) → \(collaborationTargetSessionName)")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Label(collaborationStatusLabel, systemImage: collaborationStatusIcon)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(collaborationStatusColor)
                }
                .padding(.horizontal, 9)
                .frame(maxWidth: .infinity)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .help(isCollaborationExpanded ? "收起协作消息" : "展开跨会话协作消息")

            if isCollaborationExpanded {
                Divider()
                    .overlay(CorptiePalette.collaborationBorder.opacity(0.42))

                ZStack(alignment: .bottomTrailing) {
                    VStack(alignment: .leading, spacing: 10) {
                        collaborationConfirmationField(
                            icon: "arrow.up.right",
                            label: "来源 Session",
                            value: collaborationSourceSessionName
                        )
                        collaborationConfirmationField(
                            icon: "arrow.down.left",
                            label: "目标 Session",
                            value: collaborationTargetSessionName
                        )
                        collaborationConfirmationField(
                            icon: "arrow.up.right.square",
                            label: "来源 Work",
                            value: collaborationSourceWorkName
                        )
                        collaborationConfirmationField(
                            icon: "arrow.down.left.square",
                            label: "目标 Work",
                            value: collaborationTargetWorkName
                        )

                        if let taskTitle = nonEmpty(item.collaborationTaskTitle) {
                            Label(taskTitle, systemImage: "checklist")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .lineLimit(2)
                        }

                        messageTextView(text: collaborationPresentationText, allowsSelection: true)

                    }

                    CopyTextButton(
                        text: collaborationPresentationText,
                        isVisible: isHovering && !collaborationPresentationText.isEmpty
                    )
                    .padding(2)
                }
                .padding(.horizontal, 10)
                .padding(.top, 9)
                .padding(.bottom, 10)
                .transition(.asymmetric(
                    insertion: .opacity
                        .combined(with: .move(edge: .top))
                        .combined(with: .scale(scale: 0.985, anchor: .top)),
                    removal: .opacity
                        .combined(with: .move(edge: .top))
                        .combined(with: .scale(scale: 0.99, anchor: .top))
                ))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CorptiePalette.collaborationSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(CorptiePalette.collaborationBorder.opacity(0.62), lineWidth: 1)
                .allowsHitTesting(false)
        )
        .onHover { isHovering = $0 }
        .animation(.spring(response: 0.30, dampingFraction: 0.86, blendDuration: 0.08), value: isCollaborationExpanded)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10nFormat("Cross-session collaboration message from %@", collaborationSourceSessionName))
    }

    private func collaborationPartyRow(label: String, name: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(width: 34, alignment: .leading)
            Text(name)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(CorptiePalette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func collaborationAvatar(name: String) -> some View {
        DefaultInitialAvatarView(
            seed: name,
            initials: DefaultAvatarInitials.make(from: name),
            size: 20
        )
    }

    @ViewBuilder
    private func collaborationDetailRow(label: String, value: String?) -> some View {
        if let value = nonEmpty(value) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(label)
                    .frame(width: 68, alignment: .leading)
                    .foregroundStyle(CorptiePalette.secondaryText)
                Text(value)
                    .foregroundStyle(CorptiePalette.primaryText)
                    .textSelection(.enabled)
            }
            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
        }
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private var isCollaborationItem: Bool {
        ConversationPresentationKind.resolve(
            type: item.type, presentationRole: item.presentationRole) == .collaborationMessage
    }

    private var collaborationPresentationText: String {
        nonEmpty(item.presentationText) ?? "协作消息正文不可用"
    }

    private var collaborationSourceSessionName: String {
        collaborationSessionIdentity(
            title: item.collaborationInitiatorSessionTitle,
            id: item.collaborationInitiatorSessionId ?? "",
            kind: item.collaborationInitiatorSessionKind,
            taskId: item.collaborationSourceCorptieTaskId
        )
    }

    private var collaborationTargetSessionName: String {
        collaborationSessionIdentity(
            title: item.collaborationRecipientSessionTitle ?? backendClient.selectedSession?.title,
            id: item.collaborationRecipientSessionId ?? "",
            kind: item.collaborationRecipientSessionKind,
            taskId: item.collaborationTargetCorptieTaskId
        )
    }

    private var collaborationSourceWorkName: String {
        collaborationWork(
            name: item.collaborationSourceWorkName,
            id: item.collaborationSourceWorkId,
            fallback: L10n("来源 Work")
        ) ?? L10n("来源 Work")
    }

    private var collaborationTargetWorkName: String {
        collaborationWork(
            name: item.collaborationTargetWorkName,
            id: item.collaborationTargetWorkId,
            fallback: L10n("目标 Work")
        ) ?? L10n("目标 Work")
    }

    private var collaborationKindLabel: String {
        switch item.collaborationMessageKind?.lowercased() {
        case "change_request": "修改请求"
        case "needs_information": "澄清请求"
        case "update_ready": "结果"
        case "verification_result": "验收结果"
        case "question": "请求"
        default: "协作消息"
        }
    }

    private var collaborationProcessingStatus: String {
        (item.collaborationProcessingStatus ?? item.status ?? "queued").lowercased()
    }

    private var collaborationStatusLabel: String {
        switch collaborationProcessingStatus {
        case "sent", "delivered": "已发送"
        case "running", "processing": "处理中"
        case "completed", "complete": "已处理"
        case "failed": "处理失败"
        case "cancelled", "canceled": "已取消"
        default: "等待处理"
        }
    }

    private var collaborationStatusIcon: String {
        switch collaborationProcessingStatus {
        case "sent", "delivered": "paperplane.fill"
        case "running", "processing": "clock.arrow.circlepath"
        case "completed", "complete": "checkmark.circle.fill"
        case "failed": "exclamationmark.circle.fill"
        case "cancelled", "canceled": "xmark.circle.fill"
        default: "clock.fill"
        }
    }

    private var collaborationStatusColor: Color {
        switch collaborationProcessingStatus {
        case "sent", "delivered": CorptiePalette.connected
        case "running", "processing": CorptiePalette.running
        case "completed", "complete": CorptiePalette.connected
        case "failed", "cancelled", "canceled": .red
        default: CorptiePalette.amber
        }
    }

    private var fullItemView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !isUserOrAgentMessage {
                HStack(spacing: 8) {
                    itemTitleView
                    Spacer()
                    Text(itemMetadataLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(CorptiePalette.mutedText)
                }
            }

            if !item.text.isEmpty {
                if item.type == "agentMessage" {
                    agentMessageTextView
                } else {
                    messageTextView(text: item.text, allowsSelection: true, fillWidth: !isUserMessage)
                }
            }

            if let userMessageStatusLabel {
                Label(userMessageStatusLabel, systemImage: userMessageStatusIcon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(userMessageStatusColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(userMessageStatusColor.opacity(0.11), in: Capsule())
                    .accessibilityLabel(userMessageStatusAccessibilityLabel)
            }

            if item.type == "choice",
               item.status == "selected",
               let selected = item.options?.first(where: { $0.selected == true }) {
                Label(L10nFormat("Selected: %@", selected.label), systemImage: "checkmark.circle.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(CorptiePalette.connected)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(CorptiePalette.connected.opacity(0.10), in: Capsule())
            }

            if shouldShowOptions {
                optionButtonStack {
                    ForEach(approvalOptions) { option in
                        Button {
                            if item.type == "approval" {
                                backendClient.respondToCodexApproval(option: option)
                            } else if item.type == "choice" {
                                backendClient.respondToPtyChoice(option: option, choiceId: item.id)
                            } else {
                                backendClient.sendMessage(option.label)
                            }
                        } label: {
                            Label(option.label, systemImage: iconName(for: option))
                                .font(.system(size: 11, weight: .bold))
                                .padding(.horizontal, 10)
                                .frame(maxWidth: item.type == "agentMessage" ? .infinity : nil, minHeight: 28, alignment: .leading)
                                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .background(optionBackground(for: option), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(optionBorder(for: option), lineWidth: 1)
                        )
                        .help(option.label)
                    }
                }
                .padding(.top, 2)
                .disabled(backendClient.isSendingMessage)
                .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topLeading)))
            }

            if hasFileChanges {
                codeChangeSummary
                    .padding(.top, 4)
            }
        }
        .padding(10)
        // 气泡本身采用共享策略算出的明确内容宽度；外层 frame 只负责左右定位。
        // 不能用 maxWidth 模拟 CSS w-fit：Markdown 会接受宽度提议并把短消息撑到上限。
        .background(itemBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(itemBorder, lineWidth: 1)
        )
        .overlay(alignment: .bottomTrailing) {
            // A transparent button must not participate in the bubble's ideal
            // size. Keeping it as an overlay lets short messages measure only
            // their text and padding.
            CopyTextButton(
                text: item.text,
                isVisible: isHovering && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
            .padding(4)
        }
        .frame(
            idealWidth: isUserOrAgentMessage ? preferredMessageBubbleWidth : nil,
            maxWidth: isUserOrAgentMessage ? preferredMessageBubbleWidth : .infinity,
            alignment: isUserMessage ? .trailing : .leading
        )
        .overlay(alignment: isUserMessage ? .leading : .trailing) {
            if isUserOrAgentMessage, let itemTimeLabel {
                Text(itemTimeLabel)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(width: 76, alignment: isUserMessage ? .trailing : .leading)
                    .offset(x: isUserMessage ? -84 : 84)
                    .opacity(isHovering ? 1 : 0)
                    .animation(.easeOut(duration: 0.12), value: isHovering)
                    .allowsHitTesting(false)
                    .accessibilityHidden(!isHovering)
            }
        }
        .frame(
            maxWidth: .infinity,
            alignment: isUserMessage ? .trailing : .leading
        )
        .onHover { hovering in
            isHovering = hovering
        }
        .animation(.easeInOut(duration: 0.18), value: shouldShowOptions)
        .confirmationDialog(
            "Undo changes from this reply?",
            isPresented: $isConfirmingUndo,
            titleVisibility: .visible
        ) {
            Button(L10n("Undo Changes"), role: .destructive) {
                undoChanges()
            }
            Button(L10n("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n("This reverses only the recorded patch. It will stop if newer edits conflict."))
        }
        .alert(L10n("Code Diff"), isPresented: Binding(
            get: { diffActionError != nil },
            set: { if !$0 { diffActionError = nil } }
        )) {
            Button(L10n("OK"), role: .cancel) {}
        } message: {
            Text(diffActionError ?? "Unknown error")
        }
    }

    @ViewBuilder
    private var itemTitleView: some View {
        Text(item.title)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(itemColor)
    }

    private var hasFileChanges: Bool {
        item.type == "agentMessage" && !(item.fileChanges ?? []).isEmpty
    }

    private var codeChangeSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            Divider()
            HStack(spacing: 6) {
                Image(systemName: "doc.text.magnifyingglass")
                Text(L10n("Changed Files"))
                Text("\(item.fileChanges?.count ?? 0)")
                    .foregroundStyle(CorptiePalette.mutedText)
                Spacer()
            }
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(CorptiePalette.secondaryText)

            VStack(alignment: .leading, spacing: 4) {
                ForEach(item.fileChanges ?? [], id: \.path) { change in
                    HStack(spacing: 7) {
                        Image(systemName: fileChangeIcon(change.kind))
                            .frame(width: 12)
                            .foregroundStyle(fileChangeColor(change.kind))
                        Text(change.path)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }

            HStack(spacing: 8) {
                Button {
                    reviewChanges()
                } label: {
                    Label(L10n("Review"), systemImage: "arrow.up.forward.app")
                }
                .help(L10n("Open this turn's diff in the selected external tool"))

                Button(role: .destructive) {
                    isConfirmingUndo = true
                } label: {
                    Label(isTurnUndone ? L10n("Undone") : L10n("Undo"), systemImage: "arrow.uturn.backward")
                }
                .help(L10n("Reverse only the changes recorded for this reply"))
                .disabled(isTurnUndone)

                if isDiffActionRunning {
                    ProgressView()
                        .controlSize(.small)
                }
                Spacer()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isDiffActionRunning)
        }
    }

    private func reviewChanges() {
        guard let sessionId = backendClient.selectedSession?.id else { return }
        isDiffActionRunning = true
        Task {
            defer { isDiffActionRunning = false }
            if case .failure(let error) = await backendClient.reviewTurnChanges(sessionId: sessionId, turnId: item.turnId) {
                diffActionError = error.localizedDescription
            }
        }
    }

    private func undoChanges() {
        guard let sessionId = backendClient.selectedSession?.id else { return }
        isDiffActionRunning = true
        Task {
            defer { isDiffActionRunning = false }
            switch await backendClient.undoTurnChanges(sessionId: sessionId, turnId: item.turnId) {
            case .success:
                isTurnUndone = true
            case .failure(let error):
                diffActionError = error.localizedDescription
            }
        }
    }

    private func fileChangeIcon(_ kind: String) -> String {
        switch kind {
        case "add": "plus.circle.fill"
        case "delete": "minus.circle.fill"
        default: "pencil.circle.fill"
        }
    }

    private func fileChangeColor(_ kind: String) -> Color {
        switch kind {
        case "add": CorptiePalette.connected
        case "delete": .red
        default: itemColor
        }
    }

    private var itemMetadataLabel: String {
        [itemRoleLabel, item.status == "queued" ? L10n("排队中") : nil, itemTimeLabel].compactMap { value in
            guard let value, !value.isEmpty else {
                return nil
            }
            return value
        }.joined(separator: " ")
    }

    private var itemRoleLabel: String {
        if item.sourceType == "collaboration" {
            return L10n("协作任务")
        }
        switch item.type {
        case "userMessage":
            return L10n("User")
        case "agentMessage":
            return L10n("Agent")
        default:
            return L10n("System")
        }
    }

    private var itemTimeLabel: String? {
        guard let createdAt = item.createdAt,
              let date = ISO8601DateFormatter.corptieThreadItemDate(from: createdAt) else {
            return nil
        }
        return Self.metadataDateFormatter.string(from: date)
    }

    private static let metadataDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM/dd HH:mm"
        return formatter
    }()

    private var handledPermissionView: some View {
        DisclosureGroup(isExpanded: $isActivityExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                if !item.text.isEmpty {
                    messageTextView(text: item.text, allowsSelection: true)
                }
                if let selected = item.options?.first(where: { $0.selected == true }) {
                    Label(L10nFormat("Selected: %@", selected.label), systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(CorptiePalette.connected)
                }
            }
            .padding(.top, 6)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(CorptiePalette.connected)
                Text(L10n("已处理的权限请求"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                if let selected = item.options?.first(where: { $0.selected == true }) {
                    Text(selected.label)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(CorptiePalette.connected)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(CorptiePalette.connected.opacity(0.10), in: Capsule())
                }
            }
        }
        .font(.system(size: 11, weight: .medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.black.opacity(0.025), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.black.opacity(0.06), lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.18), value: isActivityExpanded)
    }

    private var isHandledPermissionItem: Bool {
        item.type == "choice"
            && item.status == "selected"
            && item.title == "Claude tool approval"
            && approvalOptions.contains { option in
                option.role?.localizedCaseInsensitiveContains("approve") == true
                    || option.role?.localizedCaseInsensitiveContains("deny") == true
            }
    }

    private var isUserMessage: Bool { item.type == "userMessage" }
    private var isAgentMessage: Bool { item.type == "agentMessage" }
    private var isUserOrAgentMessage: Bool { isUserMessage || isAgentMessage }
    /// 消息气泡最大宽度，保留左右留白。
    private var messageBubbleMaxWidth: CGFloat { ChatBubbleWidthPolicy.maximumWidth }

    private var userMessageStatusLabel: String? {
        switch item.authoritativeUserMessageState {
        case .queued:
            if let position = item.queuePosition {
                return L10nFormat("Queued · position %lld", Int64(position))
            }
            return L10n("Queued for processing")
        case .processing: return L10n("Processing")
        case .failed: return L10n("Processing failed")
        case .cancelled: return L10n("Cancelled before processing")
        case .consumed, .none: return nil
        }
    }

    private var userMessageStatusAccessibilityLabel: String {
        userMessageStatusLabel ?? ""
    }

    private var userMessageStatusIcon: String {
        switch item.authoritativeUserMessageState {
        case .queued: "clock.fill"
        case .processing: "clock.arrow.circlepath"
        case .failed: "exclamationmark.circle.fill"
        case .cancelled: "xmark.circle.fill"
        case .consumed, .none: ""
        }
    }

    private var userMessageStatusColor: Color {
        switch item.authoritativeUserMessageState {
        case .queued: CorptiePalette.amber
        case .processing: CorptiePalette.running
        case .failed, .cancelled: .red
        case .consumed, .none: CorptiePalette.secondaryText
        }
    }

    private var preferredMessageBubbleWidth: CGFloat {
        let style: AppKitChatTimelineRow.NativeStyle = isUserMessage ? .user : .agent
        let measurementText: String
        if isAgentMessage {
            let parsed = AgentMessageParts.parse(item.text)
            measurementText = parsed.body.isEmpty ? item.text : parsed.body
        } else {
            measurementText = item.text
        }
        return ChatBubbleWidthPolicy.preferredWidth(
            text: measurementText,
            style: style,
            title: "",
            metadata: ""
        )
    }

    private var itemBackground: Color {
        // 协作卡统一淡底
        if isCollaborationItem {
            return CorptiePalette.collaborationSurface
        }
        // 会话页（Sessions Tab）：用户消息右侧、Agent 消息左侧的气泡
        if !isLiquidGlass {
            if item.type == "userMessage" {
                return MessageTextCardPalette.userBackground
            }
            if item.type == "agentMessage" {
                return Color(red: 0.952, green: 0.961, blue: 0.941)
            }
            if item.type == "approval" || item.type == "choice" {
                return Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1))
            }
            return Color.clear
        }
        if item.type == "agentMessage" {
            return Color(red: 0.952, green: 0.961, blue: 0.941)
        }
        return item.type == "approval" || item.type == "choice" ? Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1)) : Color.white
    }

    private var itemBorder: Color {
        if isCollaborationItem {
            return CorptiePalette.collaborationBorder.opacity(0.62)
        }
        // 会话页：用户/Agent 消息气泡的细边框
        if !isLiquidGlass {
            if item.type == "userMessage" {
                return .clear
            }
            if item.type == "agentMessage" {
                return .clear
            }
            if item.type == "approval" || item.type == "choice" {
                return CorptiePalette.amber.opacity(0.32)
            }
            return Color.clear
        }
        if item.type == "agentMessage" { return .clear }
        return item.type == "approval" || item.type == "choice" ? CorptiePalette.amber.opacity(0.32) : Color.black.opacity(0.08)
    }

    private var itemColor: Color {
        if item.status == "queued" {
            return CorptiePalette.amber
        }
        if isCollaborationItem {
            return CorptiePalette.periwinkle
        }
        return switch item.type {
        case "userMessage": MessageTextCardPalette.userForeground
        case "approval", "choice": CorptiePalette.amber
        case "agentMessage": CorptiePalette.agentText
        case "commandExecution": CorptiePalette.amber
        case "fileChange": CorptiePalette.periwinkle
        default: .secondary
        }
    }

    @ViewBuilder
    private var agentMessageTextView: some View {
        let parsed = AgentMessageParts.parse(item.text)
        if !parsed.activity.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    withAnimation(.easeOut(duration: 0.12)) {
                        isActivityExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isActivityExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                        Text(parsed.activitySummary)
                            .font(.system(size: 10.5, weight: .semibold))
                            .lineLimit(1)
                        Spacer(minLength: 6)
                    }
                    .foregroundStyle(CorptiePalette.mutedText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)

                if isActivityExpanded {
                    Text(parsed.activity)
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.mutedText)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 7)
                        .background(Color.black.opacity(0.025), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
        }

        if !parsed.body.isEmpty {
            messageTextView(text: parsed.body, allowsSelection: true, fillWidth: false)
        }
    }

    @ViewBuilder
    private func messageTextView(text: String, allowsSelection: Bool, fillWidth: Bool = true) -> some View {
        MarkdownMessageView(
            text: text,
            baseDirectory: backendClient.selectedContentDirectory,
            allowsSelection: allowsSelection,
            fillWidth: fillWidth,
            maxContentWidth: fillWidth ? nil : (messageBubbleMaxWidth - 20)
        )
    }

    private var approvalOptions: [CodexApprovalOption] {
        if let options = item.options, !options.isEmpty {
            return options
        }
        return [
            CodexApprovalOption(id: "approve", label: "Approve", role: "approve", index: 0, selected: true),
            CodexApprovalOption(id: "deny", label: "Deny", role: "deny", index: 1, selected: false)
        ]
    }

    private var shouldShowOptions: Bool {
        guard item.status != "selected" else {
            return false
        }
        guard let options = item.options, !options.isEmpty else {
            return item.type == "approval" || item.type == "choice"
        }
        return item.type == "approval" || item.type == "choice" || item.type == "agentMessage"
    }

    @ViewBuilder
    private func optionButtonStack<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if item.type == "agentMessage" {
            VStack(alignment: .leading, spacing: 7) {
                content()
            }
        } else {
            HStack(spacing: 8) {
                content()
                Spacer()
            }
        }
    }

    private func iconName(for option: CodexApprovalOption) -> String {
        if option.role == "message-choice" {
            return "arrow.turn.down.right"
        }
        return option.role?.localizedCaseInsensitiveContains("deny") == true ? "xmark" : "checkmark"
    }

    private func optionBackground(for option: CodexApprovalOption) -> Color {
        option.role?.localizedCaseInsensitiveContains("deny") == true
            ? Color.red.opacity(0.08)
            : CorptiePalette.connected.opacity(0.14)
    }

    private func optionBorder(for option: CodexApprovalOption) -> Color {
        option.role?.localizedCaseInsensitiveContains("deny") == true
            ? Color.red.opacity(0.24)
            : CorptiePalette.connected.opacity(0.34)
    }
}
