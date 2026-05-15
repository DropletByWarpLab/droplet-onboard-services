package com.droplet.mobile.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.droplet.mobile.CredentialStore
import com.droplet.mobile.DropletPairUri
import com.droplet.mobile.android.ui.files.FilesScreen
import com.droplet.mobile.android.ui.home.HomeScreen
import com.droplet.mobile.android.ui.pairflow.PairFlowScreen
import com.droplet.mobile.android.ui.scan.ScanScreen
import com.droplet.mobile.android.ui.upload.UploadScreen
import com.droplet.mobile.android.ui.welcome.WelcomeScreen
import org.koin.androidx.compose.koinViewModel
import org.koin.compose.koinInject
import org.koin.core.parameter.parametersOf
import java.net.URLDecoder
import java.net.URLEncoder

@Composable
fun DropletApp(
    incomingPairUri: DropletPairUri?,
    onDeepLinkConsumed: () -> Unit,
) {
    val navController = rememberNavController()
    val credentialStore = koinInject<CredentialStore>()
    val existingSession = remember { credentialStore.load() }

    val startDestination = when {
        incomingPairUri != null -> Routes.pairFlowRoute(incomingPairUri.server, incomingPairUri.code)
        existingSession != null -> Routes.Home
        else -> Routes.Welcome
    }

    LaunchedEffect(incomingPairUri) {
        if (incomingPairUri != null) onDeepLinkConsumed()
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.Welcome) {
            WelcomeScreen(onStartPair = { navController.navigate(Routes.Scan) })
        }

        composable(Routes.Scan) {
            ScanScreen(
                onScanned = { pairUri ->
                    navController.navigate(Routes.pairFlowRoute(pairUri.server, pairUri.code)) {
                        popUpTo(Routes.Scan) { inclusive = true }
                    }
                },
                onCancel = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.PairFlowPattern,
            arguments = listOf(
                navArgument(Routes.Arg.Server) { type = NavType.StringType },
                navArgument(Routes.Arg.Code) { type = NavType.StringType },
            ),
        ) { backStackEntry ->
            val server = backStackEntry.arguments?.getString(Routes.Arg.Server)?.let(Routes::decode).orEmpty()
            val code = backStackEntry.arguments?.getString(Routes.Arg.Code)?.let(Routes::decode).orEmpty()
            PairFlowScreen(
                serverUrl = server,
                code = code,
                viewModel = koinViewModel { parametersOf(server) },
                onPaired = {
                    navController.navigate(Routes.Home) {
                        popUpTo(Routes.Welcome) { inclusive = true }
                    }
                },
                onCancel = { navController.popBackStack() },
            )
        }

        composable(Routes.Home) {
            HomeScreen(
                onBrowseFiles = { navController.navigate(Routes.Files) },
                onUploadPhotos = { navController.navigate(Routes.Upload) },
                onUnpair = {
                    navController.navigate(Routes.Welcome) {
                        popUpTo(Routes.Home) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.Files) {
            FilesScreen(onClose = { navController.popBackStack() })
        }

        composable(Routes.Upload) {
            UploadScreen(onClose = { navController.popBackStack() })
        }
    }
}

internal object Routes {
    const val Welcome = "welcome"
    const val Scan = "scan"
    const val PairFlowPattern = "pair/{server}/{code}"
    const val Home = "home"
    const val Files = "files"
    const val Upload = "upload"

    object Arg {
        const val Server = "server"
        const val Code = "code"
    }

    fun pairFlowRoute(server: String, code: String): String =
        "pair/${encode(server)}/${encode(code)}"

    fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8)
    fun decode(value: String): String = URLDecoder.decode(value, Charsets.UTF_8)
}
