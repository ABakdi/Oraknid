import { describe, expect, it } from "vitest";
import { detectServers, explain, securityOf } from "./diagnose.ts";

const at = { host: "mail.example.com", port: 110, security: "tls" as const };

describe("a mail account that explains itself (ADR-032)", () => {
  it("names the provider from the MX records, and nothing when unknown or unresolvable", async () => {
    const mx = (exchange: string) => async () => [{ exchange }];
    expect((await detectServers("a@x.com", mx("aspmx.l.google.com.")))?.name).toMatch(/Google/);
    expect((await detectServers("a@x.com", mx("x-com.mail.protection.outlook.com")))?.name).toMatch(
      /Microsoft/,
    );
    expect((await detectServers("a@x.com", mx("in1-smtp.messagingengine.com")))?.name).toBe(
      "Fastmail",
    );
    expect(await detectServers("a@x.com", mx("mail.x.com"))).toBeNull();
    expect(
      await detectServers("a@x.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBeNull();
    expect(await detectServers("no-at-sign", mx("aspmx.l.google.com"))).toBeNull();
  });

  it("knows the security of the usual ports", () => {
    expect([993, 995, 465].map(securityOf)).toEqual(["tls", "tls", "tls"]);
    expect([143, 110, 587].map(securityOf)).toEqual(["starttls", "starttls", "starttls"]);
    expect(securityOf(2525)).toBeNull();
  });

  it("turns errors into what to check", () => {
    const err = (message: string, extra: object = {}) => Object.assign(new Error(message), extra);
    expect(explain("POP3", at, err("ssl3_get_record:wrong version number"))).toMatch(
      /doesn't start with TLS.*STARTTLS for port 110, or TLS on port 995/,
    );
    expect(explain("SMTP", at, err("getaddrinfo ENOTFOUND", { code: "ENOTFOUND" }))).toMatch(
      /no server by that name/,
    );
    expect(
      explain("IMAP", { ...at, port: 995, security: "starttls" }, err("x", { code: "ETIMEDOUT" })),
    ).toMatch(/no answer in time/);
    expect(
      explain("POP3", { ...at, port: 995, security: "starttls" }, err("Socket timeout")),
    ).toMatch(/expects TLS from the start\. Choose TLS/);
    expect(
      explain("POP3", at, err("[AUTH] Authentication failed.", { authenticationFailed: true })),
    ).toMatch(/refused the login \(\[AUTH\] Authentication failed\.\).*full address/);
    expect(explain("SMTP", at, err("odd"))).toBe("SMTP (mail.example.com:110): odd");
  });
});
