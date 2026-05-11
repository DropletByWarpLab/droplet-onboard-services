package ai.warplab.droplet.ui.dashboard

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import ai.warplab.droplet.R
import ai.warplab.droplet.data.ServerRepository

/**
 * Dashboard host. Renders the appliance's Next.js dashboard inside a WebView
 * with a thin Compose chrome (progress bar + switcher button).
 *
 * Why a WebView and not a native port?
 *   • 30 dashboard pages (calendar, cameras with [name]+recordings, chat,
 *     clips, devices, events, files w/ sub-routes, login, network, etc.) —
 *     porting natively is months of duplicate work that drifts the moment
 *     the dashboard ships a new page.
 *   • Frigate HLS streams + qrcode + react-markdown + SWR — all work
 *     unchanged in modern Android WebView (which is just Chromium).
 *   • Single source of truth: the appliance ships dashboard updates, the
 *     app immediately reflects them — no Play Store release needed for
 *     dashboard changes.
 *
 * The Compose chrome handles:
 *   • Loading progress (LinearProgressIndicator at top)
 *   • Server switcher entry point (icon in top-right when the WebView is at
 *     the dashboard root — hidden inside deep links to keep chrome out of
 *     the way)
 *   • Hardware back: routes to WebView's history first, falls through to
 *     activity finish
 *   • Connection-failed empty state (e.g. appliance off the network) with
 *     Retry + Switch Droplet actions
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardWebViewScreen(
    serverRepository: ServerRepository,
    onOpenSwitcher: () -> Unit,
) {
    val context = LocalContext.current
    val activeUrl by serverRepository.activeServerUrl.collectAsState(initial = null)

    var webView by remember { mutableStateOf<WebView?>(null) }
    var loadProgress by remember { mutableStateOf(0) }
    var loadError by remember { mutableStateOf<String?>(null) }

    // Touch lastSeenAt on every successful navigation — keeps the switcher
    // sorted by recency.
    LaunchedEffect(activeUrl) {
        activeUrl?.let { url -> serverRepository.touchLastSeen(url) }
    }

    BackHandler(enabled = webView?.canGoBack() == true) {
        webView?.goBack()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Droplet") },
                actions = {
                    IconButton(onClick = onOpenSwitcher) {
                        Icon(
                            Icons.Outlined.SwapHoriz,
                            contentDescription = stringResource(R.string.switcher_title),
                        )
                    }
                },
                // Skinny bar so the dashboard owns most of the screen
                colors = androidx.compose.material3.TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                )
            )
        }
    ) { padding ->
        Box(modifier = Modifier
            .fillMaxSize()
            .padding(padding)) {
            val url = activeUrl
            if (url == null) {
                // Shouldn't reach here in normal flow (nav guards), but be
                // defensive — repository could be empty if user just forgot
                // their last server while this screen was composed.
                ConnectionError(
                    PaddingValues(0.dp),
                    host = "",
                    onRetry = {},
                    onSwitch = onOpenSwitcher,
                )
                return@Scaffold
            }

            if (loadError != null) {
                ConnectionError(
                    PaddingValues(0.dp),
                    host = Uri.parse(url).host ?: url,
                    onRetry = {
                        loadError = null
                        webView?.reload()
                    },
                    onSwitch = onOpenSwitcher,
                )
            } else {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        buildWebView(ctx) { progress, error ->
                            loadProgress = progress
                            loadError = error
                        }.also { webView = it }
                    },
                    update = { wv ->
                        // Re-navigate only when the active URL actually changed.
                        if (wv.url?.startsWith(url) != true) {
                            wv.loadUrl(url)
                        }
                    },
                )
                if (loadProgress in 1..99) {
                    LinearProgressIndicator(
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun buildWebView(
    context: android.content.Context,
    onState: (progress: Int, error: String?) -> Unit,
): WebView {
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)

    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )

        settings.apply {
            javaScriptEnabled = true                       // dashboard is Next.js
            domStorageEnabled = true                       // SWR cache, theme prefs
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false       // HLS auto-plays Frigate clips
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false                        // never let dashboard read app files
            allowContentAccess = false
            // Honour the system dark-mode flag so the dashboard's
            // `prefers-color-scheme` media query lines up with the app chrome.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(this, true)
            }
            userAgentString = "$userAgentString DropletAndroid/${ai.warplab.droplet.BuildConfig.VERSION_NAME}"
        }
        cm.setAcceptThirdPartyCookies(this, false)         // single-origin dashboard, no 3p cookies expected

        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                onState(newProgress, null)
            }
        }
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                onState(0, null)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url
                // Keep dashboard navigation inside the WebView; route anything
                // else (mailto:, tel:, external https that didn't originate
                // from the appliance host) out to the OS.
                val host = url.host ?: return false
                val originHost = Uri.parse(view.url).host
                if (host == originHost) return false
                view.context.startActivity(
                    Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                // Only surface errors for the main frame — sub-resources
                // failing (fonts, missing icons) shouldn't replace the
                // whole dashboard with an error.
                if (request?.isForMainFrame != true) return
                Log.w("DropletWebView", "Main frame error: ${error?.description}")
                onState(0, error?.description?.toString() ?: "Unknown error")
            }
        }
    }
}

@Composable
private fun ConnectionError(
    padding: PaddingValues,
    host: String,
    onRetry: () -> Unit,
    onSwitch: () -> Unit,
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
            text = stringResource(R.string.webview_offline_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = stringResource(R.string.webview_offline_body, host),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Spacer(Modifier.size(8.dp))
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.webview_retry))
        }
        OutlinedButton(onClick = onSwitch, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.webview_switch))
        }
    }
}
