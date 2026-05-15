package com.droplet.mobile.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = DropletBlue,
    onPrimary = Color.White,
    secondary = DropletDeep,
    onSecondary = Color.White,
    background = DropletSurface,
    onBackground = DropletDeep,
    surface = Color.White,
    onSurface = DropletDeep,
    surfaceVariant = DropletMist,
    onSurfaceVariant = DropletDeep,
    error = DropletError,
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = DropletBlue,
    onPrimary = Color.White,
    secondary = DropletMist,
    onSecondary = DropletDeep,
    background = DropletDeep,
    onBackground = DropletMist,
    surface = DropletSurfaceDark,
    onSurface = DropletMist,
    surfaceVariant = DropletDeep,
    onSurfaceVariant = DropletMist,
    error = DropletError,
    onError = Color.White,
)

@Composable
fun DropletTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = DropletTypography,
        content = content,
    )
}
