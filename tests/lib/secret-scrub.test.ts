import { describe, expect, it } from "vitest";
import { redactText } from "@/lib/diagnostics/scrub";
import { redactSecrets } from "@/lib/telemetry/sanitize";

// FAKE test fixtures split into fragments so static secret scanners do not flag them.
const FAKE_SECRETS: [string, string][] = [
    ["github_classic", ["gh", "p_", "1234567890abcdefghij1234567890abcd"].join("")],
    ["github_pat", ["github", "_pat_", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789"].join("")],
    ["aws_access_key", ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
    ["jwt_token", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"].join(".")],
];
describe("secret scrub", () => {
    it.each(FAKE_SECRETS)("redacts %s", (_k, s) => expect([redactText(`x ${s}`), redactSecrets(`x ${s}`)]).toEqual(["x [redacted]", expect.not.stringContaining(s)]));
    it.each([[redactText, 'password="a b"', "a b"], [redactText, "api_key: abc123", "abc123"], [redactText, '{"token":"sec"}', "sec"], [redactSecrets, 'password="a b"', "a b"], [redactSecrets, 'secret="abc"\nother="ok"', "abc"], [redactSecrets, "refresh_token=z", "z"], [redactSecrets, "Bearer abc.def-123", "abc.def-123"], [redactSecrets, "Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"], [redactSecrets, '{"authToken":"abc"}', "abc"], [redactSecrets, "clientSecret=xyz", "xyz"]] as const)("case %#", (fn, i, b) => expect(fn(i)).not.toContain(b));
    it("edges", () => expect([redactText(""), redactSecrets(""), redactText("a".repeat(20), 6).length, redactSecrets("a".repeat(20), 6).length, redactText("u@e.co /home/a/b"), redactSecrets("u@e.co /Users/b/c"), redactText("the token"), redactSecrets("password field")]).toEqual(["", "", 6, 6, "[email] ~/b", "[email] ~/c", "the token", "password field"]));
});
