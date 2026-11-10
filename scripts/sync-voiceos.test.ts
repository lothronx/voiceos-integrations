import { expect, test } from "bun:test";
import { patchConfig } from "./sync-voiceos.ts";

const manifest = {
  id: "com.example.ga",
  preferences: [{ name: "API_KEY" }, { name: "PROPERTY_ID" }],
  tools: [{ name: "read" }, { name: "write", confirmation: { type: "card" } }],
};

/** A VoiceOS config.json with the integration installed under an older manifest. */
const config = () => ({
  settings: { theme: "dark" },
  installedIntegrations: [
    { dirPath: "/other", serverId: "int_other", manifest: { id: "com.example.other" }, configValues: { X: "1" } },
    {
      dirPath: "/vo/ga-123", serverId: "int_ga",
      manifest: { id: "com.example.ga", tools: [] },
      configValues: { API_KEY: "enc:abc", PROPERTY_ID: "42", OLD_FIELD: "x" },
    },
  ],
  customMcpServers: [
    { id: "int_other", confirmTools: ["keep"], env: { X: "1" } },
    { id: "int_ga", confirmTools: ["read", "write"], env: { API_KEY: "enc:abc", PROPERTY_ID: "42", OLD_FIELD: "x" } },
  ],
});

test("caches the new manifest and confirms exactly the tools that declare a confirmation card", () => {
  const c = config();
  expect(patchConfig(c, manifest)).toEqual({ changed: true, dirPath: "/vo/ga-123" });
  expect(c.installedIntegrations[1].manifest).toEqual(manifest);
  expect(c.customMcpServers[1].confirmTools).toEqual(["write"]);
});

test("drops Setup values for preferences the manifest no longer declares, keeping the rest", () => {
  const c = config();
  patchConfig(c, manifest);
  expect(c.installedIntegrations[1].configValues).toEqual({ API_KEY: "enc:abc", PROPERTY_ID: "42" });
  expect(c.customMcpServers[1].env).toEqual({ API_KEY: "enc:abc", PROPERTY_ID: "42" });
});

test("leaves other integrations and settings untouched", () => {
  const c = config();
  patchConfig(c, manifest);
  const fresh = config();
  expect(c.settings).toEqual(fresh.settings);
  expect(c.installedIntegrations[0]).toEqual(fresh.installedIntegrations[0]);
  expect(c.customMcpServers[0]).toEqual(fresh.customMcpServers[0]);
});

test("reports no change when the cache already matches, so VoiceOS needn't restart", () => {
  const c = config();
  patchConfig(c, manifest);
  expect(patchConfig(c, structuredClone(manifest)).changed).toBe(false);
});

test("an integration VoiceOS never installed is an error that says what to do", () => {
  expect(() => patchConfig(config(), { ...manifest, id: "com.example.missing" })).toThrow(/not installed in VoiceOS/);
});
