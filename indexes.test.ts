import assert from "node:assert/strict";
import { test } from "node:test";
import { indexesInRange } from "./server.ts";

test("indexesInRange keeps only integers inside 1..length", () => {
  assert.deepEqual(
    indexesInRange([1, 2, 2.5, "3", 0, -1, 4, 3], 3),
    [1, 2, 3],
  );
  assert.deepEqual(indexesInRange({ indexes: [1] }, 3), []);
  assert.deepEqual(indexesInRange([1], 0), []);
});
