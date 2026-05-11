package ai.warplab.droplet.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LightColors = lightColorScheme(
    primary = DropletPrimary,
    onPrimary = DropletOnPrimary,
    primaryContainer = DropletPrimaryDark,
    surface = DropletSurfaceLight,
    onSurface = DropletOnSurfaceLight,
    error = DropletError,
)

private val DarkColors = darkColorScheme(
    primary = DropletPrimary,
    onPrimary = DropletOnPrimary,
    primaryContainer = DropletPrimaryDark,
    surface = DropletSurfaceDark,
    onSurface = DropletOnSurfaceDark,
    outline = DropletOutline,
    error = DropletError,
)

/**
 * App theme. Honors system dark mode; on Android 12+ also opts into Material You
 * dynamic colour for users who want the device's accent — but only for the
 * **container** colours. Primary stays Droplet blue so the brand reads through
 * even when the system pulls a green-of-the-month wallpaper.
 */
@Composable
fun DropletTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val dynamic = if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            // Keep brand primary even with dynamic colour active.
            dynamic.copy(primary = DropletPrimary, onPrimary = DropletOnPrimary)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.surface.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = DropletTypography,
        content = content,
    )
}
