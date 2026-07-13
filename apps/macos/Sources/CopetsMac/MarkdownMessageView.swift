import SwiftUI
@preconcurrency import MarkdownUI

struct MarkdownMessageView: View {
    let text: String
    var fontSize: CGFloat = 11
    var fontWeight: Font.Weight = .medium
    var foregroundColor: Color = CorptiePalette.secondaryText
    var allowsSelection = true

    @ViewBuilder
    var body: some View {
        if allowsSelection {
            markdownContent
                .textSelection(.enabled)
        } else {
            markdownContent
        }
    }

    private var markdownContent: some View {
        Markdown(text)
            .markdownTheme(.corptieMessage)
            .font(.system(size: fontSize, weight: fontWeight))
            .foregroundStyle(foregroundColor)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension Theme {
    @MainActor
    static let corptieMessage = Theme.gitHub
        .text {
            FontSize(11)
        }
        .heading1 { configuration in
            compactHeading(configuration, size: 1.45, top: 8, bottom: 5)
        }
        .heading2 { configuration in
            compactHeading(configuration, size: 1.3, top: 7, bottom: 4)
        }
        .heading3 { configuration in
            compactHeading(configuration, size: 1.18, top: 6, bottom: 4)
        }
        .heading4 { configuration in
            compactHeading(configuration, size: 1.08, top: 5, bottom: 3)
        }
        .heading5 { configuration in
            compactHeading(configuration, size: 1, top: 5, bottom: 3)
        }
        .heading6 { configuration in
            compactHeading(configuration, size: 0.95, top: 5, bottom: 3)
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.18))
                .markdownMargin(top: 0, bottom: 7)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.18))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.9))
                    }
                    .padding(9)
            }
            .background(Color.black.opacity(0.045))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .markdownMargin(top: 1, bottom: 7)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: .em(0.12))
        }

    @MainActor
    static func compactHeading(
        _ configuration: BlockConfiguration,
        size: Double,
        top: CGFloat,
        bottom: CGFloat
    ) -> some View {
        configuration.label
            .relativeLineSpacing(.em(0.1))
            .markdownMargin(top: top, bottom: bottom)
            .markdownTextStyle {
                FontWeight(.semibold)
                FontSize(.em(size))
            }
    }
}
