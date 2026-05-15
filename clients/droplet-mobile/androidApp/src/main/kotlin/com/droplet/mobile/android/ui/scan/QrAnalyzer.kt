package com.droplet.mobile.android.ui.scan

import androidx.annotation.OptIn as AndroidXOptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.droplet.mobile.DropletPairUri
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/**
 * ImageAnalysis.Analyzer that hands each frame to ML Kit's barcode scanner.
 *
 * The scanner is configured to only emit QR codes. On a match, we extract
 * the raw value, attempt to parse it as a droplet:// pair URI, and call
 * [onMatch] exactly once — subsequent frames are ignored.
 *
 * Callers must close the analyzer when leaving the screen so the underlying
 * detector releases its native resources.
 */
class QrAnalyzer(
    private val onMatch: (DropletPairUri) -> Unit,
) : ImageAnalysis.Analyzer {

    private val scanner = BarcodeScanning.getClient(
        com.google.mlkit.vision.barcode.BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
    )

    @Volatile
    private var matched = false

    @AndroidXOptIn(ExperimentalGetImage::class)
    override fun analyze(imageProxy: ImageProxy) {
        if (matched) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }
        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                if (matched) return@addOnSuccessListener
                for (barcode in barcodes) {
                    val raw = barcode.rawValue ?: continue
                    val pair = DropletPairUri.parseOrNull(raw) ?: continue
                    matched = true
                    onMatch(pair)
                    return@addOnSuccessListener
                }
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    fun close() {
        scanner.close()
    }
}
