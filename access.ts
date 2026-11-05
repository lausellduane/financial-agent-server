import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { NextFunction, Request, Response } from "express";

export type AccessIdentity = {
  email?: string;
  sub: string;
};

declare global {
  namespace Express {
    interface Locals {
      access?: AccessIdentity;
    }
  }
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// ACCESS_TEAM_DOMAIN may be the team subdomain (`your-team`), the host
// (`your-team.cloudflareaccess.com`), or the issuer URL. The issuer is always
// `https://<team>.cloudflareaccess.com`.
export function accessIssuer(teamDomain: string): string {
  let value = teamDomain.trim().replace(/\/+$/, "");
  if (value.startsWith("https://")) return value;
  if (value.startsWith("http://")) value = value.slice("http://".length);
  if (!value.endsWith(".cloudflareaccess.com")) {
    value = `${value}.cloudflareaccess.com`;
  }
  return `https://${value}`;
}

export function accessCertsUrl(teamDomain: string): string {
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
}

// Prefix the kind of id so an email and a subject never land in one namespace.
// Prefer sub: the same email from two identity providers must not share a ledger.
export function ledgerId(identity: AccessIdentity): string {
  const sub = identity.sub.trim();
  const email = identity.email?.trim().toLowerCase() ?? "";
  if (sub) return `sub:${sub}`;
  if (email) return `email:${email}`;
  throw new Error("Access token has no email or sub");
}

function jwksFor(teamDomain: string) {
  const url = accessCertsUrl(teamDomain);
  let jwks = jwksByUrl.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

function identityFromPayload(payload: JWTPayload): AccessIdentity {
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const commonName =
    typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  // User logins and service tokens both use type "app". Global session
  // tokens use type "org" and are not accepted here.
  if (payload.type !== "app") {
    throw new Error("Access token is not an application token");
  }
  // common_name is the service-token client id. Identity tokens do not carry it.
  if (commonName) {
    throw new Error("Service tokens have no user identity");
  }
  if (!email && !sub) {
    throw new Error("Service tokens have no user identity");
  }
  if (email) return { email, sub };
  return { sub };
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessIdentity> {
  const issuer = accessIssuer(teamDomain);
  const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
    issuer,
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat"],
    clockTolerance: "30s",
  });
  return identityFromPayload(payload);
}

function configuredAccess(): { team: string; aud: string } | undefined {
  const team = process.env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = process.env.ACCESS_AUD?.trim();
  if (!team || !aud) return undefined;
  return { team, aud };
}

// Cloudflare sets navigator.userAgent to "Cloudflare-Workers" in production
// and in wrangler/vitest. Node does not. Auth is skipped only in that Node case.
export function onWorkers(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return nav?.userAgent === "Cloudflare-Workers";
}

export async function accessMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!onWorkers()) {
    next();
    return;
  }

  const config = configuredAccess();
  if (!config) {
    console.error("Access rejected: ACCESS_TEAM_DOMAIN or ACCESS_AUD is unset");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = req.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    console.error("Access rejected: missing Cf-Access-Jwt-Assertion");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    res.locals.access = await verifyAccessJwt(token, config.team, config.aud);
    next();
  } catch (error) {
    console.error(
      "Access rejected:",
      error instanceof Error ? error.message : "invalid token",
    );
    res.status(401).json({ error: "Unauthorized" });
  }
}
