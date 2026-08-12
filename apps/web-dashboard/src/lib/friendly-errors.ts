/**
 * Typed-error → friendly-copy translator (WARP-294).
 *
 * Single source of truth for converting an unknown error (anything
 * thrown by a fetch wrapper, a streaming reader, a hls.js callback,
 * etc.) into copy a non-engineering home user can actually act on.
 *
 * Design rules:
 *   - **Never** return `err.message` verbatim. Even friendly-looking
 *     orchestrator strings ("OCS 401", "ECONNREFUSED", "VAPID not
 *     configured") can leak terminology that doesn't belong on a
 *     home user's screen.
 *   - Each domain has a per-code mapping table plus a **fixed-string
 *     fallback**. Unknown codes get the fallback — they do NOT get
 *     the raw message.
 *   - Domains are intentionally narrow ("auth", "provider-key",
 *     "media", …) so the same translator can ship different copy for
 *     a 401 from `/login` vs a 401 from `/calendar/sources`.
 *   - The raw error is `console.error`'d so operators / QA still see
 *     the underlying cause in DevTools — only the user-facing string
 *     gets sanitised.
 *
 * Patterns this generalises:
 *   - `apps/web-dashboard/src/lib/hooks/useChat.ts` —
 *     `friendlyErrorMessage`
 *   - `apps/web-dashboard/src/app/invite/[token]/page.tsx` —
 *     `err.code`-driven dispatch with a fixed fallback
 */

export type FriendlyError = {
  code?: string;
  status?: number;
  message?: string;
};

export type ErrorDomain =
  | "auth"
  | "files"
  | "share"
  // WARP-1659 — the multi-select share fan-out. Same wire calls as "share",
  // but the surface has no password field and no expiry picker, so the two
  // inferences that name those controls must not speak for it.
  | "share-bulk"
  | "chat"
  | "invite"
  | "calendar"
  | "subscription"
  | "provider-key"
  | "push"
  | "knowledge"
  | "media"
  | "network"
  | "vpn"
  | "camera"
  | "projects"
  | "device"
  | "storage"
  | "pairing"
  // Home's notes tile. Notes moved off browser localStorage onto the box, so a
  // failed READ is the only thing between the customer and text they wrote —
  // the copy has to name notes, or an outage is indistinguishable from an
  // empty account.
  | "notes"
  | "generic";

/** Domain-fallback copy. NEVER `err.message`. */
const FALLBACK: Record<ErrorDomain, string> = {
  auth: "We couldn't sign you in. Check your username and password, then try again.",
  files: "We couldn't load those files right now. Try again in a moment.",
  share:
    "We couldn't create that share link right now. Try again in a moment.",
  // Per ROW of a bulk run, so the singular "that share link" still reads
  // correctly — deliberately the same sentence as `share`, because an unknown
  // failure is not something the fan-out is any more responsible for than the
  // dialog is.
  "share-bulk":
    "We couldn't create that share link right now. Try again in a moment.",
  chat:
    "Something went wrong on this turn. Try again, or simplify the request.",
  invite:
    "We couldn't accept that invite. Please ask the admin who invited you for a fresh link.",
  calendar:
    "We couldn't update that reminder right now. Try again in a moment.",
  subscription:
    "We couldn't reach that calendar subscription right now. Try again in a moment.",
  "provider-key":
    "We couldn't save that API key right now. Try again in a moment.",
  push:
    "We couldn't update push notifications right now. Try again in a moment.",
  knowledge:
    "We couldn't load your recently indexed files right now. Try again in a moment.",
  media:
    "We couldn't play that recording. Try a different segment, or reload the page.",
  network:
    "We couldn't update your network settings right now. Try again in a moment.",
  vpn:
    "We couldn't update remote access right now. Try again in a moment.",
  camera:
    "We couldn't add that camera right now. Check it's powered on and connected, then try again.",
  device:
    "We couldn't reach that device right now. Check it's powered on and nearby, then try again.",
  projects:
    "We couldn't save that change right now. Try again in a moment.",
  // WARP-1141 — drive/pool rename + other storage settings writes. The files
  // fallback ("couldn't load those files") misdescribed a failed WRITE as a
  // load hiccup, which is exactly how the Drives-page rename bug went
  // unreported-in-place: the save failed, the name reverted, and the toast
  // talked about loading files.
  storage:
    "We couldn't save that change to your storage. Try again in a moment.",
  // WARP-1150: the Generate-code step of Pair-a-new-device. At this step
  // there is no device to reach yet — the failure is the appliance failing
  // to CREATE a pairing session — so the copy must be create-session +
  // retryable, never the "device" domain's reach-device fallback (that one
  // is reserved for the post-code handshake).
  pairing:
    "The Droplet couldn't create a pairing code right now. Try again in a moment.",
  notes:
    "We couldn't reach your notes. They're safe on your Droplet — try again in a moment.",
  generic:
    "We couldn't reach this Droplet right now. Try again in a moment.",
};

/** Per-domain code → friendly copy. Extend incrementally as needed. */
const CODES: Record<ErrorDomain, Record<string, string>> = {
  auth: {
    INVALID_CREDENTIALS:
      "That username or password didn't match. Try again.",
    "401":
      "That username or password didn't match. Try again.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    WEAK_PASSWORD:
      "That password doesn't meet the requirements. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    INVALID_EMAIL:
      "That email address doesn't look right. Check it and try again.",
    INVALID_REQUEST:
      "Some of those details weren't valid. Check the form and try again.",
    // Two-factor (TOTP) verify / enrollment — codes emitted by
    // apps/orchestrator/src/routes/auth.ts. The plain "auth" fallback
    // talks about username/password, which is wrong for a 2FA code, so
    // map these explicitly.
    TOTP_INVALID:
      "That code didn't match. Check your authenticator app and try again.",
    RECOVERY_INVALID:
      "That recovery code didn't match. Try another one of your saved codes.",
    // PR #375 — the login second-factor gate. The login page normally catches
    // TotpRequiredError and reveals the code field BEFORE reaching the
    // translator, so this is a safety net for any other surface that lets the
    // raw 401 fall through (without it the message-less 401 maps to the
    // misleading "check your password" copy even though the password was right).
    TOTP_REQUIRED:
      "Enter the 6-digit code from your authenticator app to finish signing in.",
    // The brute-force throttle (auth.ts → 429). Repeated wrong passwords OR
    // wrong 2FA codes escalate here; the plain auth fallback ("check your
    // password") is wrong — the credentials may be fine, the account is just
    // temporarily locked.
    TOO_MANY_ATTEMPTS:
      "Too many attempts. Wait a moment, then try again.",
    TOTP_NOT_ENROLLED:
      "Two-factor setup hasn't started yet. Begin again to get a fresh code.",
    TOTP_ALREADY_ENABLED:
      "Two-factor is already turned on for this account.",
    // WARP-824 — self-service / forced password change. The "auth" fallback
    // talks about signing in, which is wrong on the change-password screen, so
    // map the orchestrator's change-password codes explicitly.
    INVALID_PASSWORD:
      "That current password didn't match. Try again.",
    SAME_PASSWORD:
      "Choose a password different from your current one.",
    // WARP-165 — physical-presence claim gate on POST /auth/setup. The "auth"
    // fallback talks about username/password, which is wrong for the claim
    // code, so map these explicitly.
    CLAIM_CODE_REQUIRED:
      "Enter the claim code shown on your device's front panel to finish setup.",
    CLAIM_CODE_INVALID:
      "That claim code doesn't match the one on your device's front panel. Check it and try again.",
    // WARP-989 — POST /auth/setup died mid-provisioning (typed by the
    // orchestrator). The plain auth fallback ("check your username and
    // password") is actively wrong here: the credentials were fine — the box
    // couldn't finish creating the account. It rolled the half-created
    // account back, so retrying is both safe and the right next step.
    SETUP_PROVISIONING_FAILED:
      "The box couldn't finish creating your account — nothing was saved. Try again in a moment.",
    SETUP_FAILED:
      "The box couldn't finish creating your account. Try again in a moment.",
  },
  files: {
    UPLOAD_TOO_LARGE: "That file is too large to upload here.",
    UNSUPPORTED_TYPE: "That file type isn't supported yet.",
    NOT_FOUND: "We couldn't find that file. It may have been moved or deleted.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
  },
  // WARP-1148/1149 — the Share dialog's create / permission-change / revoke
  // paths. These previously went through the "files" domain, so a failed share
  // CREATE rendered the file-LOADING fallback ("We couldn't load those
  // files…") — wrong action, and "try again" is wrong advice for the
  // deterministic Nextcloud policy rejections below. `module_disabled` is the
  // module gate's stable wire code (a sharing surface served by a build with
  // the Files module toggled off must surface honestly, not as a loading
  // error). The *_REJECTED codes are inferred from the OCS message shapes of
  // Nextcloud's share-create checks (password policy, expiration policy,
  // permission rules) in inferCodeFromMessage.
  share: {
    module_disabled:
      "File sharing is turned off on this Droplet. An owner or admin can turn the Files module back on in Settings.",
    PASSWORD_REJECTED:
      "That password doesn't meet this Droplet's rules for share links. Try a longer, less common one.",
    EXPIRATION_REJECTED:
      "That expiration date isn't allowed by this Droplet's sharing rules. Pick a different date.",
    PERMISSIONS_REJECTED:
      "That access level isn't available for this item. Pick a different access level and try again.",
    // WARP-1658 — every 403 a share write can draw is a DETERMINISTIC policy
    // rejection: role denial (requireRole), guest read-only, or insufficient
    // rights on a household/department space (requireSpaceAccess). Without this
    // entry a 403 fell through to FALLBACK.share ("Try again in a moment"),
    // which advises the one action guaranteed never to work — the WARP-1148
    // defect class this domain exists to prevent.
    //
    // The three flavours share one bare 403 with no stable wire code, so they
    // deliberately share one string: telling them apart needs distinct codes
    // from the orchestrator first (out of scope here). The wording therefore
    // stays true for all three.
    //
    // The copy has to serve two populations at once, so it names BOTH remedies.
    // On main today nothing pre-empts a role-denied share client-side — the
    // Share item in files/page.tsx is gated on `!isSingle` only, unlike its
    // Delete sibling which honours `isReaderSpace` — so an ordinary
    // reader/contributor 403 lands here and needs "ask an owner or admin".
    // Once a client-side share gate lands (the `shareBlockedReason` check
    // proposed on the WARP-1540 branch), the residual traffic is client state
    // disagreeing with server rights — a stale ACL cache, or rights revoked
    // mid-session — which a fresh session resolves, hence "sign out and back
    // in", mirroring storage["403"].
    //
    // Precedence note: `translateError` checks `err.status` before it infers a
    // code from the message, so a Nextcloud OCS rejection that arrives with
    // ocsStatus 403 (e.g. "Public upload disabled by the administrator") now
    // renders this string instead of PERMISSIONS_REJECTED. That is a
    // deliberate trade: this copy is still accurate for it (an admin policy
    // blocks the share, and an admin can lift it), and it is strictly better
    // than the retry fallback every other 403 was getting.
    "403":
      "You don't have permission to share this item. Sign out and back in if your access changed recently, or ask the Droplet's owner or an admin to share it.",
    NOT_FOUND:
      "We couldn't find that file or share anymore. It may have been moved or deleted.",
    "404":
      "We couldn't find that file or share anymore. It may have been moved or deleted.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  // WARP-1659 — the multi-select share fan-out (`BULK_SHARE_OPTIONS` in
  // files/page.tsx), one row per file. Identical to `share` apart from the two
  // codes below, because a row that fails for a reason the fan-out really is
  // responsible for must read exactly as it does in the dialog — "same 403,
  // two messages one click apart" is the WARP-1148 defect.
  //
  // PASSWORD_REJECTED / EXPIRATION_REJECTED are the exception. They are
  // INFERRED from OCS prose (see inferCodeFromMessage), and this flow hardcodes
  // its grant: no password field, no expiry picker, nothing the user chose. The
  // dialog's "that password doesn't meet the rules" is then a claim about input
  // the user never gave — on an enforce-password-on-public-links box it would
  // fire on EVERY row of the run and point away from the real cause.
  //
  // They are re-answered rather than dropped: dropping them would fall through
  // to the retry fallback, and "try again in a moment" for a deterministic
  // policy rejection is exactly what the share domain was created to stop. What
  // is true of this flow is that the rule needs a control the fan-out doesn't
  // have — and the single-file dialog does.
  //
  // `403` is NOT a divergence — it is carried over verbatim from `share`, and
  // it has to exist. Without it a bulk row's 403 falls through to
  // FALLBACK["share-bulk"] ("Try again in a moment"), which is the WARP-1658
  // defect relocated one surface over rather than fixed: POST /files/share is
  // requireRole("owner","admin","family") and `shareBlockedReason` in
  // files/page.tsx gates on space posture, not role, so a member/guest reaches
  // the fan-out and every row 403s deterministically.
  //
  // Its presence is what forces the inference-before-status carve-out in
  // `translateError` — see the comment there. Read the two together.
  "share-bulk": {
    module_disabled:
      "File sharing is turned off on this Droplet. An owner or admin can turn the Files module back on in Settings.",
    PASSWORD_REJECTED:
      "This Droplet's rules require a password on share links, and sharing several files at once can't set one. Share this file on its own to add a password.",
    EXPIRATION_REJECTED:
      "This Droplet's rules limit when share links expire, and sharing several files at once can't set an expiry date. Share this file on its own to pick one.",
    PERMISSIONS_REJECTED:
      "That access level isn't available for this item. Pick a different access level and try again.",
    "403":
      "You don't have permission to share this item. Sign out and back in if your access changed recently, or ask the Droplet's owner or an admin to share it.",
    NOT_FOUND:
      "We couldn't find that file or share anymore. It may have been moved or deleted.",
    "404":
      "We couldn't find that file or share anymore. It may have been moved or deleted.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  chat: {
    UPLOAD_TOO_LARGE:
      "That attachment is too large. Try something smaller and send again.",
    UNSUPPORTED_TYPE: "That attachment type isn't supported in chat yet.",
    INDEX_FAILED:
      "We couldn't index that attachment. The chat will keep working without it.",
    // WARP-305: brain-ingest emits these on image-only or text-extraction-empty
    // files. The chat itself is fine; only the search-inside-the-file path
    // doesn't have anything to index. Copy reflects reality — the chip is
    // soft-warning, not red — and tells the user the attachment is still
    // attached.
    IMAGE_ONLY:
      "Image stored — we can't search inside an image yet, but it's still attached to this chat.",
    EMPTY_EXTRACTION:
      "We couldn't pull text out of that file. It's still attached to this chat, but the AI can't search inside it.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again, or simplify the request.",
    ABORT: "The request was cancelled.",
  },
  invite: {
    USED: "This invite has already been used. Please ask for a fresh link.",
    EXPIRED: "This invite has expired. Please ask for a fresh link.",
    INVALID_PASSWORD:
      "That password didn't meet the requirements. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    WEAK_PASSWORD:
      "That password didn't meet the requirements. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    NOT_FOUND:
      "We couldn't find this invite. It may have been revoked or the link copied incorrectly.",
  },
  calendar: {
    NOT_FOUND: "We couldn't find that reminder anymore.",
    TITLE_REQUIRED: "Reminders need a title and a due time.",
    PAST_DUE: "Pick a due time in the future.",
  },
  subscription: {
    INVALID_URL:
      "That URL doesn't look like a calendar feed. Check the address and try again.",
    AUTH_REQUIRED:
      "That calendar needs a username and password. Check the credentials and try again.",
    SYNC_FAILED:
      "We couldn't sync that calendar right now. Try again in a moment.",
    NOT_FOUND: "That subscription is no longer available.",
  },
  "provider-key": {
    INVALID_KEY: "That API key didn't look right. Double-check it and try again.",
    SAVE_FAILED:
      "We couldn't save that API key right now. Try again in a moment.",
    DELETE_FAILED:
      "We couldn't remove that API key right now. Try again in a moment.",
  },
  push: {
    PERMISSION_DENIED:
      "Notifications are blocked in your browser. Re-enable them in your browser's site settings to receive push alerts.",
    UNSUPPORTED:
      "This browser doesn't support push notifications. Open the dashboard in a recent Chrome, Firefox, Edge, or Safari (16.4+).",
    NOT_CONFIGURED:
      "Push notifications aren't set up on this Droplet yet. Ask the admin to finish configuration.",
    SUBSCRIBE_FAILED:
      "We couldn't enable push notifications right now. Try again in a moment.",
    UNSUBSCRIBE_FAILED:
      "We couldn't disable push notifications right now. Try again in a moment.",
    TEST_FAILED:
      "We couldn't send the test notification right now. Try again in a moment.",
  },
  knowledge: {
    NOT_FOUND: "We couldn't find any recently indexed files yet.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
  },
  // hls.js Hls.ErrorDetails enum values — the ones we see most often.
  // The full list is large; unmapped values fall through to the
  // domain fallback (which is what we want — the user never sees
  // "bufferStalledError" or "manifestLoadError").
  media: {
    bufferStalledError:
      "Playback stalled. Check the connection and try again.",
    bufferAppendError:
      "We had trouble playing that recording. Try a different segment, or reload the page.",
    bufferNudgeOnStall:
      "Playback stalled. Check the connection and try again.",
    manifestLoadError:
      "We couldn't load that recording. Try a different segment, or reload the page.",
    manifestLoadTimeOut:
      "Loading that recording took too long. Try again in a moment.",
    manifestParsingError:
      "That recording is unavailable right now. Try a different segment.",
    levelLoadError:
      "We couldn't load that recording. Try a different segment, or reload the page.",
    levelLoadTimeOut:
      "Loading that recording took too long. Try again in a moment.",
    fragLoadError:
      "We had trouble loading part of that recording. Try a different segment.",
    fragLoadTimeOut:
      "Loading that recording took too long. Try again in a moment.",
    fragParsingError:
      "Part of that recording is corrupt. Try a different segment.",
    internalException:
      "The video player ran into a problem. Reload the page and try again.",
    mediaError:
      "The video player ran into a problem. Reload the page and try again.",
    networkError:
      "We had trouble streaming that recording. Check the connection and try again.",
    UNSUPPORTED:
      "This browser doesn't support HLS playback. Try Safari or a recent Chrome / Edge / Firefox.",
  },
  network: {
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    NOT_FOUND: "We couldn't find that device on your network anymore.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  vpn: {
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    NOT_FOUND: "That remote-access profile is no longer available.",
    TIMEOUT: "That took too long. Try again in a moment.",
    // WARP-1593: the box refuses to mint a linking QR until it has an internet
    // address, because the code would otherwise carry a host no phone can
    // complete an HTTPS enrollment against. translateError never surfaces
    // err.message verbatim, so without this entry the honest reason would be
    // flattened to the generic vpn fallback and the owner would be told to
    // "check the connection" — which is not the problem.
    remote_access_not_configured:
      "This Droplet doesn't have its internet address yet, so a linking code can't be created. Finish setting up remote access, then try again.",
  },
  camera: {
    NETWORK:
      "We couldn't reach that camera. Check it's powered on and connected, then try again.",
    AUTH_REQUIRED:
      "That camera needs a username and password. Check the credentials and try again.",
    NOT_FOUND: "We couldn't find that camera on your network.",
  },
  device: {
    NETWORK:
      "We couldn't reach that device. Check it's powered on and nearby, then try again.",
    NOT_FOUND: "We couldn't find that device.",
    TIMEOUT: "That device took too long to respond. Try again in a moment.",
    // WARP-851: the orchestrator's Matter commissioning route returns
    // 502 when discovery can't find the device on the network (matter.js
    // CommissionableDeviceDiscoveryFailedError, or any network/BLE-class
    // failure). Mirror its curated copy here — translateError never
    // surfaces err.message verbatim, so without this entry the honest
    // copy was flattened to the generic device fallback.
    "502":
      "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.",
    // WARP-856 (item 1): same bug class as the 502 above, for the other two
    // statuses the commissioning route actually answers. The orchestrator's
    // curated 504 copy ("Put it into pairing mode again…") reached the
    // client with err.status = 504 but no entry existed here, so the
    // actionable step was flattened to the generic device fallback;
    // `inferCodeFromMessage` only matches /timeout|timed out/, which that
    // copy doesn't contain. 503 is the controller-still-starting answer
    // ("Matter controller not started") — jargon a first-run customer
    // shouldn't see verbatim.
    "504":
      "Couldn't reach the device in time. Put it into pairing mode again, make sure it's within a few feet of the Droplet, and retry.",
    "503":
      "The Droplet's smart-device service is still starting up. Give it a few seconds and try again.",
  },
  // WARP-1154/1155 — the native Projects (PM) surface. Codes are the stable
  // snake_case strings the orchestrator's /api/pm/* routes emit (PM_ERRORS in
  // pm.service.ts) plus the module gate's `module_disabled`. Anything unmapped
  // falls through to the domain fallback — the raw code NEVER reaches a toast.
  projects: {
    // WARP-1528: `module_disabled` is emitted by BOTH the workspace module
    // gate and the per-person feature gate (identical bodies by design), so
    // this string can no longer name the workspace as the reason — it would be
    // false for a narrowed person. Same reason-free formulation as
    // ModuleRouteGuard and the Projects index error.
    module_disabled:
      "Projects isn't available. This feature is switched off for this Droplet, or it isn't part of your access. An owner or admin can turn it on.",
    project_not_found:
      "We couldn't find that project anymore. It may have been deleted.",
    work_item_not_found:
      "We couldn't find that item anymore. It may have been deleted.",
    state_not_found:
      "That column isn't available anymore. Refresh the board and try again.",
    invalid_state:
      "That column isn't available anymore. Refresh the board and try again.",
    label_not_found:
      "That label isn't available anymore. Refresh and try again.",
    invalid_label:
      "That label isn't available anymore. Refresh and try again.",
    invalid_parent:
      "That parent item isn't available anymore. Refresh and try again.",
    identifier_taken:
      "That project ID is already in use. Pick a different one.",
    invalid_request:
      "Some of those details weren't valid. Check the form and try again.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  // WARP-1141 — drive/pool rename from the Drives page (and future storage
  // settings writes). Status-keyed: `updateDriveLabel` / `updatePoolLabel`
  // attach `err.status`, so a role-blocked or not-found rename gets
  // actionable copy instead of the fallback.
  storage: {
    "400":
      "That name can't be saved. Use 1–64 characters and try again.",
    "403":
      "Only the Droplet's owner or an admin can rename drives and pools. Sign out and back in, or ask the owner to do it.",
    "404":
      "That drive or pool isn't visible to the Droplet right now. Rescan drives, then try renaming it again.",
    "503":
      "The storage service isn't reachable right now. Try again in a moment.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  // WARP-1150/1151 — creating a pairing session (POST /api/devices/pair).
  // Only the appliance is involved at this step, so every entry talks about
  // creating a code, never about reaching a device.
  pairing: {
    // The create route's per-user rate limit (429). The fallback's plain
    // "try again in a moment" undersells the hour-long window.
    "429":
      "Too many pairing codes were created recently. Wait a while, then try again.",
    "400": "Check the device name and try again.",
    // The pairing routes answer 404 when the appliance doesn't serve them —
    // e.g. a runtime module toggle gating /api/devices (the WARP-1150 on-box
    // cause: {"error":"module_disabled"}). Pairing being unavailable is an
    // admin-configuration fact, not an unreachable device.
    module_disabled:
      "Device pairing is turned off on this Droplet. Ask an admin to enable it, then try again.",
    "404":
      "Device pairing isn't available on this Droplet right now. Ask an admin to check it's enabled, then try again.",
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  // Home's notes tile. A 401 here is a session that lapsed while the tile was
  // mounted, not a lost note, so it must not read like data loss.
  notes: {
    "401":
      "You've been signed out. Sign in again to see your notes — nothing has been lost.",
    NETWORK:
      "We can't reach this Droplet right now. Your notes are on it — check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
  generic: {
    NETWORK:
      "We can't reach this Droplet right now. Check the connection and try again.",
    TIMEOUT: "That took too long. Try again in a moment.",
  },
};

/**
 * Best-effort substring matcher over an `err.message` for cases where
 * a backend doesn't (yet) emit a typed `err.code`. Maps the message
 * to a domain code; the caller then renders the friendly copy for
 * that code. Never returns the message itself.
 */
function inferCodeFromMessage(
  message: string,
  domain: ErrorDomain,
): string | undefined {
  const m = message.toLowerCase();
  if (/network|fetch|econnrefused|enotfound|failed to fetch/.test(m)) {
    return "NETWORK";
  }
  if (/timeout|timed out/.test(m)) return "TIMEOUT";
  if (/abort/.test(m)) return "ABORT";
  // WARP-305: brain-ingest reasons come through as raw lowercase strings
  // (`empty_extraction`, `image_only`) on the AttachmentChip's `error`
  // field. Match them here so the chat-domain copy fires instead of
  // falling through to the generic "Something went wrong on this turn"
  // toast.
  if (domain === "chat") {
    if (/image[_ ]only/.test(m)) return "IMAGE_ONLY";
    if (/empty[_ ]extraction|no[_ ]text/.test(m)) return "EMPTY_EXTRACTION";
  }
  // WARP-1148/1149: Nextcloud's share-create checks answer 400/403 with a
  // human-readable OCS message, not a stable code ("Password is present in
  // compromised password list", "Cannot set expiration date more than …",
  // "File shares cannot have create or delete permissions", "Public upload
  // disabled by the administrator"). Match the stable keywords so the dialog
  // renders the actionable copy instead of the retry fallback — these are
  // deterministic policy rejections where retrying can never help.
  // WARP-1659: `share-bulk` reads the same wire, so it infers the same codes —
  // the divergence lives in the copy each domain maps them to, not here.
  if (domain === "share" || domain === "share-bulk") {
    if (/password/.test(m)) return "PASSWORD_REJECTED";
    if (/expir/.test(m)) return "EXPIRATION_REJECTED";
    if (/permission|public upload/.test(m)) return "PERMISSIONS_REJECTED";
    if (/not found|does not exist|wrong path|wrong share/.test(m)) {
      return "NOT_FOUND";
    }
  }
  if (domain === "push") {
    if (/not configured/.test(m)) return "NOT_CONFIGURED";
    if (/denied|permission/.test(m)) return "PERMISSION_DENIED";
    if (/unsupport/.test(m)) return "UNSUPPORTED";
  }
  if (domain === "auth" && /401|unauthor|invalid credentials/.test(m)) {
    return "INVALID_CREDENTIALS";
  }
  if (domain === "media" && /unsupport/.test(m)) return "UNSUPPORTED";
  return undefined;
}

/**
 * Translate an unknown error into plain home-user copy.
 *
 * Dispatch order:
 *   1. `err.code` (when present) → per-domain mapping.
 *   2. `err.status` (number) → string-coerced for the same mapping.
 *   3. `err.message` → infer a code via substring match; map that.
 *   4. Otherwise → domain fallback (never `err.message`).
 *
 * `share-bulk` swaps 2 and 3 — see the carve-out comment in the body.
 *
 * The raw error is logged to `console.error` so operators still have
 * the underlying cause when reviewing DevTools.
 */
export function translateError(err: unknown, domain: ErrorDomain): string {
  // Operator / debug breadcrumb — full raw cause, never on screen.
  // eslint-disable-next-line no-console
  console.error(`[friendly-errors:${domain}]`, err);

  let code: string | undefined;
  let status: number | undefined;
  let message: string | undefined;

  if (err && typeof err === "object") {
    const e = err as FriendlyError;
    if (typeof e.code === "string") code = e.code;
    if (typeof e.status === "number") status = e.status;
    if (typeof e.message === "string") message = e.message;
  }

  const domainCodes = CODES[domain];

  if (code && domainCodes[code]) return domainCodes[code];
  // WARP-1659 × WARP-1658 — `share-bulk` alone infers BEFORE it dispatches on
  // status. Both tickets are right and the default order cannot serve both.
  //
  // Nextcloud answers a passwordless link create on an
  // enforce-password-on-public-links box with OCSForbidden — status 403,
  // password prose. Under the default order that 403 would shadow
  // PASSWORD_REJECTED, so every row of a bulk run would read "you don't have
  // permission" (false — the user has permission; the box wants a password)
  // and the one remedy available without an admin, the single-file dialog,
  // would never be named. Dropping CODES["share-bulk"]["403"] instead would
  // hand a role-denied member the retry fallback, the WARP-1658 defect.
  //
  // Inferring first serves both: prose-bearing rejections keep the copy
  // WARP-1659 wrote for them, and a bare/role-denial 403 — which infers
  // nothing — still falls to the 403 entry below. Scoped to this domain
  // deliberately: `share`'s status-first order and the trade WARP-1658
  // documented for it are untouched.
  if (message && domain === "share-bulk") {
    const inferred = inferCodeFromMessage(message, domain);
    if (inferred && domainCodes[inferred]) return domainCodes[inferred];
  }
  if (status !== undefined && domainCodes[String(status)]) {
    return domainCodes[String(status)];
  }
  if (message) {
    const inferred = inferCodeFromMessage(message, domain);
    if (inferred && domainCodes[inferred]) return domainCodes[inferred];
  }
  return FALLBACK[domain];
}
