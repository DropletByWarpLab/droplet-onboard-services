import SwiftUI
import DropletShared

/// Sign-in + claim in one screen against a single PairingRepository (so the
/// cookie jar survives the gap between /api/auth/login and /api/devices/pair/claim).
struct PairFlowView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @StateObject private var viewModel: PairFlowSwiftViewModel

    init(serverUrl: String, code: String) {
        // The repository can only be built from the coordinator's makeRepository
        // helper, but @StateObject requires the value at init time. We use
        // a placeholder + a one-shot bind() in onAppear to wire the live
        // repository — see the body below.
        _viewModel = StateObject(wrappedValue: PairFlowSwiftViewModel(serverUrl: serverUrl, code: code))
    }

    var body: some View {
        VStack(spacing: 16) {
            Spacer().frame(height: 8)
            Text("Sign in")
                .font(.title2.weight(.semibold))
            Text("Use your Droplet account at \(viewModel.serverUrl)")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text("Pair code: \(viewModel.code)")
                .font(.callout)
                .foregroundStyle(.tertiary)

            switch viewModel.phase {
            case .idle:
                TextField("Username", text: $viewModel.username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.vertical, 12).padding(.horizontal, 16)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.gray.opacity(0.4)))
                SecureField("Password", text: $viewModel.password)
                    .textContentType(.password)
                    .padding(.vertical, 12).padding(.horizontal, 16)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.gray.opacity(0.4)))
                if let message = viewModel.errorMessage {
                    Text(message)
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }
                Button(action: { viewModel.submit() }) {
                    Text("Sign in & pair").frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
            case .authenticating:
                ProgressView("Signing in…").progressViewStyle(.circular).padding(.top, 32)
            case .claiming:
                ProgressView("Pairing this device…").progressViewStyle(.circular).padding(.top, 32)
            case .success:
                ProgressView("Paired!").progressViewStyle(.circular).padding(.top, 32)
                    .onAppear {
                        coordinator.completePair()
                    }
            }
            Spacer()
            Button("Cancel") { coordinator.cancel() }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
        .onAppear { viewModel.bind(coordinator: coordinator) }
    }
}

/// View-model bridging SwiftUI state to the shared `PairingRepository`.
/// Kotlin/Native exposes `suspend fun` as a closure-callback variant; we
/// wrap with Swift Concurrency via continuations.
@MainActor
final class PairFlowSwiftViewModel: ObservableObject {
    enum Phase { case idle, authenticating, claiming, success }

    let serverUrl: String
    let code: String

    @Published var username: String = ""
    @Published var password: String = ""
    @Published var phase: Phase = .idle
    @Published var errorMessage: String? = nil

    private var repository: PairingRepository?

    init(serverUrl: String, code: String) {
        self.serverUrl = serverUrl
        self.code = code
    }

    func bind(coordinator: AppCoordinator) {
        if repository == nil {
            repository = coordinator.makeRepository(for: serverUrl)
        }
    }

    func submit() {
        guard !username.isEmpty, !password.isEmpty else {
            errorMessage = "Enter your username and password."
            return
        }
        guard let repository else { return }
        errorMessage = nil
        phase = .authenticating
        Task {
            do {
                let login = try await repository.signIn(username: username.trimmingCharacters(in: .whitespaces), password: password)
                phase = .claiming
                let pairUri = DropletPairUri(server: serverUrl, code: code)
                _ = try await repository.claim(pairUri: pairUri, signedInUser: login.user)
                phase = .success
            } catch {
                errorMessage = Self.userMessage(for: error)
                phase = .idle
            }
        }
    }

    private static func userMessage(for error: Error) -> String {
        let ns = error as NSError
        switch ns.localizedDescription {
        case let s where s.contains("Invalid username or password"):
            return "Username or password didn't match."
        case let s where s.contains("expired"):
            return "This pair code has expired. Generate a fresh one from the dashboard."
        case let s where s.contains("already used"):
            return "This pair code has already been used. Generate a fresh one from the dashboard."
        case let s where s.contains("Unknown pairing code"):
            return "That pair code wasn't recognised by the Droplet."
        case let s where s.contains("different account"):
            return "This code was created for a different account."
        case let s where s.contains("Too many attempts"):
            return "Too many attempts — wait a moment, then try again."
        default:
            return ns.localizedDescription
        }
    }
}
