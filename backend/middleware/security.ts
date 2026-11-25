import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./requestUser.ts";
import { getOidcCspDomain } from "../services/oidcConfig.ts";

const isPublic = (c: Context<AppEnv>) => {
  const { method, path } = c.req;
  return (
    path === "/rest" ||
    path.startsWith("/rest/") ||
    ((method === "GET" || method === "HEAD") && path.startsWith("/api/image-proxy/"))
  );
};

export const appOrigin = (process.env.AURRAL_APP_ORIGIN || "https://music.aurral.org").replace(
  /\/+$/,
  "",
);

const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const isAllowed = (origin: string, path: string) =>
  allowedOrigins.has(origin) || (origin === appOrigin && path.startsWith("/api/"));

export const corsHeaders = createMiddleware<AppEnv>(async (c, next) => {
  const publicRoute = isPublic(c);
  if (!publicRoute) c.res.headers.append("Vary", "Origin");
  const origin = c.req.header("origin") ?? "";
  const allowOrigin = publicRoute ? "*" : isAllowed(origin, c.req.path) ? origin : null;
  if (!allowOrigin) return next();
  c.res.headers.set("Access-Control-Allow-Origin", allowOrigin);
  c.res.headers.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Disposition, X-Aurral-Loudness",
  );
  if (c.req.method !== "OPTIONS") return next();
  c.res.headers.set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  c.res.headers.set("Access-Control-Max-Age", "600");
  return c.body(null, 204);
});

const buildCsp = (oidcDomain: string) =>
  [
    "default-src 'self'",
    "base-uri 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${["'self'", "ws:", "wss:", process.env.AUTH_PROXY_DOMAIN, oidcDomain]
      .filter(Boolean)
      .join(" ")}`,
    "media-src 'self' data: blob: https:",
    "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",
  ].join(";");

let csp = { domain: "", value: buildCsp("") };

const headers = Object.entries({
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-XSS-Protection": "0",
});

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  const domain = getOidcCspDomain();
  if (csp.domain !== domain) csp = { domain, value: buildCsp(domain) };
  c.res.headers.set("Content-Security-Policy", csp.value);
  for (const [name, value] of headers) c.res.headers.set(name, value);
  c.res.headers.set("Cross-Origin-Resource-Policy", isPublic(c) ? "cross-origin" : "same-origin");
  await next();
});
