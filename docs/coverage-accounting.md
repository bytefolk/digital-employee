# Coverage accounting

`npm run build && npm run test:coverage` uses official `c8` 12.0.0 with V8
captures and Istanbul source-map merging. No Node internals are patched. The
full Node 20/22/24 test matrix and aggregate gates remain unchanged: 85% lines,
65% branches, 80% functions. c8 is development-only and requires Node
`^20.19.0 || ^22.12.0 || >=23`; the shipped package still declares Node `>=20`.

## Measurement boundary

The explicit `package.json` configuration preserves all nine original include
domains: TypeScript under `apps`, `connectors`, `packages`, and `profiles`;
JavaScript under `scripts`; and JavaScript under the four corresponding `dist`
directories. `exclude: []` prevents c8's default exclusions from silently
removing production files. Generated scripts are admitted before remapping,
then merged into the original source file, not counted as a second file.

`all: false` preserves the previous native collector's loaded-only boundary.
It does not claim that an unimported file was measured. The regression's frozen
124-source manifest records every original source/build/map pair (50 apps,
16 connectors, 57 packages, 1 profile); it verifies every pair remains present
and eligible, including future additions. A full report records its actual
measured files in `coverage/coverage-final.json` and totals in
`coverage/coverage-summary.json`. Never describe the configured universe as
the measured universe without comparing these files. An empty or missing
report fails closed through `scripts/check-coverage-report.js`, in addition to
c8's unchanged numeric gates.

## Why the collector changed

Native Node coverage can process a TSX-loaded source and a compiled subprocess
with different generated function ranges for the same source. Its range merge
uses function name and exact offsets; later zero-hit ranges can overwrite
earlier executed source lines. Reversing the same two raw captures changes the
result. Upgrading the native runtime did not resolve this reproduction.

The existing nine replay-guard tests plus a child importing the built host
runtime reproduce this without additional application assertions: on Node
22.23.2 the native report falls from 164/179 lines (91.62%) to 12/179 (6.70%),
although all ten tests pass. c8 retains 164/179 in both capture orders. The
import-only negative control still fails all three real aggregate thresholds.

Node and Istanbul function/branch percentages are not interchangeable metrics.
For example, TSX emits two synthetic class initializers at one source location;
Istanbul coalesces identical locations while TSC contributes a distinct unused
initializer location. The focused source-only function result is 6/7 and the
mixed result 5/7, despite preserving every executed unique source location.
The regression therefore compares both orders' complete summaries and verifies
all positive mapped statement, function and branch locations remain covered;
it does not promise monotonic generated-counter identities or hide legitimate
uncovered functions. Line coverage must retain the existing hits exactly.

## Reproduce the accounting contract

```bash
npm ci
npm run build
node --import tsx --test tests/scripts/coverage-source-maps.test.ts
npm run test:coverage
```

The focused test captures real existing CLI/guard executions in private
temporary directories, preserves complete capture bytes, reverses only file
enumeration order, checks the original mapping universe, and runs genuine
uncovered and empty-report negative controls. Its instrumentation fixtures are
isolated from the enclosing coverage run and do not pad application coverage.
Temporary captures are cleaned after the test; full-suite reports stay under
the ignored `coverage/` directory for inspection. A passing focused probe is
not a substitute for full-suite aggregate gates or independent review.
