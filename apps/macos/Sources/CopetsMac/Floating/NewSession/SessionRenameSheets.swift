import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct RenameSessionSheet: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var title: String
    let session: TaskSession
    let close: () -> Void

    init(session: TaskSession, close: @escaping () -> Void) {
        self.session = session
        self.close = close
        _title = State(initialValue: session.title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L10n("Rename Chat"))
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                Button {
                    close()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(IconButtonStyle())
                .help(L10n("Close"))
            }

            TextField(L10n("Chat name"), text: $title)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                )
                .onSubmit {
                    save()
                }

            HStack {
                Spacer()
                Button {
                    save()
                } label: {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(IconButtonStyle())
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help(L10n("Save name"))
            }
        }
        .padding(18)
        .frame(width: 340)
        .background(SheetPanelBackground(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .compositingGroup()
    }

    private func save() {
        backendClient.rename(session: session, title: title) {
            close()
        }
    }
}

struct RenameCorptieTaskSheet: View {
    @ObservedObject private var entityClient = EntityAPIClient.shared
    @State private var title: String
    @State private var autoTitleEnabled: Bool
    @State private var isSaving = false
    @State private var saveError: String?
    let task: CorptieTask
    let close: () -> Void

    init(task: CorptieTask, close: @escaping () -> Void) {
        self.task = task
        self.close = close
        _title = State(initialValue: task.title)
        _autoTitleEnabled = State(initialValue: task.autoTitleEnabled ?? true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L10n("Rename Task"))
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(IconButtonStyle())
                .help(L10n("Close"))
            }

            TextField(L10n("Task name"), text: $title)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                )
                .onSubmit(save)

            Toggle(L10n("自动更新 Task 标题"), isOn: $autoTitleEnabled)

            EntityNameValidationMessage(value: title)

            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button(action: save) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(IconButtonStyle())
                .disabled(!EntityNamePolicy.isValid(title) || isSaving)
                .help(L10n("Save name"))
            }
        }
        .padding(18)
        .frame(width: 340)
        .background(SheetPanelBackground(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .compositingGroup()
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save() {
        guard EntityNamePolicy.isValid(title), !isSaving else { return }
        isSaving = true
        saveError = nil
        Task {
            if await entityClient.updateCorptieTask(taskId: task.id, title: trimmedTitle,
                autoTitleEnabled: autoTitleEnabled) != nil {
                close()
            } else {
                saveError = entityClient.errorMessage ?? L10n("CorptieTask 保存失败。")
                isSaving = false
            }
        }
    }
}

struct SheetPanelBackground: View {
    let cornerRadius: CGFloat

    var body: some View {
        if #available(macOS 26.0, *) {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.clear)
                .glassEffect(.clear.tint(Color.white.opacity(0.04)), in: .rect(cornerRadius: cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.regularMaterial)
                        .opacity(0.74)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(CorptiePalette.glassVeilFocused)
                        .opacity(0.46)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            VisualEffectView(material: .hudWindow, blendingMode: .behindWindow)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }
}
