import SwiftUI

struct PairedView: View {
    @EnvironmentObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: 24) {
            Spacer().frame(height: 32)
            ZStack {
                Circle()
                    .fill(Color.green)
                    .frame(width: 96, height: 96)
                Image(systemName: "checkmark")
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
            }
            VStack(spacing: 8) {
                Text("You're paired")
                    .font(.system(size: 32, weight: .semibold))
                Text("This device is now linked to your Droplet. Keep it safe — credentials are stored encrypted in the iOS Keychain.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
            if let session = coordinator.session() {
                VStack(alignment: .leading, spacing: 8) {
                    SessionRow(label: "Device", value: session.deviceName)
                    SessionRow(label: "Server", value: session.serverUrl)
                    SessionRow(label: "User", value: session.username)
                }
                .padding(16)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 24)
            }
            Spacer()
            Button(role: .destructive, action: { coordinator.forget() }) {
                Text("Forget this Droplet")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.bordered)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }
}

private struct SessionRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline)
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
