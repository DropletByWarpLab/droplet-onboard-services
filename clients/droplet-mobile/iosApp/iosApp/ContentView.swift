import SwiftUI

struct ContentView: View {
    @EnvironmentObject var coordinator: AppCoordinator

    var body: some View {
        switch coordinator.route {
        case .welcome:
            WelcomeView()
        case .scan:
            ScanView()
        case .pairFlow(let server, let code):
            PairFlowView(serverUrl: server, code: code)
        case .home:
            HomeView()
        case .files(let path):
            FilesView(path: path)
        case .upload:
            UploadView()
        }
    }
}
