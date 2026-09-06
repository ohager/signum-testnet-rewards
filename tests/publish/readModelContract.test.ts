import { test, expect, describe } from "bun:test";
import { PUBLISH_SCHEMA_SQL, parseSchemaColumns } from "../../src/publish/tursoSchema.ts";
import { READ_MODEL_COLUMNS } from "../../web/src/lib/readModel.ts";

/**
 * Pins the public site to the schema the service actually publishes.
 *
 * `web/` is a separate deployment root with its own dependency tree, so it
 * redeclares the read-model instead of importing it. This test is what makes
 * that copy safe: renaming or dropping a published column fails HERE, in the
 * service that owns the schema, rather than at 3am as a SQL error on a page
 * nobody is watching.
 *
 * Subset, not equality — the site may ignore columns it has no use for. It may
 * not read one that does not exist.
 */
describe("published read-model contract", () => {
  const schema = parseSchemaColumns(PUBLISH_SCHEMA_SQL);

  test("every table the site reads is actually published", () => {
    for (const table of Object.keys(READ_MODEL_COLUMNS)) {
      expect(schema.has(table)).toBe(true);
    }
  });

  test.each(Object.entries(READ_MODEL_COLUMNS))(
    "%s: every column the site reads exists in the DDL",
    (table, columns) => {
      const published = new Set((schema.get(table) ?? []).map((c) => c.name));
      const missing = columns.filter((c) => !published.has(c));
      expect(missing).toEqual([]);
    },
  );

  test("SANITY: an invented column would be caught", () => {
    const published = new Set((schema.get("status") ?? []).map((c) => c.name));
    expect(published.has("definitely_not_a_column")).toBe(false);
  });
});
