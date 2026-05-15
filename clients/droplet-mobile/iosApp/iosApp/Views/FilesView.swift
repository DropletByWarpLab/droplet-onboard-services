import SwiftUI
import DropletShared

/// SwiftUI WebDAV list. v1.5 ships listing + folder drill-down; download
/// is deferred — `FilesRepository.download` returns Ktor's `ByteReadChannel`
/// and the Swift bridge to write that into a Photos/Files location needs
/// an iosMain helper that's a bigger lift than this pass warrants.
struct FilesView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @StateObject private var viewModel: FilesSwiftViewModel

    init(path: String) {
        _viewModel = StateObject(wrappedValue: FilesSwiftViewModel(path: path))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: backOrClose) {
                    Image(systemName: "chevron.left")
                    Text(viewModel.path.isEmpty ? "Home" : "Back")
                }
                Spacer()
                Text(viewModel.path.isEmpty ? "Files" : displayName(of: viewModel.path))
                    .font(.headline)
                Spacer()
                Button(action: { viewModel.reload() }) {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            switch viewModel.phase {
            case .loading:
                Spacer()
                ProgressView()
                Spacer()
            case .error(let message):
                ErrorView(message: message, onRetry: { viewModel.reload() })
            case .ready:
                if viewModel.entries.isEmpty {
                    Spacer()
                    Text("This folder is empty.")
                        .foregroundStyle(.secondary)
                    Spacer()
                } else {
                    List(viewModel.entries, id: \.path) { entry in
                        Button(action: { tap(entry) }) {
                            HStack(spacing: 12) {
                                Image(systemName: entry.isDirectory ? "folder.fill" : "doc")
                                    .foregroundStyle(entry.isDirectory ? Color.accentColor : Color.primary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.displayName)
                                        .foregroundStyle(.primary)
                                    Text(subtitle(of: entry))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if entry.isDirectory {
                                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
        }
        .onAppear { viewModel.bind(coordinator: coordinator) }
    }

    private func backOrClose() {
        if viewModel.path.isEmpty {
            coordinator.backToHome()
        } else {
            let parent = parentPath(of: viewModel.path)
            coordinator.openFiles(path: parent)
        }
    }

    private func tap(_ entry: WebDavEntry) {
        if entry.isDirectory {
            coordinator.openFiles(path: entry.path)
        }
        // Files are non-interactive in v1.5; download is the obvious next step.
    }
}

private func displayName(of path: String) -> String {
    if let last = path.split(separator: "/").last { return String(last) }
    return path
}

private func parentPath(of path: String) -> String {
    let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let lastSlash = trimmed.lastIndex(of: "/") else { return "" }
    return String(trimmed[..<lastSlash])
}

private func subtitle(of entry: WebDavEntry) -> String {
    var parts: [String] = []
    if let size = entry.sizeBytes?.int64Value { parts.append(humanSize(size)) }
    if let modified = entry.lastModified { parts.append(modified) }
    return parts.joined(separator: " · ")
}

private func humanSize(_ bytes: Int64) -> String {
    let fmt = ByteCountFormatter()
    fmt.allowedUnits = [.useKB, .useMB, .useGB]
    fmt.countStyle = .file
    return fmt.string(fromByteCount: bytes)
}

private struct ErrorView: View {
    let message: String
    let onRetry: () -> Void
    var body: some View {
        VStack(spacing: 12) {
            Spacer()
            Text("Couldn't load this folder")
                .font(.title3.weight(.semibold))
            Text(message)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button("Try again", action: onRetry)
                .buttonStyle(.borderedProminent)
            Spacer()
        }
    }
}

@MainActor
final class FilesSwiftViewModel: ObservableObject {
    enum Phase {
        case loading
        case ready
        case error(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var entries: [WebDavEntry] = []
    let path: String

    private var repository: FilesRepository?

    init(path: String) {
        self.path = path
    }

    func bind(coordinator: AppCoordinator) {
        if repository == nil {
            repository = coordinator.makeFilesRepository()
            reload()
        }
    }

    func reload() {
        guard let repository else { return }
        phase = .loading
        Task {
            do {
                let listed = try await repository.list(path: path, depth: 1)
                self.entries = (listed as? [WebDavEntry]) ?? []
                self.phase = .ready
            } catch {
                self.phase = .error((error as NSError).localizedDescription)
            }
        }
    }
}
