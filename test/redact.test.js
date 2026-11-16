import assert from "node:assert/strict";
import test from "node:test";

import { redactMessages, redactText } from "../src/redact.js";

const rules = [
  ["anthropic", `sk-ant-api03-${"a".repeat(80)}`, "sk-ant-short"],
  ["openai", `sk-proj-${"a".repeat(48)}`, `sk-proj-${"a".repeat(19)}`],
  ["openai", `sk-${"a".repeat(48)}`, `task-${"a".repeat(48)}`],
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((prefix) => ["github", `${prefix}${"a".repeat(36)}`, `${prefix}${"a".repeat(35)}`]),
  ["github", `github_pat_${"a".repeat(82)}`, "github_pat_example"],
  ["gitlab", `glpat-${"a".repeat(20)}`, `glpat-${"a".repeat(19)}`],
  ...["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"].map((prefix) => ["slack", `${prefix}1234567890-abcdefghijklmnopqrstuvwx`, `${prefix}short`]),
  ...["sk_live_", "rk_live_"].map((prefix) => ["stripe", `${prefix}${"a".repeat(24)}`, `${prefix.replace("live", "test")}${"a".repeat(24)}`]),
  ...["AKIA", "ASIA"].map((prefix) => ["aws", `${prefix}${"A".repeat(16)}`, `${prefix}${"A".repeat(15)}`]),
  ["google", `AIza${"a".repeat(35)}`, `AIza${"a".repeat(34)}`],
  ["npm", `npm_${"a".repeat(36)}`, `npm_${"a".repeat(35)}`],
  ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nZmFrZSBrZXk=\n-----END RSA PRIVATE KEY-----", "-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----"],
];

for (const [kind, token, nearMiss] of rules) {
  test(`redacts ${kind} format ${token.slice(0, 12)} and preserves its near miss`, () => {
    assert.deepEqual(redactText(`Before (${token}) after`), {
      text: `Before ([redacted: ${kind}]) after`, counts: { [kind]: 1 },
    });
    assert.deepEqual(redactText(nearMiss), { text: nearMiss, counts: {} });
  });
}

test("redacts authorization values while keeping the header and scheme", () => {
  for (const [scheme, value] of [["Bearer", "fake.jwt-token_123"], ["Basic", "dXNlcjpwYXNzd29yZA=="]]) {
    const kind = scheme.toLowerCase();
    assert.deepEqual(redactText(`curl -H 'Authorization: ${scheme} ${value}' /endpoint`), {
      text: `curl -H 'Authorization: ${scheme} [redacted: ${kind}]' /endpoint`, counts: { [kind]: 1 },
    });
    const nearMiss = `Authorization: ${scheme} `;
    assert.deepEqual(redactText(nearMiss), { text: nearMiss, counts: {} });
  }
  assert.equal(redactText('"authorization": "bearer fake-token"').text, '"authorization": "bearer [redacted: bearer]"');
  assert.deepEqual(redactText("Authorization: Digest fake-token"), { text: "Authorization: Digest fake-token", counts: {} });
});

test("redacts only values in secret-named environment and JSON assignments", () => {
  for (const key of ["SECRET", "accessToken", "password", "passwd", "API_KEY", "api-key", "private_key", "access-key", "SPACEFAST_TOKEN"]) {
    for (const [input, expected] of [
      [`${key}=abcdefgh`, `${key}=[redacted: assignment]`],
      [`${key}='abcdefgh'`, `${key}='[redacted: assignment]'`],
      [`${key}="abcdefgh"`, `${key}="[redacted: assignment]"`],
      [`"${key}": "abcdefgh"`, `"${key}": "[redacted: assignment]"`],
    ]) {
      assert.deepEqual(redactText(input), { text: expected, counts: { assignment: 1 } });
    }
  }
  for (const text of ["password=", '"password": ""', "password=short", '"password": "two words"', "password=\nordinarytext", "sha=0123456789abcdef0123456789abcdef01234567"]) {
    assert.deepEqual(redactText(text), { text, counts: {} });
  }
  assert.equal(redactText('password="abcdefgh\\\"ijkl"; echo ok').text, 'password="[redacted: assignment]"; echo ok');
  assert.equal(redactText("TOKEN=abcdefgh; PASSWORD=ijklmnop").text, "TOKEN=[redacted: assignment]; PASSWORD=[redacted: assignment]");
});

test("redacts only the password in URL credentials", () => {
  assert.deepEqual(redactText("Fetch https://alice:p%40ssword@example.test/path?q=1"), {
    text: "Fetch https://alice:[redacted: url-password]@example.test/path?q=1", counts: { "url-password": 1 },
  });
  for (const text of ["https://alice@example.test/path", "https://alice:@example.test/path", "https://example.test/path"]) {
    assert.deepEqual(redactText(text), { text, counts: {} });
  }
});

test("counts overlapping rules once, repeated occurrences separately, and is idempotent", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const result = redactText(`TOKEN=${token}\nAuthorization: Bearer ${token}\nhttps://user:${token}@host.test`);
  assert.deepEqual(result.counts, { github: 3 });
  assert.ok(!result.text.includes(token));
  assert.deepEqual(redactText(result.text), { text: result.text, counts: {} });
  const pem = `-----BEGIN PRIVATE KEY-----\n${token}\n-----END PRIVATE KEY-----`;
  assert.deepEqual(redactText(pem), { text: "[redacted: private-key]", counts: { "private-key": 1 } });
});

test("does not partially redact overlong tokens or normal words containing prefixes", () => {
  for (const text of [`sk-${"a".repeat(201)}`, `sk-proj-${"a".repeat(201)}`, `npm_${"a".repeat(37)}`, `prefix_ghp_${"a".repeat(36)}`, "0123456789abcdef0123456789abcdef01234567"]) {
    assert.deepEqual(redactText(text), { text, counts: {} });
  }
});

test("walks all message text and nested tool data without mutating the input", () => {
  const token = `npm_${"a".repeat(36)}`;
  const messages = [
    { role: "user", content: token, createdAt: 123 },
    { role: "assistant", content: "password=abcdefgh", model: "model" },
    { role: "tool", id: "call-1", name: "exec", status: "completed", isError: false,
      summary: token, command: token,
      input: { env: { API_KEY: "abcdefgh" }, headers: { Authorization: "Bearer fake-token" }, args: [token, null, 42, true] },
      output: [{ text: token }, { password: "abcdefgh", count: 2 }],
    },
  ];
  const before = structuredClone(messages);
  const result = redactMessages(messages);
  assert.deepEqual(messages, before);
  assert.deepEqual(result.counts, { npm: 5, assignment: 3, bearer: 1 });
  assert.equal(result.messages[2].input.env.API_KEY, "[redacted: assignment]");
  assert.equal(result.messages[2].input.headers.Authorization, "Bearer [redacted: bearer]");
  assert.deepEqual(result.messages[2].input.args, ["[redacted: npm]", null, 42, true]);
  assert.equal(result.messages[2].id, "call-1");
  assert.equal(result.messages[2].status, "completed");
  assert.equal(result.messages[2].isError, false);
  assert.equal(result.messages[0].createdAt, 123);
  assert.ok(!JSON.stringify(result.messages).includes(token));
  assert.deepEqual(redactMessages(result.messages), { messages: result.messages, counts: {} });
  assert.deepEqual(redactMessages([]), { messages: [], counts: {} });
  assert.deepEqual(redactText(""), { text: "", counts: {} });
});

test("leaves placeholders and code expressions alone", () => {
  for (const text of [
    "const apiKey = process.env.API_KEY",
    "SECRET_KEY=getSecret()",
    "const SECRET_KEY = /secret|token/i;",
    "export GITHUB_TOKEN=$GH_TOKEN",
    "curl -H \"Authorization: Bearer <token>\"",
    "Authorization: Bearer ...",
    "postgres://user:pass@host/db",
    "password=********",
  ]) {
    assert.deepEqual(redactText(text), { text, counts: {} }, text);
  }
});
