package ai.warplab.droplet

import android.app.Application
import ai.warplab.droplet.data.ServerRepository
import ai.warplab.droplet.discovery.DropletNsdDiscovery

/**
 * Process-scoped singletons. We don't pull in Hilt because the dependency
 * graph for a shell app is six objects deep — manual wiring is shorter and
 * easier to read than @InstallIn modules.
 */
class DropletApp : Application() {

    /** Persisted list of paired Droplets + active pointer. */
    lateinit var serverRepository: ServerRepository
        private set

    /** Lazy NSD scanner; instances bind to the system NsdManager only while
     *  the discovery screen is composed. See DropletNsdDiscovery for the
     *  lifecycle contract. */
    lateinit var nsdDiscovery: DropletNsdDiscovery
        private set

    override fun onCreate() {
        super.onCreate()
        serverRepository = ServerRepository(applicationContext)
        nsdDiscovery = DropletNsdDiscovery(applicationContext)
    }
}
