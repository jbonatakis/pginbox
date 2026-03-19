import { describe, expect, it } from "bun:test";
import { postgresqlArchiveMessageUrl } from "../../src/frontend/lib/postgresqlArchive";

describe("postgresqlArchiveMessageUrl", () => {
  it("builds a PostgreSQL archive URL from a bracketed RFC message id", () => {
    expect(
      postgresqlArchiveMessageUrl(
        "<CAOYmi+miuQOntENQi+aNkTNEyxVbkgCftOR8Fpe_LdYpQZWKAw@mail.gmail.com>"
      )
    ).toBe(
      "https://www.postgresql.org/message-id/CAOYmi%2BmiuQOntENQi%2BaNkTNEyxVbkgCftOR8Fpe_LdYpQZWKAw%40mail.gmail.com"
    );
  });

  it("accepts message ids that are already unwrapped", () => {
    expect(postgresqlArchiveMessageUrl("message@example.com")).toBe(
      "https://www.postgresql.org/message-id/message%40example.com"
    );
  });

  it("returns null for empty or missing ids", () => {
    expect(postgresqlArchiveMessageUrl(null)).toBeNull();
    expect(postgresqlArchiveMessageUrl(undefined)).toBeNull();
    expect(postgresqlArchiveMessageUrl("   ")).toBeNull();
    expect(postgresqlArchiveMessageUrl("<   >")).toBeNull();
  });
});
