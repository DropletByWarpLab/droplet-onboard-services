package ai.warplab.droplet.push

import android.util.Log

/**
 * FCM push handler — **scaffold only, currently disabled**.
 *
 * Why disabled by default:
 *   • FCM requires shipping `google-services.json` per Firebase project. We
 *     don't want every developer who clones this repo to need a Firebase
 *     account just to build the APK.
 *   • The orchestrator's `/notifications` route currently uses Web Push
 *     (VAPID) for the dashboard. Mobile push will be a follow-on once we
 *     wire the FCM topic <-> device registration on the orchestrator side.
 *
 * To enable:
 *   1. Uncomment `alias(libs.plugins.google.services)` in app/build.gradle.kts
 *   2. Uncomment the firebase deps in the same file
 *   3. Uncomment the <service> block in AndroidManifest.xml
 *   4. Drop `google-services.json` into `app/`
 *   5. Change this class to `: FirebaseMessagingService()` and override the
 *      lifecycle methods (currently commented out below)
 *   6. Implement registration → POST to `/api/devices/clients/{id}/push-token`
 *      (route to be added on the orchestrator)
 *
 * Until then this is a placeholder so the manifest + AGP plugin block compile
 * without referencing classes that won't be on the classpath.
 */
class DropletFcmService /* : FirebaseMessagingService() */ {
    // override fun onNewToken(token: String) {
    //     Log.d(TAG, "FCM token refreshed; would POST to orchestrator")
    //     // TODO: scope.launch { orchestratorClient.registerPushToken(token) }
    // }
    //
    // override fun onMessageReceived(message: RemoteMessage) {
    //     // Topic shape (proposed):
    //     //   data: {
    //     //     kind: "camera.detection" | "device.offline" | "chat.message",
    //     //     deepLink: "https://<server>/cameras/<name>"
    //     //   }
    //     // Map to a system notification with the deep link as content intent.
    // }

    private companion object {
        const val TAG = "DropletFcm"
    }
}
