import SwiftUI
import CorptieConversation

struct ManagementCategoryRow: View {
    let title: String
    let systemImage: String
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage).frame(width: 20)
            Text(title).font(WorkbenchTypography.font(for: .body)).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .contentShape(Rectangle())
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
            }
        }
    }
}

/// Native layout chooses the stacked variant when the two columns do not fit.
struct SettingsOptionRow<Control: View>: View {
    let title: String
    var explanation: String? = nil
    @ViewBuilder let control: () -> Control

    private var label: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(WorkbenchTypography.font(for: .body))
            if let explanation {
                Text(explanation).font(WorkbenchTypography.font(for: .help))
                    .foregroundStyle(.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                label.frame(minWidth: 288, idealWidth: 288, maxWidth: .infinity, alignment: .leading)
                control().frame(width: 220, alignment: .trailing)
            }
            VStack(alignment: .leading, spacing: 8) {
                label
                control().frame(maxWidth: 220, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
