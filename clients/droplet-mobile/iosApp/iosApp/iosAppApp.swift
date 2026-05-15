import SwiftUI

@main
struct iosAppApp: App {
    @StateObject private var coordinator = AppCoordinator()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(coordinator)
                .onOpenURL { url in
                    coordinator.handleDeepLink(url: url)
                }
        }
    }
}
