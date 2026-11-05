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

async function tokenMissing(claim: "iat" | "exp"): Promise<string> {
  let jwt = new SignJWT({ email: "ada@example.com", sub: "sub-ada" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUD);
  if (claim !== "iat") jwt = jwt.setIssuedAt();
  if (claim !== "exp") jwt = jwt.setExpirationTime("10m");
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
    const report = await handler.fetch(new Request("https://example.com/api/report"));
    expect(report.status).toBe(401);
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

  it("rejects a token missing iat or exp", async () => {
    for (const claim of ["iat", "exp"] as const) {
      const response = await authed("/api/health", await tokenMissing(claim));
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
  it("reports an empty ledger before any upload", async () => {
    const token = await tokenFor("empty-report@example.com");
    const response = await authed("/api/report", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      loaded: false,
      count: 0,
      startDate: null,
      endDate: null,
      uploadedAt: null,
    });
  });

  it("reports the caller's statement after upload", async () => {
    const token = await tokenFor("report@example.com");
    const before = await authed("/api/report", token);
    expect(await before.json()).toMatchObject({ loaded: false, count: 0 });

    const form = new FormData();
    form.set("file", new File([csv], "statement.csv", { type: "text/csv" }));
    const uploaded = await authed("/api/upload", token, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);

    const response = await authed("/api/report", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      loaded: boolean;
      count: number;
      startDate: string | null;
      endDate: string | null;
      uploadedAt: string | null;
    };
    expect(body.loaded).toBe(true);
    expect(body.count).toBe(3);
    expect(body.startDate).toBe("2026-01-02");
    expect(body.endDate).toBe("2026-01-04");
    expect(body.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const other = await tokenFor("other-report@example.com");
    const hidden = await authed("/api/report", other);
    expect(await hidden.json()).toEqual({
      loaded: false,
      count: 0,
      startDate: null,
      endDate: null,
      uploadedAt: null,
    });
  });

  it("reports a loaded statement with no parseable dates", async () => {
    const token = await tokenFor("no-dates@example.com");
    const form = new FormData();
    form.set(
      "file",
      new File(
        ["Date,Description,Amount\nnot-a-date,PLANET HOME,-1541.42\n"],
        "nodate.csv",
        { type: "text/csv" },
      ),
    );
    expect(
      (await authed("/api/upload", token, { method: "POST", body: form })).status,
    ).toBe(200);
    const body = await (await authed("/api/report", token)).json();
    expect(body).toMatchObject({
      loaded: true,
      count: 1,
      startDate: null,
      endDate: null,
    });
  });

  it("replaces the stored report when the same person uploads again", async () => {
    const token = await tokenFor("replace-report@example.com");
    const firstForm = new FormData();
    firstForm.set("file", new File([csv], "statement.csv", { type: "text/csv" }));
    expect(
      (
        await authed("/api/upload", token, { method: "POST", body: firstForm })
      ).status,
    ).toBe(200);
    const first = (await (await authed("/api/report", token)).json()) as {
      count: number;
      uploadedAt: string;
    };
    expect(first.count).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const nextForm = new FormData();
    nextForm.set(
      "file",
      new File(
        ["Date,Description,Amount\n2026-03-01,SHELL OIL,-20.00\n"],
        "next.csv",
        { type: "text/csv" },
      ),
    );
    expect(
      (await authed("/api/upload", token, { method: "POST", body: nextForm }))
        .status,
    ).toBe(200);
    const next = (await (await authed("/api/report", token)).json()) as {
      loaded: boolean;
      count: number;
      startDate: string | null;
      endDate: string | null;
      uploadedAt: string | null;
    };
    expect(next).toMatchObject({
      loaded: true,
      count: 1,
      startDate: "2026-03-01",
      endDate: "2026-03-01",
    });
    expect(next.uploadedAt && first.uploadedAt < next.uploadedAt).toBe(true);
  });

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

  it("keeps the same text in two ledgers when it is an email and a subject", async () => {
    const shared = "same-person@example.com";
    const asEmail = await signed({ email: shared });
    const asSub = await signed({ sub: shared });
    const form = new FormData();
    form.set("file", new File([csv], "statement.csv", { type: "text/csv" }));
    const uploaded = await authed("/api/upload", asEmail, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);

    const other = await authed("/api/query", asSub, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What was my highest charge?" }),
    });
    expect(other.status).toBe(400);
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
