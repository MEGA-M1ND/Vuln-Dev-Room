import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` is the only description of what a deployment must provide.
 * When a variable is added to the runtime schema but not here, the omission
 * surfaces as a confusing production failure rather than a missing-config
 * error — an empty `NEXTAUTH_URL` reaching `new URL("")` crashes the Next.js
 * build with `Invalid URL` and no mention of the variable's name.
 *
 * These tests fail at the moment a variable is introduced instead.
 */

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

/** Keys documented in `.env.example`, commented-out ones included. */
function documentedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of read(".env.example").split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

// Supplied by the runtime itself, never written into an env file.
const PROVIDED_BY_FRAMEWORK = new Set(["NODE_ENV"]);

describe(".env.example completeness", () => {
  it("documents every variable the server env schema reads", () => {
    const source = read("src/env.ts");
    // Each entry in the zod schema is `KEY: z.…`, one per line.
    const required = [...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*z\./gm)]
      .map((m) => m[1]!)
      .filter((key) => !PROVIDED_BY_FRAMEWORK.has(key));

    // Guard against the regex silently matching nothing and passing vacuously.
    expect(required.length).toBeGreaterThan(5);

    const documented = documentedKeys();
    const missing = required.filter((key) => !documented.has(key));
    expect(missing, `Undocumented in .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents every variable the Prisma schema reads", () => {
    const schema = read("prisma/schema.prisma");
    const required = [...schema.matchAll(/env\("([A-Z][A-Z0-9_]*)"\)/g)].map((m) => m[1]!);

    expect(required).toContain("DATABASE_URL");

    const documented = documentedKeys();
    const missing = required.filter((key) => !documented.has(key));
    expect(missing, `Undocumented in .env.example: ${missing.join(", ")}`).toEqual([]);
  });
});
