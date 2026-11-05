import { exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://testteam.cloudflareaccess.com";
const AUD = "test-aud";
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwksBody = "";

const handler = exports.default as {
  fetch(request: Request): Promise<Response>;
};

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwksBody = JSON.stringify({ keys: [jwk] });
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === CERTS) {
      return new Response(jwksBody, {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function tokenFor(
  email: string,
  options?: { aud?: string; expired?: boolean },
): Promise<string> {
  const jwt = new SignJWT({ email, sub: `sub-${email}` })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(options?.aud ?? AUD)
    .setIssuedAt();
  if (options?.expired) {
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60);
  } else {
    jwt.setExpirationTime("10m");
  }
  return jwt.sign(privateKey);
}

function authed(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  return handler.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
  );
}

const csv = `Date,Description,Amount
2026-01-02,DEBIT CARD PURCHASE CHIPOTLE 1234 NC,-12.50
2026-01-03,PIEDMONT NATURAL GAS,-40.00
2026-01-04,COSTCO WHSE #123 RALEIGH NC,-86.20
`;

async function signed(
  payload: Record<string, unknown>,
  header: { alg: "RS256" | "HS256"; kid?: string } = { alg: "RS256", kid: "test-key" },
): Promise<string> {
  const jwt = new SignJWT(payload)
    .setProtectedHeader(
      header.alg === "HS256"
        ? { alg: "HS256" }
        : { alg: "RS256", kid: header.kid ?? "test-key" },
    )
    .setIssuer(typeof payload.iss === "string" ? payload.iss : ISSUER)
    .setAudience(typeof payload.aud === "string" ? payload.aud : AUD)
    .setIssuedAt()
    .setExpirationTime("10m");
  if (header.alg === "HS256") {
    return jwt.sign(new TextEncoder().encode("not-the-access-key"));
  }
  return jwt.sign(privateKey);
}

function unsignedToken(): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replaceAll("=", "")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
  const header = encode({ alg: "none", typ: "JWT" });
  const payload = encode({
    iss: ISSUER,
    aud: AUD,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "ada@example.com",
    sub: "sub-ada",
  });
  return `${header}.${payload}.`;
}

describe("/api auth", () => {
  it("rejects health, upload, and query without a JWT", async () => {
    const health = await handler.fetch(new Request("https://example.com/api/health"));
    expect(health.status).toBe(401);
    expect(await health.json()).toEqual({ error: "Unauthorized" });
    for (const path of ["/api/upload", "/api/query"]) {
      const response = await handler.fetch(
        new Request(`https://example.com${path}`, { method: "POST" }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("rejects an expired JWT and a JWT for another application", async () => {
    const expired = await tokenFor("ada@example.com", { expired: true });
    const wrongAud = await tokenFor("ada@example.com", { aud: "other-app" });
    for (const token of [expired, wrongAud]) {
      const response = await authed("/api/health", token);
      expect(response.status).toBe(401);
    }
  });

  it("rejects a wrong issuer, alg none, HS256, and an unknown key id", async () => {
    const wrongIssuer = await signed({
      email: "ada@example.com",
      sub: "sub-ada",
      iss: "https://evil.cloudflareaccess.com",
    });
    const hs256 = await signed(
      { email: "ada@example.com", sub: "sub-ada" },
      { alg: "HS256" },
    );
    const unknownKid = await signed(
      { email: "ada@example.com", sub: "sub-ada" },
      { alg: "RS256", kid: "missing-key" },
    );
    for (const token of [wrongIssuer, unsignedToken(), hs256, unknownKid]) {
      const response = await authed("/api/health", token);
      expect(response.status).toBe(401);
    }
  });

  it("rejects a token with no email or sub and a service token", async () => {
    const noIdentity = await signed({});
    const serviceToken = await signed({ type: "app", common_name: "ci-client" });
    for (const token of [noIdentity, serviceToken]) {
      const response = await authed("/api/health", token);
      expect(response.status).toBe(401);
    }
  });
});

describe("/api with a valid Access JWT", () => {
  it("serves health without a row count", async () => {
    const token = await tokenFor("ada@example.com");
    const response = await authed("/api/health", token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      runtime: "cloudflare-workers",
      llm: "workers-ai",
      ledger: "durable-object",
    });
    expect(body).not.toHaveProperty("rows");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not allow a cross-origin browser", async () => {
    const token = await tokenFor("ada@example.com");
    const response = await authed("/api/health", token, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example",
    );
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("rejects an upload with no file", async () => {
    const token = await tokenFor("ada@example.com");
    const response = await authed("/api/upload", token, {
      method: "POST",
      body: new FormData(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No file uploaded" });
  });

  it("uploads a statement and answers a non-model query", async () => {
    const token = await tokenFor("ada@example.com");
    const form = new FormData();
    form.set("file", new File([csv], "statement.csv", { type: "text/csv" }));
    const uploaded = await authed("/api/upload", token, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({ count: 3 });

    const queried = await authed("/api/query", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What was my highest charge?" }),
    });
    expect(queried.status).toBe(200);
    const body = (await queried.json()) as { answer?: string };
    expect(body.answer).toContain("Costco");
    expect(body.answer).toContain("86.20");

    const bob = await tokenFor("bob@example.com");
    const bobQuery = await authed("/api/query", bob, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What was my highest charge?" }),
    });
    expect(bobQuery.status).toBe(400);
    expect(await bobQuery.json()).toEqual({
      error: "Please upload a transaction report first.",
    });
  });

  it("rejects an upload larger than 5 MB", async () => {
    const token = await tokenFor("ada@example.com");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(5_000_001)], "big.csv", { type: "text/csv" }),
    );
    const response = await authed("/api/upload", token, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "File is larger than 5 MB." });
  });

  it("rejects a statement over the row limit", async () => {
    const token = await tokenFor("limit@example.com");
    const lines = ["Date,Description,Amount"];
    for (let i = 0; i < 20_001; i++) lines.push("2026-01-01,SHOP,-1.00");
    const form = new FormData();
    form.set(
      "file",
      new File([lines.join("\n")], "many.csv", { type: "text/csv" }),
    );
    const response = await authed("/api/upload", token, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("20000");
  });

  it("fails closed when Access configuration is missing", { concurrent: false }, async () => {
    const previousTeam = process.env.ACCESS_TEAM_DOMAIN;
    const previousAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    try {
      const token = await tokenFor("ada@example.com");
      const response = await authed("/api/health", token);
      expect(response.status).toBe(401);
    } finally {
      if (previousTeam === undefined) delete process.env.ACCESS_TEAM_DOMAIN;
      else process.env.ACCESS_TEAM_DOMAIN = previousTeam;
      if (previousAud === undefined) delete process.env.ACCESS_AUD;
      else process.env.ACCESS_AUD = previousAud;
    }
  });
});
