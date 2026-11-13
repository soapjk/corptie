import Combine

/// Shared conversation rendering gate used by console and detached chat hosts.
@MainActor
final class PanelLayoutState: ObservableObject {
    @Published var canRenderDetailMessages = false
}
