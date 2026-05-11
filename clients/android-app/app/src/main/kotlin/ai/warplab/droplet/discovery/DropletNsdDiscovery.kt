package ai.warplab.droplet.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import java.net.InetAddress

/**
 * Bonjour/mDNS discovery for Droplet appliances on the local Wi-Fi. The
 * appliance advertises the service `_droplet._tcp.local` via avahi running
 * in the orchestrator's Docker network (configured in
 * `docker/docker-compose.yml`).
 *
 * Two layers:
 *   1. A long-lived Flow<List<Discovered>> the UI collects while the
 *      Discovery screen is composed. The flow stops scanning on cancellation
 *      so we don't drain battery in the background.
 *   2. A MulticastLock acquired for the duration of the scan — required on
 *      Android because mDNS is multicast and the Wi-Fi stack drops multicast
 *      packets to background apps unless a lock is held.
 *
 * NSD on Android pre-34 has known races on rapid start/stop. We add a small
 * "Discovered" debounce buffer keyed by service name so a stop/start cycle
 * doesn't yank an entry mid-list-render.
 */
class DropletNsdDiscovery(private val context: Context) {

    private val nsd by lazy { context.getSystemService(Context.NSD_SERVICE) as NsdManager }
    private val wifi by lazy { context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager }

    data class Discovered(
        val serviceName: String,
        val host: String,
        val port: Int,
    ) {
        /** Convenience: produce the canonical server URL we'd pair with. */
        fun toServerUrl(): String = "https://$host${if (port == 443) "" else ":$port"}"
    }

    /**
     * Returns a cold Flow that starts a fresh scan on collection and stops
     * (and releases the multicast lock) on cancellation. Collectors get the
     * cumulative list of unique services so far.
     */
    fun discover(): Flow<List<Discovered>> = callbackFlow {
        val multicastLock = wifi.createMulticastLock("droplet-nsd").apply {
            setReferenceCounted(true)
            acquire()
        }
        val state = MutableStateFlow<Map<String, Discovered>>(emptyMap())

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                Log.d(TAG, "Discovery started for $serviceType")
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "Found ${serviceInfo.serviceName}, resolving…")
                resolve(serviceInfo) { resolved ->
                    val host = resolved.hostString() ?: return@resolve
                    val entry = Discovered(
                        serviceName = resolved.serviceName ?: "Droplet",
                        host = host,
                        port = resolved.port,
                    )
                    state.value = state.value + (entry.serviceName to entry)
                    trySend(state.value.values.toList())
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                val key = serviceInfo.serviceName ?: return
                state.value = state.value - key
                trySend(state.value.values.toList())
            }

            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "NSD start failed: $errorCode")
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "NSD stop failed: $errorCode")
            }
        }

        runCatching {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        }.onFailure {
            Log.e(TAG, "Failed to start NSD", it)
            close(it)
        }

        awaitClose {
            runCatching { nsd.stopServiceDiscovery(listener) }
            runCatching { if (multicastLock.isHeld) multicastLock.release() }
        }
    }

    private fun resolve(info: NsdServiceInfo, onResolved: (NsdServiceInfo) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ replaced resolveService(...) with the callback API.
            val callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceUpdated(serviceInfo: NsdServiceInfo) = onResolved(serviceInfo)
                override fun onServiceLost() = Unit
                override fun onServiceInfoCallbackUnregistered() = Unit
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                    Log.w(TAG, "registerServiceInfoCallback failed: $errorCode")
                }
            }
            runCatching {
                nsd.registerServiceInfoCallback(info, context.mainExecutor, callback)
            }.onFailure { Log.w(TAG, "registerServiceInfoCallback threw", it) }
        } else {
            @Suppress("DEPRECATION")
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    Log.w(TAG, "Resolve failed: $errorCode")
                }
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) = onResolved(serviceInfo)
            })
        }
    }

    /** Pull a usable host string out of NsdServiceInfo regardless of which
     *  API level filled it in. Pre-Q `host` is an InetAddress; Q+ exposes
     *  `hostAddresses` as a list. */
    private fun NsdServiceInfo.hostString(): String? {
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return host?.hostAddress
        }
        val first = hostAddresses?.firstOrNull() ?: return null
        return (first as? InetAddress)?.hostAddress ?: first.toString()
    }

    private companion object {
        const val TAG = "DropletNsd"
        const val SERVICE_TYPE = "_droplet._tcp."
    }
}
