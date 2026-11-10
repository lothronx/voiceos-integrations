/**
 * Points the local VoiceOS app at an integration folder in this repo and
 * refreshes the manifest VoiceOS has cached for it. macOS only (dev tool).
 *
 *   bun scripts/sync-voiceos.ts integrations/google-analytics
 *
 * The integration must already be installed in VoiceOS once (Integration
 * Studio or Install from folder); it is found by its manifest `id`.
 *
 * Why: VoiceOS runs a local-folder integration from its own copy in
 * custom-mcps/<name>-<hash>, and caches the manifest in config.json
 * (installedIntegrations[].manifest; customMcpServers[].confirmTools decides
 * which tools show a confirmation card). So repo edits never reach the app.
 *
 *   1. Replace that copy with a symlink to the repo folder (a real folder is
 *      moved to ~/voiceos-backups, never deleted). Code changes then need
 *      only a server restart.
 *   2. If the cached manifest differs from the repo's: quit VoiceOS, back up
 *      config.json, patch it, relaunch, and check the patch survived.
 *      config.json is only edited while VoiceOS is not running — it rewrites
 *      the file on quit, and editing it live once broke startup.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const VOICEOS_DIR = join(homedir(), "Library/Application Support/VoiceOS");
const CONFIG = join(VOICEOS_DIR, "config.json");
const BACKUPS = join(homedir(), "voiceos-backups");

/**
 * Updates `config` in place so VoiceOS sees `manifest`: the cached manifest,
 * confirmTools (tools with a confirmation card), and Setup values only for
 * declared preferences. Returns whether anything changed and the install's folder.
 */
export function patchConfig(config: any, manifest: any): { changed: boolean; dirPath: string } {
  const install = config.installedIntegrations?.find((i: any) => i.manifest?.id === manifest.id);
  if (!install) throw new Error(`${manifest.id} is not installed in VoiceOS. Install it once from Integration Studio, then run this again.`);
  const server = config.customMcpServers?.find((s: any) => s.id === install.serverId);
  if (!server) throw new Error(`VoiceOS has no MCP server entry ${install.serverId} for ${manifest.id}; reinstall the integration.`);

  const before = structuredClone([install.manifest, server.confirmTools, install.configValues, server.env]);
  install.manifest = manifest;
  server.confirmTools = manifest.tools.filter((t: any) => t.confirmation).map((t: any) => t.name);
  const declared = new Set((manifest.preferences ?? []).map((p: any) => p.name));
  for (const values of [install.configValues, server.env]) {
    for (const key of Object.keys(values ?? {})) if (!declared.has(key)) delete values[key];
  }
  const after = [install.manifest, server.confirmTools, install.configValues, server.env];
  return { changed: !Bun.deepEquals(before, after), dirPath: install.dirPath };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const isRunning = () => Bun.spawnSync(["pgrep", "-x", "VoiceOS"]).exitCode === 0;

/** Makes `dirPath` a symlink to `repoDir`, moving whatever was there to the backups folder. */
function linkFolder(dirPath: string, repoDir: string): void {
  const st = lstatSync(dirPath, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && realpathSync(dirPath) === realpathSync(repoDir)) {
    console.log(`✓ ${basename(dirPath)} already links to ${repoDir}`);
    return;
  }
  if (st?.isSymbolicLink()) unlinkSync(dirPath);
  else if (st) {
    mkdirSync(BACKUPS, { recursive: true });
    const backup = join(BACKUPS, `${basename(dirPath)}-${stamp()}`);
    renameSync(dirPath, backup);
    console.log(`  moved VoiceOS's copy to ${backup}`);
  }
  symlinkSync(repoDir, dirPath);
  console.log(`✓ ${basename(dirPath)} → ${repoDir}`);
}

async function quitVoiceOS(): Promise<void> {
  Bun.spawnSync(["osascript", "-e", 'tell application "VoiceOS" to quit']);
  for (let i = 0; i < 30 && isRunning(); i++) await Bun.sleep(500);
  if (isRunning()) throw new Error("VoiceOS did not quit within 15 s; quit it yourself and run this again.");
}

function launchVoiceOS(): void {
  // Launched from a VS Code terminal, Electron inherits ELECTRON_RUN_AS_NODE and exits silently.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Bun.spawnSync(["open", "-a", "VoiceOS"], { env });
}

async function main(folder: string | undefined): Promise<void> {
  if (!folder) throw new Error("Usage: bun scripts/sync-voiceos.ts integrations/<name>");
  const repoDir = resolve(folder);
  const manifestPath = join(repoDir, "voiceos.integration.json");
  if (!existsSync(manifestPath)) throw new Error(`No voiceos.integration.json in ${repoDir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const { changed, dirPath } = patchConfig(config, manifest);
  linkFolder(dirPath, repoDir);
  if (!changed) {
    console.log("✓ VoiceOS's cached manifest is up to date. For code-only changes, restart the integration (or VoiceOS).");
    return;
  }

  const wasRunning = isRunning();
  if (wasRunning) await quitVoiceOS();
  // Re-read after quitting: VoiceOS may have rewritten the file on the way out.
  const fresh = JSON.parse(readFileSync(CONFIG, "utf8"));
  patchConfig(fresh, manifest);
  mkdirSync(BACKUPS, { recursive: true });
  const backup = join(BACKUPS, `config.json.${stamp()}`);
  copyFileSync(CONFIG, backup);
  const text = JSON.stringify(fresh, null, "\t");
  JSON.parse(text); // round-trips before it replaces the real file
  writeFileSync(CONFIG, text);
  console.log(`✓ updated the cached manifest (backup: ${backup})`);

  if (wasRunning) {
    launchVoiceOS();
    await Bun.sleep(5000);
    if (patchConfig(JSON.parse(readFileSync(CONFIG, "utf8")), manifest).changed) {
      throw new Error(`VoiceOS reverted the manifest on launch. Quit VoiceOS and restore ${backup} if it misbehaves.`);
    }
    console.log("✓ VoiceOS relaunched with the new manifest");
  }
}

if (import.meta.main) {
  await main(process.argv[2]).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
