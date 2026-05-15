import AVFoundation
import SwiftUI
import UIKit

/// Live AVCaptureSession preview that fires `onScanned` exactly once when a
/// QR code containing a valid `droplet://pair?…` URI is decoded.
struct ScanView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @StateObject private var permission = CameraPermission()

    var body: some View {
        ZStack {
            switch permission.state {
            case .unknown:
                ProgressView().onAppear { permission.request() }
            case .granted:
                CameraScanner { raw in
                    coordinator.handleScanResult(raw)
                }
                .ignoresSafeArea()
                .overlay(alignment: .center) {
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(.white.opacity(0.65), lineWidth: 2)
                        .frame(width: 260, height: 260)
                }
                .overlay(alignment: .bottom) {
                    VStack(spacing: 12) {
                        Text("Point at the pair QR on your Droplet dashboard")
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                        Button("Cancel") {
                            coordinator.cancel()
                        }
                        .tint(.white)
                    }
                    .padding(.bottom, 32)
                }
            case .denied:
                VStack(spacing: 12) {
                    Text("Camera access").font(.title2.weight(.semibold))
                    Text("Droplet still needs camera access to read the pair QR. Open Settings to grant access.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Cancel") { coordinator.cancel() }
                }
                .padding(.horizontal, 24)
            }
        }
    }
}

@MainActor
private final class CameraPermission: ObservableObject {
    enum State { case unknown, granted, denied }
    @Published var state: State = .unknown

    func request() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            state = .granted
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { self.state = granted ? .granted : .denied }
            }
        default:
            state = .denied
        }
    }
}

/// SwiftUI bridge to a UIKit AVCapture-backed preview view.
struct CameraScanner: UIViewControllerRepresentable {
    let onScanned: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScanned: onScanned) }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}

    final class Coordinator: NSObject, ScannerViewControllerDelegate {
        let onScanned: (String) -> Void
        private var hasFired = false

        init(onScanned: @escaping (String) -> Void) {
            self.onScanned = onScanned
        }

        func scanner(_ controller: ScannerViewController, didRead value: String) {
            guard !hasFired else { return }
            hasFired = true
            onScanned(value)
        }
    }
}

protocol ScannerViewControllerDelegate: AnyObject {
    func scanner(_ controller: ScannerViewController, didRead value: String)
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    weak var delegate: ScannerViewControllerDelegate?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        if session.canAddInput(input) { session.addInput(input) }

        let metadata = AVCaptureMetadataOutput()
        if session.canAddOutput(metadata) { session.addOutput(metadata) }
        metadata.setMetadataObjectsDelegate(self, queue: .main)
        metadata.metadataObjectTypes = [.qr]

        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.frame = view.layer.bounds
        view.layer.addSublayer(previewLayer)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task.detached(priority: .userInitiated) { [session] in
            if !session.isRunning { session.startRunning() }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let read = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let value = read.stringValue else { return }
        delegate?.scanner(self, didRead: value)
    }
}
