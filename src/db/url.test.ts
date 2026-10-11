import { describe, expect, it } from "vitest";
import { databaseUrlFrom, describeDatabase } from "./url.ts";

describe("databaseUrlFrom", () => {
  it("returns a postgres URL as it is", () => {
    const url = "postgres://user:pa55@db.example.com:5432/sooner?sslmode=require";
    expect(databaseUrlFrom({ DATABASE_URL: url })).toBe(url);
    expect(databaseUrlFrom({ DATABASE_URL: "postgresql://localhost/x" })).toBe("postgresql://localhost/x");
  });

  it("explains how to get one when it is missing", () => {
    expect(() => databaseUrlFrom({})).toThrow(/npm run db:dev/);
    expect(() => databaseUrlFrom({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL is not set/);
  });

  it("rejects anything that is not a postgres URL, without repeating it back", () => {
    for (const bad of ["not a url", "mysql://user:secretpw@host/db", "https://user:secretpw@host/db"]) {
      let message = "";
      try {
        databaseUrlFrom({ DATABASE_URL: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).not.toContain("secretpw");
      expect(message).not.toContain(bad);
    }
  });
});

describe("describeDatabase", () => {
  it("names the host, port and database and leaves the credentials out", () => {
    expect(describeDatabase("postgres://user:pa55@db.example.com:5432/sooner?sslmode=require")).toBe("db.example.com:5432/sooner");
    expect(describeDatabase("postgres://u:p@localhost/x")).toBe("localhost/x");
  });
});
