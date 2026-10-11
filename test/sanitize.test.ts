import { describe, expect, it } from "vitest";
import { collectSecretValues, sanitizeError } from "../src/sanitize";

describe("sanitizeError", () => {
  const secretValues = collectSecretValues(["dg_supersecretvalue", "mongodb+srv://user:pw@cluster0.example.net/db", undefined, "abc"]);

  it("redacts secret values", () => {
    expect(sanitizeError({ message: "bad key dg_supersecretvalue", secretValues })).toBe("bad key ***");
  });

  it("redacts whole values before partial matches", () => {
    expect(
      sanitizeError({ message: "cannot reach mongodb+srv://user:pw@cluster0.example.net/db", secretValues })
    ).toBe("cannot reach ***");
  });

  it("ignores values too short to be secrets", () => {
    expect(sanitizeError({ message: "abc is fine", secretValues })).toBe("abc is fine");
  });

  it("redacts URL credentials and query strings", () => {
    expect(
      sanitizeError({ message: "GET https://api.example.com/v1/x?key=abc123&b=2 failed", secretValues: [] })
    ).toBe("GET https://api.example.com/v1/x?*** failed");
    expect(sanitizeError({ message: "redis://admin:hunter2@host:6379 down", secretValues: [] })).toBe(
      "redis://***@host:6379 down"
    );
  });

  it("redacts bearer-like tokens", () => {
    expect(sanitizeError({ message: "sent Bearer abcdefghijklmnop", secretValues: [] })).toBe("sent Bearer ***");
  });

  it("truncates long messages", () => {
    expect(sanitizeError({ message: "x".repeat(1000), secretValues: [] })?.length).toBe(301);
  });

  it("returns undefined for no message", () => {
    expect(sanitizeError({ message: undefined, secretValues })).toBeUndefined();
  });
});

describe("collectSecretValues", () => {
  it("also redacts the string fields of JSON secrets", () => {
    const key = JSON.stringify({ type: "service_account", private_key: "-----BEGIN KEY-----abcdef", client_email: "bot@project.iam" });
    const values = collectSecretValues([key]);
    expect(values).toContain("-----BEGIN KEY-----abcdef");
    expect(values).toContain("bot@project.iam");
    expect(sanitizeError({ message: "invalid_grant for bot@project.iam", secretValues: values })).toBe(
      "invalid_grant for ***"
    );
  });

  it("orders longest first", () => {
    const values = collectSecretValues(["secret-a", "secret-a-longer"]);
    expect(values.indexOf("secret-a-longer")).toBeLessThan(values.indexOf("secret-a"));
    expect([...values].sort((a, b) => b.length - a.length)).toEqual(values);
  });
});
