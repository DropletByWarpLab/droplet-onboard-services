package ai.warplab.droplet.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import ai.warplab.droplet.data.ServerRepository
import ai.warplab.droplet.discovery.DropletNsdDiscovery
import ai.warplab.droplet.pair.PairUrl
import ai.warplab.droplet.ui.dashboard.DashboardWebViewScreen
import ai.warplab.droplet.ui.onboarding.ManualUrlScreen
import ai.warplab.droplet.ui.onboarding.OnboardingScreen
import ai.warplab.droplet.ui.scanner.QrScannerScreen
import ai.warplab.droplet.ui.servers.DiscoveryScreen
import ai.warplab.droplet.ui.servers.ServerSwitcherScreen
import ai.warplab.droplet.ui.pair.PairHandoffScreen

/**
 * All app routes. Encoded as a sealed hierarchy + `path` strings (rather than
 * type-safe nav-compose 2.8+ routes) because the WebView destination needs to
 * accept an arbitrary URL argument and the URL-safe encoding is easier as a
 * plain string than a serialiser. Cost: type safety at call sites. Worth it
 * for now; if route count grows past ~10 we'll migrate.
 */
sealed class DropletRoute(val path: String) {
    /** Resolves on entry to either Onboarding or Dashboard based on whether
     *  any paired servers exist. Implemented as a sentinel route so the
     *  decision happens inside the NavHost composition rather than in
     *  MainActivity (which doesn't have the repository Flow). */
    data object Bootstrap : DropletRoute("bootstrap")
    data object Onboarding : DropletRoute("onboarding")
    data object Manual : DropletRoute("onboarding/manual")
    data object Scanner : DropletRoute("onboarding/scan")
    data object Discovery : DropletRoute("onboarding/discover")
    data object Dashboard : DropletRoute("dashboard")
    data object Switcher : DropletRoute("switcher")
    /** Terminal screen for a freshly-arrived `droplet://pair?...` deep link.
     *  Pairs and then jumps to Dashboard. */
    data object PairHandoff : DropletRoute("pair/handoff")
}

@Composable
fun DropletNavHost(
    navController: NavHostController,
    startDestination: String,
    serverRepository: ServerRepository,
    nsdDiscovery: DropletNsdDiscovery,
    pendingDeepLink: PairUrl?,
    onDeepLinkConsumed: () -> Unit,
) {
    NavHost(navController = navController, startDestination = startDestination) {

        composable(DropletRoute.Bootstrap.path) {
            val servers by serverRepository.servers.collectAsState(initial = null)
            LaunchedEffect(servers) {
                if (servers == null) return@LaunchedEffect  // still loading
                val target = if (servers!!.isEmpty()) DropletRoute.Onboarding else DropletRoute.Dashboard
                navController.navigate(target.path) {
                    popUpTo(DropletRoute.Bootstrap.path) { inclusive = true }
                }
            }
        }

        composable(DropletRoute.Onboarding.path) {
            OnboardingScreen(
                onScan = { navController.navigate(DropletRoute.Scanner.path) },
                onDiscover = { navController.navigate(DropletRoute.Discovery.path) },
                onManual = { navController.navigate(DropletRoute.Manual.path) },
            )
        }

        composable(DropletRoute.Manual.path) {
            ManualUrlScreen(
                serverRepository = serverRepository,
                onPaired = { navController.navigateToDashboard() },
                onBack = { navController.popBackStack() },
            )
        }

        composable(DropletRoute.Scanner.path) {
            QrScannerScreen(
                serverRepository = serverRepository,
                onPaired = { navController.navigateToDashboard() },
                onFallback = { navController.navigate(DropletRoute.Manual.path) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(DropletRoute.Discovery.path) {
            DiscoveryScreen(
                discovery = nsdDiscovery,
                serverRepository = serverRepository,
                onPicked = { navController.navigateToDashboard() },
                onBack = { navController.popBackStack() },
            )
        }

        composable(DropletRoute.Dashboard.path) {
            DashboardWebViewScreen(
                serverRepository = serverRepository,
                onOpenSwitcher = { navController.navigate(DropletRoute.Switcher.path) },
            )
        }

        composable(DropletRoute.Switcher.path) {
            ServerSwitcherScreen(
                serverRepository = serverRepository,
                onAdd = { navController.navigate(DropletRoute.Onboarding.path) },
                onPicked = {
                    navController.popBackStack(DropletRoute.Dashboard.path, inclusive = false)
                },
                onBack = { navController.popBackStack() },
            )
        }

        composable(DropletRoute.PairHandoff.path) {
            PairHandoffScreen(
                pairUrl = pendingDeepLink,
                serverRepository = serverRepository,
                onDone = {
                    onDeepLinkConsumed()
                    navController.navigateToDashboard()
                },
                onFailed = {
                    onDeepLinkConsumed()
                    navController.navigate(DropletRoute.Onboarding.path) {
                        popUpTo(0)
                    }
                },
            )
        }
    }
}

private fun NavHostController.navigateToDashboard() {
    navigate(DropletRoute.Dashboard.path) {
        popUpTo(0)  // wipe the back stack — onboarding/scanner aren't worth returning to
    }
}
