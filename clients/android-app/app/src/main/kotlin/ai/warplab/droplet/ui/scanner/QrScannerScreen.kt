package ai.warplab.droplet.ui.scanner

import android.Manifest
import android.net.Uri
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import ai.warplab.droplet.R
import ai.warplab.droplet.data.PairedServer
import ai.warplab.droplet.data.ServerRepository
import ai.warplab.droplet.pair.PairUrl
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import java.util.concurrent.Executors

/**
 * Live camera QR scanner gated behind a runtime CAMERA permission prompt.
 *
 * Pipeline:
 *   CameraX PreviewView ──► ImageAnalysis (YUV_420_888, latest-frame)
 *                                ▼
 *                       ML Kit Barcode Scanner
 *                                ▼
 *                       PairUrl.parse(...) ──► persist + onPaired()
 *
 * We DON'T accept arbitrary QR contents — only those that parse as
 * `droplet://pair?...`. A foreign QR (Wi-Fi creds, contact card, etc.) is
 * silently ignored, and we keep scanning. This keeps the UX "show camera,
 * point, done" with no error popups for benign mis-reads.
 *
 * onFallback bridges to manual URL entry if the user denies camera access.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalPermissionsApi::class)
@Composable
fun QrScannerScreen(
    serverRepository: ServerRepository,
    onPaired: () -> Unit,
    onFallback: () -> Unit,
    onBack: () -> Unit,
) {
    val cameraPermission = rememberPermissionState(Manifest.permission.CAMERA)
    LaunchedEffect(Unit) {
        if (!cameraPermission.status.isGranted) cameraPermission.launchPermissionRequest()
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(stringResource(R.string.qr_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = null)
                    }
                },
            )
        }
    ) { padding ->
        if (cameraPermission.status.isGranted) {
            CameraPreview(
                padding = padding,
                serverRepository = serverRepository,
                onPaired = onPaired,
            )
        } else {
            PermissionDenied(
                padding = padding,
                onGrant = { cameraPermission.launchPermissionRequest() },
                onFallback = onFallback,
            )
        }
    }
}

@OptIn(ExperimentalGetImage::class)
@Composable
private fun CameraPreview(
    padding: PaddingValues,
    serverRepository: ServerRepository,
    onPaired: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    var paired by remember { mutableStateOf(false) }
    // Single-shot executor for ML Kit — kept off the main thread; cancelled
    // when this composable leaves the composition so we don't leak the
    // executor across rotations.
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) {
        onDispose { analysisExecutor.shutdown() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding),
        contentAlignment = Alignment.BottomCenter,
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx).apply {
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }

                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(analysisExecutor) { proxy ->
                        if (paired) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        processForBarcode(proxy) { pair ->
                            if (!paired) {
                                paired = true
                                val host = Uri.parse(pair.server).host ?: pair.server
                                val now = System.currentTimeMillis()
                                scope.launch {
                                    serverRepository.upsert(
                                        PairedServer(
                                            url = pair.server,
                                            displayName = host,
                                            pairedAt = now,
                                            lastSeenAt = now,
                                        )
                                    )
                                    onPaired()
                                }
                            }
                        }
                    }

                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    }.onFailure { Log.e(TAG, "CameraX bind failed", it) }
                }, ContextCompat.getMainExecutor(ctx))

                previewView
            },
        )
        Text(
            text = stringResource(R.string.qr_hint),
            color = MaterialTheme.colorScheme.onPrimary,
            modifier = Modifier
                .padding(24.dp),
        )
    }
}

@OptIn(ExperimentalGetImage::class)
private fun processForBarcode(proxy: ImageProxy, onPair: (PairUrl) -> Unit) {
    val mediaImage = proxy.image
    if (mediaImage == null) {
        proxy.close()
        return
    }
    val image = InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees)
    val scanner = BarcodeScanning.getClient()
    scanner.process(image)
        .addOnSuccessListener { barcodes ->
            for (b in barcodes) {
                if (b.format != Barcode.FORMAT_QR_CODE) continue
                val raw = b.rawValue ?: continue
                val pair = PairUrl.parse(raw) ?: continue
                onPair(pair)
                break
            }
        }
        .addOnFailureListener { Log.w(TAG, "ML Kit barcode failed", it) }
        .addOnCompleteListener { proxy.close() }
}

@Composable
private fun PermissionDenied(
    padding: PaddingValues,
    onGrant: () -> Unit,
    onFallback: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.qr_perm_denied_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = stringResource(R.string.qr_perm_denied_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Spacer(Modifier.fillMaxWidth())
        Button(onClick = onGrant, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.qr_perm_grant))
        }
        OutlinedButton(onClick = onFallback, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.qr_perm_manual))
        }
    }
}

private const val TAG = "DropletQrScanner"
