/**
 * The heading level a network card's title renders at (WARP-1733).
 *
 * Every card on this page draws its title with the same `type-headline` token,
 * so the level is purely a document-outline decision — and since WARP-1733 the
 * workspace Wi-Fi control has TWO mounts whose outlines differ:
 *
 *   - Advanced → `WifiTab`: the card sits inside the Wi-Fi tab panel, so it
 *     genuinely is a subsection and `h3` is correct (every sibling card in that
 *     panel is an h3 too).
 *   - Simple → `NetworkSimple`: `ShellPage` renders `<h1>Network</h1>` and the
 *     column reads h1 → `<h2>Internet</h2>` → the Wi-Fi card. An `h3` there
 *     makes the heading tree claim the workspace Wi-Fi is a subsection of the
 *     Internet hero, when it is a sibling card.
 *
 * So the level travels from the mount rather than being baked into the card —
 * and it must reach BOTH branches of the workspace slot (`WifiSettingsForm` on
 * the router shape, `ApWifiCard` on the edge-router shape), or the outline is
 * only half-fixed.
 *
 * Its own module because all three of those components need the type and
 * `WorkspaceWifiCard` imports the other two — declaring it in either of them
 * would either invert that dependency or close an import cycle.
 */
export type CardHeadingLevel = "h2" | "h3";
