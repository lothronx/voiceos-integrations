/**
 * Points the local VoiceOS app at an integration folder in this repo and
 * refreshes the manifest VoiceOS has cached for it. macOS and Windows (dev tool).
 *
 *   bun scripts/sync-voiceos.ts integrations/google-analytics
 *   bun scripts/sync-voiceos.ts integrations/asana --replace com.voiceos.generated.asana
 *
 * The integration must already be installed in VoiceOS once (Integration
 * Studio or Install from folder); it is found by its manifest `id`. If the
 * installed copy has a different id (Studio generated it under another one),
 * pass that id with --replace and the install is re-pointed at this manifest.
 *
 * Why: VoiceOS runs a local-folder integration from its own copy in
 * custom-mcps/<name>-<hash>, and caches the manifest in config.json
 * (installedIntegrations[].manifest; customMcpServers[].confirmTools decides
 * which tools show a confirmation card). So repo edits never reach the app.
 *
 *   1. Replace that copy with a link to the repo folder (a real folder is
 *      moved to ~/voiceos-backups, never deleted). On Windows the link is a
 *      directory junction, which needs no admin rights. Code changes then need
 *      only a server restart.
 *   2. If the cached manifest differs from the repo's: quit VoiceOS, back up
 *      config.json, patch it, relaunch, and check the patch survived.
 *      config.json is only edited while VoiceOS is not running — it rewrites
 *      the file on quit, and editing it live once broke startup.
 *
 * Windows notes:
 *   - VoiceOS ignores a polite quit there (taskkill: "can only be terminated
 *     forcefully"), so it is force-quit. A forced quit also skips the
 *     config.json rewrite on the way out.
 *   - A Windows shortcut (<folder>.lnk, e.g. from `ln -s` in Git Bash) is not a
 *     link VoiceOS can follow; one next to the folder is moved to the backups.
 *   - After relaunch VoiceOS syncs installs from the cloud and may give the
 *     install a new serverId (and add a matching server). The check waits for
 *     that to settle instead of failing on the first read.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, rmdirSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const IS_WIN = process.platform === "win32";
const VOICEOS_DIR = IS_WIN
  ? join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "VoiceOS")
  : join(homedir(), "Library/Application Support/VoiceOS");
const CONFIG = join(VOICEOS_DIR, "config.json");
const BACKUPS = join(homedir(), "voiceos-backups");

/**
 * Updates `config` in place so VoiceOS sees `manifest`: the cached manifest,
 * confirmTools (tools with a confirmation card), and Setup values only for
 * declared preferences. The install is found by `manifest.id`, or by
 * `replaceId` when the installed copy carries another id; the MCP server's
 * integrationId and name follow the manifest. Returns whether anything changed
 * and the install's folder.
 */
export function patchConfig(config: any, manifest: any, replaceId?: string): { changed: boolean; dirPath: string } {
  const ids = [manifest.id, replaceId].filter(Boolean);
  const install = config.installedIntegrations?.find((i: any) => ids.includes(i.manifest?.id));
  if (!install) throw new Error(`${ids.join(" / ")} is not installed in VoiceOS. Install it once from Integration Studio (or pass the installed id with --replace), then run this again.`);
  const server = config.customMcpServers?.find((s: any) => s.id === install.serverId);
  if (!server) throw new Error(`VoiceOS has no MCP server entry ${install.serverId} for ${manifest.id}; reinstall the integration.`);

  const snapshot = () => structuredClone([install.manifest, server.confirmTools, install.configValues, server.env, server.integrationId, server.name]);
  const before = snapshot();
  install.manifest = manifest;
  server.confirmTools = manifest.tools.filter((t: any) => t.confirmation).map((t: any) => t.name);
  if ("integrationId" in server) server.integrationId = manifest.id;
  if ("name" in server && manifest.name) server.name = manifest.name;
  const declared = new Set((manifest.preferences ?? []).map((p: any) => p.name));
  for (const values of [install.configValues, server.env]) {
    for (const key of Object.keys(values ?? {})) if (!declared.has(key)) delete values[key];
  }
  return { changed: !Bun.deepEquals(before, snapshot()), dirPath: install.dirPath };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function isRunning(): boolean {
  if (!IS_WIN) return Bun.spawnSync(["pgrep", "-x", "VoiceOS"]).exitCode === 0;
  const out = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq VoiceOS.exe", "/NH"]).stdout.toString();
  return /VoiceOS\.exe/i.test(out);
}

function backupPath(name: string): string {
  mkdirSync(BACKUPS, { recursive: true });
  return join(BACKUPS, `${name}-${stamp()}`);
}

/** Makes `dirPath` a link to `repoDir` (a junction on Windows), moving whatever was there to the backups folder. */
function linkFolder(dirPath: string, repoDir: string): void {
  // A shortcut is not a link VoiceOS can follow; get it out of the way.
  if (IS_WIN && existsSync(`${dirPath}.lnk`)) {
    const backup = backupPath(`${basename(dirPath)}.lnk`);
    renameSync(`${dirPath}.lnk`, backup);
    console.log(`  moved a Windows shortcut to ${backup} (VoiceOS can't follow .lnk files)`);
  }
  const st = lstatSync(dirPath, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && existsSync(dirPath) && realpathSync(dirPath) === realpathSync(repoDir)) {
    console.log(`✓ ${basename(dirPath)} already links to ${repoDir}`);
    return;
  }
  if (st?.isSymbolicLink()) {
    if (IS_WIN) rmdirSync(dirPath); // a junction is removed like an (empty) directory, never its target
    else unlinkSync(dirPath);
  } else if (st) {
    const backup = backupPath(basename(dirPath));
    renameSync(dirPath, backup);
    console.log(`  moved VoiceOS's copy to ${backup}`);
  }
  symlinkSync(repoDir, dirPath, IS_WIN ? "junction" : undefined);
  console.log(`✓ ${basename(dirPath)} → ${repoDir}`);
}

async function quitVoiceOS(): Promise<void> {
  if (IS_WIN) Bun.spawnSync(["taskkill", "/F", "/T", "/IM", "VoiceOS.exe"]);
  else Bun.spawnSync(["osascript", "-e", 'tell application "VoiceOS" to quit']);
  for (let i = 0; i < 30 && isRunning(); i++) await Bun.sleep(500);
  if (isRunning()) throw new Error("VoiceOS did not quit within 15 s; quit it yourself and run this again.");
}

function findWindowsExe(): string {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "VoiceOS", "VoiceOS.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "VoiceOS", "VoiceOS.exe"),
  ].filter(Boolean) as string[];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) throw new Error(`VoiceOS.exe not found (looked in ${candidates.join(", ")}); start VoiceOS yourself.`);
  return exe;
}

function launchVoiceOS(): void {
  // Launched from a VS Code terminal, Electron inherits ELECTRON_RUN_AS_NODE and exits silently.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (IS_WIN) {
    // `start` detaches it, so VoiceOS outlives this script.
    Bun.spawnSync(["cmd", "/c", "start", "", findWindowsExe()], { env });
  } else {
    Bun.spawnSync(["open", "-a", "VoiceOS"], { env });
  }
}

/** Waits up to `ms` for the relaunched VoiceOS to settle with the patch still in place. */
async function verifyAfterLaunch(manifest: any, replaceId: string | undefined, backup: string, ms = 20000): Promise<void> {
  let last = "";
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    await Bun.sleep(2500);
    try {
      if (!patchConfig(JSON.parse(readFileSync(CONFIG, "utf8")), manifest, replaceId).changed) return;
      last = "the cached manifest differs from the repo's";
    } catch (err: any) {
      last = err.message; // e.g. mid cloud sync: a new serverId whose server entry isn't written yet
    }
  }
  throw new Error(`VoiceOS changed the config on launch (${last}). Run this again; if VoiceOS misbehaves, quit it and restore ${backup}.`);
}

function parseArgs(argv: string[]): { folder?: string; replaceId?: string } {
  const out: { folder?: string; replaceId?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--replace") out.replaceId = argv[++i];
    else if (!out.folder) out.folder = argv[i];
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  if (process.platform !== "darwin" && !IS_WIN) throw new Error("Only macOS and Windows are supported.");
  const { folder, replaceId } = parseArgs(argv);
  if (!folder) throw new Error("Usage: bun scripts/sync-voiceos.ts integrations/<name> [--replace <installed id>]");
  const repoDir = resolve(folder);
  const manifestPath = join(repoDir, "voiceos.integration.json");
  if (!existsSync(manifestPath)) throw new Error(`No voiceos.integration.json in ${repoDir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const { changed, dirPath } = patchConfig(config, manifest, replaceId);
  linkFolder(dirPath, repoDir);
  if (!changed) {
    console.log("✓ VoiceOS's cached manifest is up to date. For code-only changes, restart the integration (or VoiceOS).");
    return;
  }

  const wasRunning = isRunning();
  if (wasRunning) await quitVoiceOS();
  // Re-read after quitting: VoiceOS may have rewritten the file on the way out.
  const fresh = JSON.parse(readFileSync(CONFIG, "utf8"));
  patchConfig(fresh, manifest, replaceId);
  const backup = backupPath("config.json");
  copyFileSync(CONFIG, backup);
  const text = JSON.stringify(fresh, null, "\t");
  JSON.parse(text); // round-trips before it replaces the real file
  writeFileSync(CONFIG, text);
  console.log(`✓ updated the cached manifest (backup: ${backup})`);

  if (wasRunning) {
    launchVoiceOS();
    await verifyAfterLaunch(manifest, replaceId, backup);
    console.log("✓ VoiceOS relaunched with the new manifest");
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
