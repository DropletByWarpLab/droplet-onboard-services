import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Force revalidation of HTML responses. Without this, iOS Safari (and
// to a lesser degree Chrome) caches the rendered HTML aggressively, so
// a change to <meta name="viewport"> or to the React tree takes effect
// only after the user clears history — which nobody does. The /_next/
// static chunks already carry immutable cache headers from Next's build,
// so excluding them keeps CDN/asset caching intact.
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const path = request.nextUrl.pathname;
  if (path.startsWith("/_next/") || path.startsWith("/api/")) {
    return response;
  }
  response.headers.set("Cache-Control", "no-cache, must-revalidate");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?)).*)"],
};
