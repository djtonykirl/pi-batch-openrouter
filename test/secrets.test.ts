import assert from "node:assert/strict";
import test from "node:test";
import { fingerprint, formatSecretFindings, scanForSecrets } from "../src/context/secrets.js";

// Fake values assembled at runtime so no credential-shaped literal exists in the repo.
const FAKE = {
  pemHeader: "-----BEGIN " + "RSA PRIVATE KEY-----",
  aws: "AKIA" + "QWERTYUIOPASDFGH",
  github: "ghp_" + "x1Y2z3".repeat(6),
  openrouter: "sk-or-v1-" + "0123456789abcdef".repeat(4),
  bearer: "eyJhbGciOi" + "JIUzI1NiJ9fakefakefake",
  clientSecret: "Zx9" + "-cl13nt-s3cr3t-value",
  apiKey: "k3y" + "_abcdefghijklmnop",
  password: "Hunter2" + "!correct-horse",
};

test("detects a private key block", () => {
  const f = scanForSecrets(`line1\n${FAKE.pemHeader}\nMIIE...\n`, "id.txt");
  assert.equal(f.length, 1);
  assert.equal(f[0]!.type, "private key block");
  assert.equal(f[0]!.line, 2);
});

test("detects AWS, GitHub and OpenRouter-style keys", () => {
  const text = `aws=${FAKE.aws}\ngh: ${FAKE.github}\nor ${FAKE.openrouter}\n`;
  const types = scanForSecrets(text, "x.txt").map((f) => f.type);
  assert.ok(types.includes("AWS access key ID"));
  assert.ok(types.includes("GitHub token"));
  assert.ok(types.includes("OpenRouter API key"));
});

test("detects bearer tokens", () => {
  const f = scanForSecrets(`curl -H "Authorization: Bearer ${FAKE.bearer}"`, "run.sh");
  assert.deepEqual(f.map((x) => x.type), ["bearer token"]);
});

test("detects client_secret, api_key and password assignments", () => {
  const text = [
    `{ "client_secret": "${FAKE.clientSecret}",`,
    `  "api_key": "${FAKE.apiKey}",`,
    `  "password": "${FAKE.password}" }`,
  ].join("\n");
  const f = scanForSecrets(text, "src/config/local.settings.json");
  assert.deepEqual(
    f.map((x) => [x.type, x.line]),
    [
      ["client secret assignment", 1],
      ["API key assignment", 2],
      ["password assignment", 3],
    ],
  );
});

test("detects credential-bearing connection strings", () => {
  const f = scanForSecrets(`DATABASE_URL=postgres://app:${FAKE.password}@db.internal:5432/app`, ".env.sample");
  assert.ok(f.some((x) => x.type === "credential-bearing connection string"));
});

test("detects the exact configured API key value even without a known prefix", () => {
  const key = "custom-" + "key-value-123456";
  const f = scanForSecrets(`token is ${key} here`, "notes.md", [key]);
  assert.deepEqual(f.map((x) => x.type), ["configured API key value"]);
});

test("diagnostics never contain the secret value, only a fingerprint", () => {
  const f = scanForSecrets(`"password": "${FAKE.password}"`, "a.json");
  const rendered = formatSecretFindings(f) + JSON.stringify(f);
  assert.ok(!rendered.includes(FAKE.password));
  assert.equal(f[0]!.fingerprint, fingerprint(FAKE.password));
  assert.match(rendered, /Submission blocked/);
  assert.match(rendered, /File: a\.json/);
  assert.match(rendered, /Line: 1/);
  assert.match(rendered, /Type: password assignment/);
});

test("false-positive guards: placeholders, env indirection and ordinary code", () => {
  const text = [
    `const password = process.env.DB_PASSWORD;`,
    `api_key: "\${OPENROUTER_API_KEY}"`,
    `"password": "changeme"`,
    `client_secret = "<your-client-secret>"`,
    `headers.Authorization = \`Bearer \${token}\`;`,
    `const passwordField = form.querySelector("#password");`,
    `import sklearn  # sk-learn is not a key`,
    `postgres://user:\${PASS}@localhost/db`,
  ].join("\n");
  assert.deepEqual(scanForSecrets(text, "ok.ts"), []);
});
