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
