# Locales

This directory contains all i18n translation files for the CLI.

## Adding a new language

1. Copy `en.json` to `{locale-code}.json` (e.g. `pt-BR.json`, `ko.json`).
2. Translate all values (keep the keys unchanged).
3. Set the `"locale.display_name"` key to the language's native name (e.g. `"Portugues"`).
4. That's it — the CLI will auto-discover the new file and include it in the language selection prompt.

## File format

Flat key-value JSON. Keys use dot-separated namespaces (e.g. `deploy.channel_prompt`).
Placeholders use `{name}` syntax for runtime interpolation.

## Locale codes

Use BCP 47 codes: `en`, `zh-CN`, `ja`, `pt-BR`, `ko`, `es`, etc.

## Fallback behavior

If a key is missing from a locale file, the English (`en.json`) value is used automatically.
The application will never crash due to a missing translation key.

## Validation

The `validateCatalog()` function checks each locale against the English reference:

- All keys from `en.json` must be present
- All values must be non-empty strings

Validation runs automatically when `setLocale()` loads a file. The first 3
validation errors are logged to stderr as warnings — they don't block loading
since missing keys fall back to English. Add `"locale.display_name"` and all
keys present in `en.json` to keep validation clean.

A catalog that cannot be parsed as JSON, or whose root is not a JSON object,
is treated as malformed: the CLI writes a single `[i18n] failed to parse
{locale}.json` warning to stderr and serves canonical English instead. It
never crashes and never serves a half-loaded catalog. An explicitly requested
unsupported `--locale` is rejected as invalid input (nonzero exit).

To validate all locale files at once during CI, use `npm run check` which
exercises the test suite including the AC-002 validation tests.

## Verify against the built CLI

After adding a catalog, prove discovery and rendering against the built CLI
(no TypeScript changes required):

```bash
npm run build --silent
node ./dist/apps/cli/bin.js deploy --help --locale {locale-code}
```

The new locale code must appear in the supported locale list and the help
text must render from your catalog. Built-CLI discovery, malformed-catalog
fallback, and fail-closed `--locale` handling are pinned by
`tests/apps/deploy-i18n-discovery.test.ts`, which runs on Node 20, 22, and 24
in CI.
