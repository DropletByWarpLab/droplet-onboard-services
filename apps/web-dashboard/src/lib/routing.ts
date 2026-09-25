export const HELP_PATH = "/help";

// Pages an anonymous visitor may sit on. ONE list, read by both AuthGate (route
// guard) and authFetch (the dead-session bounce): they used to keep separate
// copies, and `/invite` was added to AuthGate's only — so an invitee's first
// `/api/auth/me` 401 still hard-navigated them to `/login` a few seconds after
// the password form painted. `/invite` is public because an invite link goes
// to a brand-new, NOT-yet-authenticated person so they can set their password
// at `/invite/<token>`. `startsWith` is safe — `/invite` is the only route
// under that prefix.
export const PUBLIC_PATHS = ["/setup", "/login", "/invite"];
