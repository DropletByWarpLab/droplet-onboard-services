export const GOOGLE_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
export const GOOGLE_MAIL_SCOPE = "https://mail.google.com/";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export interface GoogleFeatures { mail: boolean; calendar: boolean }
export const DEFAULT_GOOGLE_FEATURES: GoogleFeatures = { mail: true, calendar: false };
export function scopesForGoogleFeatures(features: GoogleFeatures): string[] {
  return [GOOGLE_EMAIL_SCOPE, ...(features.mail ? [GOOGLE_MAIL_SCOPE] : []), ...(features.calendar ? [GOOGLE_CALENDAR_SCOPE] : [])];
}
export function canonicalGoogleScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope === "email" ? GOOGLE_EMAIL_SCOPE : scope))];
}
export function googleGrantCovers(granted: readonly string[], requested: readonly string[]): boolean {
  const actual = new Set(canonicalGoogleScopes(granted));
  return canonicalGoogleScopes(requested).every((scope) => actual.has(scope));
}
