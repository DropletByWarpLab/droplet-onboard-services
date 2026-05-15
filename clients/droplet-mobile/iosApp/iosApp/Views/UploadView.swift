import SwiftUI
import PhotosUI
import DropletShared

/// PHPicker-driven upload to `Photos/` on the paired Droplet. Mirrors the
/// Android flow: pick up to 20 items, sequential PUT, per-file failure
/// list on completion. No photo-library permission prompt — `PHPicker`
/// hands back sandboxed read-only access for the specific items the user
/// chose.
struct UploadView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @StateObject private var viewModel = UploadSwiftViewModel()
    @State private var pickerItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(spacing: 20) {
            HStack {
                Button(action: { coordinator.backToHome() }) {
                    Image(systemName: "chevron.left")
                    Text("Home")
                }
                Spacer()
                Text("Upload photos").font(.headline)
                Spacer()
                Spacer().frame(width: 60)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            switch viewModel.phase {
            case .idle:
                Spacer()
                Image(systemName: "icloud.and.arrow.up")
                    .resizable().renderingMode(.template)
                    .frame(width: 64, height: 56)
                    .foregroundStyle(Color.accentColor)
                Text("Pick photos to upload")
                    .font(.title3.weight(.semibold))
                Text("Up to 20 photos at a time. They land in the Photos folder on your Droplet.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 24)
                PhotosPicker(
                    selection: $pickerItems,
                    maxSelectionCount: 20,
                    matching: .images,
                    photoLibrary: .shared()
                ) {
                    Text("Choose photos")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 24)
                Spacer()
            case .working:
                Spacer()
                ProgressView(value: progressFraction)
                    .padding(.horizontal, 48)
                Text("Uploading \(viewModel.completed + 1) of \(viewModel.total)")
                    .font(.body)
                if let name = viewModel.currentName {
                    Text(name).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            case .done:
                Spacer()
                Text("All done")
                    .font(.title.weight(.semibold))
                Text("\(viewModel.completed - viewModel.failures.count) of \(viewModel.total) uploaded.")
                    .foregroundStyle(.secondary)
                if !viewModel.failures.isEmpty {
                    VStack(alignment: .leading) {
                        Text("Couldn't upload").font(.headline).foregroundStyle(.red)
                        ForEach(viewModel.failures, id: \.self) { name in
                            Text("• \(name)").font(.subheadline)
                        }
                    }
                    .padding(.horizontal, 24)
                }
                Button("Pick more photos") {
                    viewModel.reset()
                    pickerItems = []
                }
                .buttonStyle(.borderedProminent)
                Button("Back to Droplet") { coordinator.backToHome() }
                Spacer()
            case .failed(let message):
                Spacer()
                Text("Upload couldn't start").font(.title3.weight(.semibold))
                Text(message).foregroundStyle(.red).multilineTextAlignment(.center).padding(.horizontal, 24)
                Button("Try again") { viewModel.reset() }
                    .buttonStyle(.borderedProminent)
                Spacer()
            }
        }
        .onAppear { viewModel.bind(coordinator: coordinator) }
        .onChange(of: pickerItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            viewModel.upload(pickerItems: newItems)
        }
    }

    private var progressFraction: Double {
        guard viewModel.total > 0 else { return 0 }
        return Double(viewModel.completed) / Double(viewModel.total)
    }
}

@MainActor
final class UploadSwiftViewModel: ObservableObject {
    enum Phase {
        case idle
        case working
        case done
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var total: Int = 0
    @Published private(set) var completed: Int = 0
    @Published private(set) var currentName: String? = nil
    @Published private(set) var failures: [String] = []

    private var repository: FilesRepository?

    func bind(coordinator: AppCoordinator) {
        if repository == nil {
            repository = coordinator.makeFilesRepository()
        }
    }

    func reset() {
        phase = .idle
        total = 0
        completed = 0
        currentName = nil
        failures = []
    }

    func upload(pickerItems: [PhotosPickerItem]) {
        guard let repository else { return }
        total = pickerItems.count
        completed = 0
        failures = []
        phase = .working

        Task {
            // Ensure Photos/ exists up-front so the first PUT doesn't 409.
            do {
                try await repository.ensureDirectory(path: "Photos")
            } catch {
                phase = .failed((error as NSError).localizedDescription)
                return
            }

            for (index, item) in pickerItems.enumerated() {
                let displayName = item.itemIdentifier.flatMap { "asset-\($0).jpg" } ?? "photo-\(Int(Date().timeIntervalSince1970))-\(index).jpg"
                self.currentName = displayName
                do {
                    let data = try await item.loadTransferable(type: Data.self) ?? Data()
                    let kotlinBytes = data.toKotlinByteArray()
                    try await repository.upload(
                        path: "Photos/\(displayName)",
                        body: kotlinBytes,
                        contentType: nil
                    )
                } catch {
                    failures.append(displayName)
                }
                completed = index + 1
            }
            phase = .done
        }
    }
}

private extension Data {
    /// Slow but correct: copy each byte into a fresh `KotlinByteArray`.
    /// Adequate for v1.5's manual-picker scale (a handful of photos at a
    /// time); v2 should add a Ktor-side multipart upload that streams from
    /// the platform `Data` directly.
    func toKotlinByteArray() -> KotlinByteArray {
        let arr = KotlinByteArray(size: Int32(self.count))
        self.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let p = raw.bindMemory(to: Int8.self).baseAddress!
            for i in 0..<self.count {
                arr.set(index: Int32(i), value: p[i])
            }
        }
        return arr
    }
}
