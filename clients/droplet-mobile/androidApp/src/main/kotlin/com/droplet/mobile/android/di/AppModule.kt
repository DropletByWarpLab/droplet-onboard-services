package com.droplet.mobile.android.di

import com.droplet.mobile.CredentialStore
import com.droplet.mobile.DeviceInfo
import com.droplet.mobile.DropletApiClient
import com.droplet.mobile.PairingRepository
import com.droplet.mobile.android.BuildConfig
import com.droplet.mobile.android.ui.files.FilesViewModel
import com.droplet.mobile.android.ui.home.HomeViewModel
import com.droplet.mobile.android.ui.pairflow.PairFlowViewModel
import com.droplet.mobile.android.ui.upload.UploadViewModel
import com.droplet.mobile.createPlatformHttpClient
import com.droplet.mobile.files.FilesRepository
import org.koin.android.ext.koin.androidContext
import org.koin.androidx.viewmodel.dsl.viewModel
import org.koin.core.parameter.parametersOf
import org.koin.dsl.module

val appModule = module {
    // ── Singletons ──
    single { CredentialStore(androidContext()) }
    single {
        DeviceInfo(
            ownerName = null,
            appVersion = BuildConfig.VERSION_NAME,
        )
    }

    // ── Pair-flow scoped: a fresh repository per scanned server ──
    factory { (serverUrl: String) ->
        val allowSelfSigned: Set<String> = if (BuildConfig.ALLOW_SELF_SIGNED) {
            hostnameOf(serverUrl)?.let { setOf(it) }.orEmpty()
        } else emptySet()
        val rawClient = createPlatformHttpClient(allowSelfSignedHosts = allowSelfSigned)
        val api = DropletApiClient(baseUrl = serverUrl, rawClient = rawClient)
        PairingRepository(
            api = api,
            credentialStore = get(),
            deviceInfo = get(),
            serverUrl = serverUrl,
        )
    }

    // ── Files/Upload: each entry of those screens gets a fresh
    //    FilesRepository bound to the currently-paired Droplet.
    //    Re-pairing → re-enter the screen → fresh client with the new
    //    server's TLS allow-list. ──
    factory<FilesRepository> {
        val credentialStore = get<CredentialStore>()
        val session = credentialStore.load()
        val host = session?.serverUrl?.let { hostnameOf(it) }
        val allowSelfSigned: Set<String> = if (BuildConfig.ALLOW_SELF_SIGNED && host != null) {
            setOf(host)
        } else emptySet()
        val httpClient = createPlatformHttpClient(allowSelfSignedHosts = allowSelfSigned)
        FilesRepository(credentialStore = credentialStore, httpClient = httpClient)
    }

    // ── View-models ──
    viewModel { (serverUrl: String) ->
        PairFlowViewModel(repository = get { parametersOf(serverUrl) })
    }
    viewModel { HomeViewModel(credentialStore = get()) }
    viewModel { FilesViewModel(repository = get()) }
    viewModel { UploadViewModel(repository = get()) }
}

private fun hostnameOf(url: String): String? = runCatching {
    val withoutScheme = url.substringAfter("://", missingDelimiterValue = "")
    if (withoutScheme.isEmpty()) return@runCatching null
    val hostPort = withoutScheme.substringBefore('/').substringBefore('?')
    val host = hostPort.substringBefore(':')
    host.ifBlank { null }
}.getOrNull()
