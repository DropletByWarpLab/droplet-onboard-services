import SwiftUI

struct WelcomeView: View {
    @EnvironmentObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: 24) {
            Spacer().frame(height: 32)
            ZStack {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 96, height: 96)
                Image(systemName: "qrcode.viewfinder")
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
            }
            VStack(spacing: 8) {
                Text("Pair your Droplet")
                    .font(.system(size: 32, weight: .semibold))
                Text("Connect this device to your home Droplet to access your files, photos, and chats — all stored on your hardware.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
            VStack(alignment: .leading, spacing: 16) {
                FeatureRow(icon: "qrcode.viewfinder", text: "Scan the QR code on your dashboard")
                FeatureRow(icon: "lock.fill", text: "Sign in once — credentials never leave the device")
                FeatureRow(icon: "wifi", text: "Talks directly to your Droplet over your network")
            }
            .padding(.horizontal, 24)
            Spacer()
            Button(action: { coordinator.startPairing() }) {
                Text("Pair with Droplet")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }
}

private struct FeatureRow: View {
    let icon: String
    let text: String
    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .frame(width: 28, height: 28)
                .foregroundStyle(Color.accentColor)
            Text(text)
                .font(.body)
        }
    }
}
