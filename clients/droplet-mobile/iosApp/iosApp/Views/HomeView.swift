import SwiftUI

/// Post-pair landing — replaces the old PairedView. Account card + two
/// destinations + Forget.
struct HomeView: View {
    @EnvironmentObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: 20) {
            Spacer().frame(height: 24)
            ZStack {
                Circle()
                    .fill(Color.green)
                    .frame(width: 72, height: 72)
                Image(systemName: "checkmark")
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
            }
            Text("Your Droplet")
                .font(.system(size: 28, weight: .semibold))
            Text("This device is paired and ready.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let session = coordinator.session() {
                VStack(alignment: .leading, spacing: 6) {
                    SessionRow(label: "User", value: session.displayName.isEmpty ? session.username : session.displayName)
                    SessionRow(label: "Server", value: session.serverUrl)
                    SessionRow(label: "Device", value: session.deviceName)
                }
                .padding(16)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 24)
            }

            VStack(spacing: 12) {
                DestinationButton(
                    icon: "folder",
                    title: "Browse files",
                    body: "Open folders on your Droplet.",
                    action: { coordinator.openFiles() }
                )
                DestinationButton(
                    icon: "icloud.and.arrow.up",
                    title: "Upload photos",
                    body: "Pick from your library — uploads land in Photos/.",
                    action: { coordinator.openUpload() }
                )
            }
            .padding(.horizontal, 24)

            Spacer()
            Button(role: .destructive, action: { coordinator.forget() }) {
                Label("Forget this Droplet", systemImage: "rectangle.portrait.and.arrow.right")
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

private struct DestinationButton: View {
    let icon: String
    let title: String
    let body: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Image(systemName: icon)
                    .resizable()
                    .renderingMode(.template)
                    .frame(width: 28, height: 28)
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(body)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(.secondary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}
