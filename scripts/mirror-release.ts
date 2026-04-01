#!/usr/bin/env bun

import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

type Args = {
  sourceRepo: string;
  targetRepo: string;
  sourceTag?: string;
  targetTag?: string;
  title?: string;
  notes?: string;
  latest: boolean;
  dryRun: boolean;
  help: boolean;
};

type SourceRelease = {
  tagName: string;
  name: string;
  body: string;
  isLatest: boolean;
  assets: Array<{ name: string; size: number }>;
};

const DEFAULT_SOURCE_REPO = "The-Best-Codes/agent-one";
const DEFAULT_TARGET_REPO = "AgentOne-Dev/agent-one-public";
const SEARCH_REPO = "The-Best-Codes/agent-one";
const REPLACE_REPO = "AgentOne-Dev/agent-one-public";

function c(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function info(msg: string): void {
  console.log(`${c("ℹ", 36)} ${msg}`);
}

function ok(msg: string): void {
  console.log(`${c("✓", 32)} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${c("!", 33)} ${msg}`);
}

function fail(msg: string): never {
  console.error(`${c("✗", 31)} ${msg}`);
  process.exit(1);
}

function usage(): void {
  console.log(`
Mirror a release from source GitHub repo to target repo.

Usage:
  bun scripts/mirror-release.ts [options]

Options:
  --source-repo <owner/name>   Source repository (default: ${DEFAULT_SOURCE_REPO})
  --target-repo <owner/name>   Target repository (default: ${DEFAULT_TARGET_REPO})
  --source-tag <tag>           Source tag to mirror (default: latest release)
  --target-tag <tag>           Target release tag (default: source tag)
  --title <title>              Target release title (default: source title)
  --notes <text>               Target release notes/body (default: source body)
  --latest                     Mark target release as latest (default behavior)
  --not-latest                 Do not mark target release as latest
  --dry-run                    Print actions without creating/editing/uploading
  -h, --help                   Show this help
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sourceRepo: DEFAULT_SOURCE_REPO,
    targetRepo: DEFAULT_TARGET_REPO,
    latest: true,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--source-repo":
        if (!next) fail("Missing value for --source-repo");
        args.sourceRepo = next;
        i += 1;
        break;
      case "--target-repo":
        if (!next) fail("Missing value for --target-repo");
        args.targetRepo = next;
        i += 1;
        break;
      case "--source-tag":
        if (!next) fail("Missing value for --source-tag");
        args.sourceTag = next;
        i += 1;
        break;
      case "--target-tag":
        if (!next) fail("Missing value for --target-tag");
        args.targetTag = next;
        i += 1;
        break;
      case "--title":
        if (!next) fail("Missing value for --title");
        args.title = next;
        i += 1;
        break;
      case "--notes":
        if (!next) fail("Missing value for --notes");
        args.notes = next;
        i += 1;
        break;
      case "--latest":
        args.latest = true;
        break;
      case "--not-latest":
        args.latest = false;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        fail(`Unknown argument: ${a}`);
    }
  }

  return args;
}

async function runGh(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function checkGhAvailable(): Promise<void> {
  info("Checking GitHub CLI...");
  try {
    await runGh(["--version"]);
    ok("GitHub CLI is installed");
  } catch (err) {
    fail(`GitHub CLI not found or unusable. Install from https://cli.github.com/.\n${String(err)}`);
  }
}

async function checkGhAuthAndRepoAccess(sourceRepo: string): Promise<void> {
  info("Checking GitHub authentication...");
  try {
    await runGh(["auth", "status"]);
    ok("GitHub CLI is authenticated");
  } catch (err) {
    fail(`GitHub CLI is not authenticated. Run: gh auth login\n${String(err)}`);
  }

  info(`Checking access to ${sourceRepo} releases...`);
  try {
    await runGh(["release", "list", "--repo", sourceRepo, "--limit", "1"]);
    ok(`Release access confirmed for ${sourceRepo}`);
  } catch (err) {
    fail(`Cannot access releases for ${sourceRepo}. Confirm permissions.\n${String(err)}`);
  }
}

async function getSourceRelease(sourceRepo: string, sourceTag?: string): Promise<SourceRelease> {
  info(sourceTag ? `Fetching source release ${sourceTag}...` : "Fetching latest source release...");
  const format = ["--json", "tagName,name,body,isLatest,assets"];
  const args = sourceTag
    ? ["release", "view", sourceTag, "--repo", sourceRepo, ...format]
    : ["release", "view", "--repo", sourceRepo, ...format];
  const { stdout } = await runGh(args);
  const raw = JSON.parse(stdout) as {
    tagName: string;
    name: string | null;
    body: string | null;
    isLatest: boolean;
    assets: Array<{ name: string; size: number }>;
  };

  const release: SourceRelease = {
    tagName: raw.tagName,
    name: raw.name ?? raw.tagName,
    body: raw.body ?? "",
    isLatest: raw.isLatest,
    assets: raw.assets ?? [],
  };
  ok(`Using source release ${release.tagName} (${release.assets.length} asset(s))`);
  return release;
}

async function downloadAssets(sourceRepo: string, tag: string, dir: string): Promise<string[]> {
  info("Downloading release assets...");
  await runGh(["release", "download", tag, "--repo", sourceRepo, "--dir", dir, "--clobber"]);
  const entries = await readdir(dir);
  const files = entries.map((name) => join(dir, name));
  ok(`Downloaded ${files.length} file(s) to ${dir}`);
  return files;
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  let suspicious = 0;
  const max = Math.min(buffer.length, 2048);
  for (let i = 0; i < max; i += 1) {
    const b = buffer[i];
    if (b === 0) return false;
    if (b < 7 || (b > 14 && b < 32)) suspicious += 1;
  }
  return suspicious / max < 0.1;
}

async function rewriteRepoRefs(filePaths: string[]): Promise<number> {
  info(`Rewriting "${SEARCH_REPO}" -> "${REPLACE_REPO}" in text assets...`);
  let changed = 0;
  for (const p of filePaths) {
    const st = await stat(p);
    if (!st.isFile()) continue;
    const buf = await readFile(p);
    if (!looksLikeText(buf)) continue;
    const text = buf.toString("utf8");
    const updated = text.split(SEARCH_REPO).join(REPLACE_REPO);
    if (updated !== text) {
      await writeFile(p, updated, "utf8");
      changed += 1;
    }
  }
  ok(`Updated ${changed} text file(s)`);
  return changed;
}

async function releaseExists(targetRepo: string, tag: string): Promise<boolean> {
  try {
    await runGh(["release", "view", tag, "--repo", targetRepo, "--json", "tagName"]);
    return true;
  } catch {
    return false;
  }
}

async function ensureTargetRelease(args: {
  targetRepo: string;
  tag: string;
  title: string;
  notes: string;
  latest: boolean;
  dryRun: boolean;
}): Promise<void> {
  const exists = await releaseExists(args.targetRepo, args.tag);
  const latestFlag = args.latest ? "--latest" : "--latest=false";
  if (exists) {
    info(`Target release ${args.tag} exists, updating metadata...`);
    if (args.dryRun) {
      warn(
        `[dry-run] gh release edit ${args.tag} --repo ${args.targetRepo} --title <...> --notes <...> ${latestFlag}`,
      );
      return;
    }
    await runGh([
      "release",
      "edit",
      args.tag,
      "--repo",
      args.targetRepo,
      "--title",
      args.title,
      "--notes",
      args.notes,
      latestFlag,
    ]);
    ok(`Updated target release ${args.tag}`);
    return;
  }

  info(`Creating target release ${args.tag}...`);
  if (args.dryRun) {
    warn(
      `[dry-run] gh release create ${args.tag} --repo ${args.targetRepo} --title <...> --notes <...> ${latestFlag}`,
    );
    return;
  }
  await runGh([
    "release",
    "create",
    args.tag,
    "--repo",
    args.targetRepo,
    "--title",
    args.title,
    "--notes",
    args.notes,
    latestFlag,
  ]);
  ok(`Created target release ${args.tag}`);
}

async function uploadAssets(
  targetRepo: string,
  tag: string,
  filePaths: string[],
  dryRun: boolean,
): Promise<void> {
  if (filePaths.length === 0) {
    warn("No assets found to upload");
    return;
  }
  info(`Uploading ${filePaths.length} asset(s) to ${targetRepo}@${tag}...`);
  if (dryRun) {
    warn(
      `[dry-run] gh release upload ${tag} <${filePaths.length} files> --repo ${targetRepo} --clobber`,
    );
    return;
  }
  await runGh(["release", "upload", tag, ...filePaths, "--repo", targetRepo, "--clobber"]);
  ok("Assets uploaded");
}

async function ensureWritable(path: string): Promise<void> {
  try {
    await access(path, fsConstants.W_OK);
  } catch (err) {
    fail(`No write permission for directory: ${path}\n${String(err)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  console.log(c("\nRelease Mirror (Bun)\n", 35));
  await checkGhAvailable();
  await checkGhAuthAndRepoAccess(args.sourceRepo);
  await ensureWritable(tmpdir());

  const source = await getSourceRelease(args.sourceRepo, args.sourceTag);

  const targetTag = args.targetTag ?? source.tagName;
  const targetTitle = args.title ?? source.name;
  const targetNotes = args.notes ?? source.body;
  const targetLatest = args.latest;

  const workDir = await mkdtemp(join(tmpdir(), "agent-one-release-"));
  info(`Temporary workspace: ${workDir}`);

  try {
    const files = await downloadAssets(args.sourceRepo, source.tagName, workDir);
    await rewriteRepoRefs(files);
    await ensureTargetRelease({
      targetRepo: args.targetRepo,
      tag: targetTag,
      title: targetTitle,
      notes: targetNotes,
      latest: targetLatest,
      dryRun: args.dryRun,
    });
    await uploadAssets(args.targetRepo, targetTag, files, args.dryRun);
    ok(
      `Done. Mirrored ${basename(args.sourceRepo)}:${source.tagName} -> ${basename(args.targetRepo)}:${targetTag}${
        args.dryRun ? " (dry-run)" : ""
      }`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
    info("Temporary workspace cleaned up");
  }
}

main().catch((err) => {
  fail(String(err instanceof Error ? err.message : err));
});
