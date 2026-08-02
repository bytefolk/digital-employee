import { readFile } from "node:fs/promises";

// The host registry validates this unknown external boundary. Keeping the
// fixture package-neutral proves local modules work against compiled output.
const manifest = JSON.parse(
  await readFile(new URL("./minimal-reader.profile.json", import.meta.url), "utf8")
);

export function register(registry) {
  registry.register(
    "profile",
    manifest.name,
    ({ config }) =>
      Object.freeze({
        id: config.id || manifest.name,
        displayName: config.displayName || "Minimal Reader",
        profile: manifest.name,
        profileVersion: manifest.version,
        readOnly: true,
        instructions: manifest.policy.instructions.join("\n")
      }),
    { manifest }
  );
}
