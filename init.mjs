#!/usr/bin/env node
// init.mjs — instantiate the framework template into a project repo.
//
//   node init.mjs <target-dir> --project <devmanager-project-id> --name <project-name>
//                              [--force] [--dry-run]
//
// Copies `template/` into <target-dir>, substitutes the placeholders, appends
// `.gitignore.append` to the target's `.gitignore`, and prints the manual
// follow-ups. Idempotent by refusing to overwrite: an existing destination file
// aborts the whole run before anything is written, unless --force.
//
// Node only, no dependencies, path.join everywhere: this runs on Windows and on
// Linux and the two disagree about almost everything else.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** {{PLACEHOLDER}} in the template → field of the values object. */
export const PLACEHOLDERS = {
  DEVMANAGER_PROJECT_ID: "project",
  PROJECT_NAME: "name",
};

/** The file that is appended to the target's .gitignore instead of copied. */
export const GITIGNORE_APPEND = ".gitignore.append";

/** Copied byte-for-byte, without placeholder substitution. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
]);

export function parseArgs(argv) {
  const positional = [];
  const flags = { force: false, dryRun: false, help: false };
  const options = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") flags.force = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${key} needs a value.`);
      options[key] = value;
    } else positional.push(arg);
  }

  if (flags.help) return { help: true };

  const [target] = positional;
  if (!target) throw new Error("A target directory is required.");
  if (positional.length > 1)
    throw new Error(`Unexpected argument: ${positional[1]}`);
  if (!options.project)
    throw new Error("--project <devmanager-project-id> is required.");
  if (!options.name) throw new Error("--name <project-name> is required.");

  return {
    target,
    project: options.project,
    name: options.name,
    force: flags.force,
    dryRun: flags.dryRun,
  };
}

/** Replace every placeholder this tool knows about. Unknown ones are left alone. */
export function render(text, values) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    const field = PLACEHOLDERS[key];
    return field && values[field] !== undefined ? values[field] : match;
  });
}

/** Every file under `dir`, as paths relative to it, with forward slashes. */
export function listTemplateFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...listTemplateFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * What the run would do, decided before any of it happens: which files land
 * where, which already exist, and which .gitignore lines are missing.
 */
export function plan({ templateDir, targetDir, values, force = false }) {
  const files = [];
  const conflicts = [];

  for (const rel of listTemplateFiles(templateDir)) {
    if (rel === GITIGNORE_APPEND) continue;
    const segments = rel.split("/");
    const source = path.join(templateDir, ...segments);
    const destination = path.join(targetDir, ...segments);
    const binary = BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase());
    const exists = existsSync(destination);
    if (exists && !force) conflicts.push(rel);
    files.push({ rel, source, destination, binary, exists });
  }

  return {
    files,
    conflicts,
    gitignore: planGitignore({ templateDir, targetDir }),
    values,
  };
}

export function planGitignore({ templateDir, targetDir }) {
  const source = path.join(templateDir, GITIGNORE_APPEND);
  if (!existsSync(source)) return null;
  const addition = readFileSync(source, "utf8");
  const destination = path.join(targetDir, ".gitignore");
  const current = existsSync(destination)
    ? readFileSync(destination, "utf8")
    : "";
  return { destination, ...mergeGitignore(current, addition) };
}

/**
 * Append only the lines that are not ignored already. Running init twice must
 * not grow the file, so a line present anywhere in it is skipped and a block
 * that would add nothing is not appended at all.
 */
export function mergeGitignore(current, addition) {
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const lines = addition.split(/\r?\n/);
  const missing = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#") && !present.has(trimmed);
  });

  if (missing.length === 0) return { changed: false, content: current, added: [] };

  // Keep the comment header with the lines it introduces — but only the ones
  // actually missing, so a partial re-run does not duplicate the rest.
  const header = lines.filter((line) => line.trim().startsWith("#"));
  const block = ["", ...header, ...missing].join("\n");
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  return { changed: true, content: `${current}${separator}${block}\n`, added: missing };
}

export function apply(planned, { dryRun = false } = {}) {
  const written = [];
  for (const file of planned.files) {
    written.push(file.rel);
    if (dryRun) continue;
    mkdirSync(path.dirname(file.destination), { recursive: true });
    if (file.binary) writeFileSync(file.destination, readFileSync(file.source));
    else
      writeFileSync(
        file.destination,
        render(readFileSync(file.source, "utf8"), planned.values),
      );
  }

  const gitignore = planned.gitignore;
  if (gitignore?.changed && !dryRun) {
    mkdirSync(path.dirname(gitignore.destination), { recursive: true });
    writeFileSync(gitignore.destination, gitignore.content);
  }

  return { written, gitignoreChanged: Boolean(gitignore?.changed) };
}

export const FOLLOW_UPS = [
  "Authenticate the MCP: run /mcp inside the project and log in to devmanager.",
  "Run /sync-docs to fill .claude/docs/ and the managed section of CLAUDE.md from DevManager.",
  "Review .claude/settings.json permissions against this project's stack — the test, lint, typecheck and build commands in it are placeholders.",
];

export function usage() {
  return [
    "node init.mjs <target-dir> --project <devmanager-project-id> --name <project-name>",
    "",
    "  --project   DevManager project id this repo works for",
    "  --name      Human name of the project, as it reads in DevManager",
    "  --force     Overwrite files that already exist in the target",
    "  --dry-run   Print what would happen and write nothing",
  ].join("\n");
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const templateDir = path.join(here, "template");
  const targetDir = path.resolve(args.target);

  const planned = plan({
    templateDir,
    targetDir,
    values: { project: args.project, name: args.name },
    force: args.force,
  });

  if (planned.conflicts.length > 0) {
    error("Refusing to overwrite files that already exist:\n");
    for (const rel of planned.conflicts) error(`  ${rel}`);
    error("\nPass --force to overwrite them, or remove them first.");
    return 1;
  }

  const result = apply(planned, { dryRun: args.dryRun });
  const verb = args.dryRun ? "Would write" : "Wrote";
  log(`${verb} ${result.written.length} file(s) into ${targetDir}:\n`);
  for (const rel of result.written) log(`  ${rel}`);
  if (result.gitignoreChanged)
    log(`\n${verb} ${planned.gitignore.added.length} line(s) to .gitignore.`);
  else log("\n.gitignore already covers what the framework ignores.");

  log("\nThree things left to do by hand:\n");
  FOLLOW_UPS.forEach((line, i) => log(`  ${i + 1}. ${line}`));
  return 0;
}

// Only when invoked directly, so the tests can import the pieces.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exit(1);
  }
}
