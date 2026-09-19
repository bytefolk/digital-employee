#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// c8 enforces percentages. An empty Istanbul summary uses "Unknown", which
// does not compare below a numeric threshold, so reject missing measurements.
const summary = JSON.parse(await readFile(process.argv[2] ?? "coverage/coverage-summary.json", "utf8"));
assert.ok(Object.keys(summary).some(key => key !== "total"), "Coverage report contains no measured files");
for (const metric of ["lines", "branches", "functions"]) {
  const measurement = summary.total?.[metric];
  assert.ok(
    measurement && Number.isInteger(measurement.total) && measurement.total > 0 &&
      Number.isFinite(measurement.pct),
    `Coverage report contains no measured ${metric}`
  );
}
console.log("Coverage report contains measured files, lines, branches and functions.");
