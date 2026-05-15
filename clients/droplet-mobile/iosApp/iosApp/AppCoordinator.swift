import Foundation
import SwiftUI
import DropletShared

/// Top-level state machine: which screen is currently shown.
///
/// Mirrors the Android nav graph rules: a saved session lands us on
/// `paired`; a `droplet://pair?...` deep link jumps straight to `pairFlow`;
/// otherwise we show the welcome screen.
@MainActor
final class AppCoordinator: ObservableObject {

    enum Route: Equatable {
        case welcome
        case scan
        case pairFlow(server: String, code: String)
        case paired
    }

    @Published var route: Route

    private let credentialStore = CredentialStore()
    private let deviceInfo = DeviceInfo(
        ownerName: nil,
        appVersion: Bundle.main.shortVersion ?? "0.1.0"
    )

    init() {
        if credentialStore.load() != nil {
            self.route = .paired
        } else {
            self.route = .welcome
        }
    }

    func startPairing() {
        route = .scan
    }

    func handleScanResult(_ raw: String) {
        guard let pair = DropletPairUri.companion.parseOrNull(raw: raw) else { return }
        route = .pairFlow(server: pair.server, code: pair.code)
    }

    func handleDeepLink(url: URL) {
        guard let pair = DropletPairUri.companion.parseOrNull(raw: url.absoluteString) else { return }
        route = .pairFlow(server: pair.server, code: pair.code)
    }

    func completePair() {
        route = .paired
    }

    func cancel() {
        route = .welcome
    }

    func forget() {
        credentialStore.clear()
        route = .welcome
    }

    func session() -> DropletSession? {
        credentialStore.load()
    }

    /// Build a `PairingRepository` for the given server. Each call constructs
    /// a fresh underlying `HttpClient` (and cookie jar), so login + claim
    /// must use the same instance — the PairFlowView holds it for its
    /// lifetime.
    func makeRepository(for serverUrl: String) -> PairingRepository {
        let rawClient = HttpClientFactoryKt.createPlatformHttpClient(allowSelfSignedHosts: [])
        let api = DropletApiClient(baseUrl: serverUrl, rawClient: rawClient)
        return PairingRepository(
            api: api,
            credentialStore: credentialStore,
            deviceInfo: deviceInfo,
            serverUrl: serverUrl
        )
    }
}

private extension Bundle {
    var shortVersion: String? {
        infoDictionary?["CFBundleShortVersionString"] as? String
    }
}
