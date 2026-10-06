#!/usr/bin/env node
// Stamp a build version into every file that carries one, so a build can take
// its version from git instead of a hand-edited constant.
//
//   node tools/stamp-version.mjs --mode dev --hash a1b2c3d --build 42
//   node tools/stamp-version.mjs --mode release --tag v1.2.3
//
// Touches package.json, package-lock.json, src-tauri/Cargo.toml,
// src-tauri/Cargo.lock, src-tauri/tauri.conf.json and installer/openaula.iss.
//
// Everything is edited as text, never by re-serialising parsed JSON: a round
// trip through JSON.stringify reflows formatting (`"targets": ["nsis"]` grows
// into a five-line array) and rewrites line endings, which shows up as a diff
// that has nothing to do with the version.
//
// The patterns below allow CRLF. This checkout uses CRLF in the working tree,
// and a pattern like `"name"\n"version"` does *not* match `"name"\r\n"version"`.
//
// Two versions come out of this, and both are needed:
//
//   display  free-form semver. Tauri validates it, so a bare commit hash is not
//            allowed - a dev build is `<base>-dev.<hash>`.
//   numeric  four dotted integers. Windows PE resources and Inno Setup's
//            VersionInfoVersion cannot hold a prerelease suffix, so the hash
//            cannot go here; a dev build uses the CI run number as the fourth
//            component instead, which at least orders builds.
//
// When GITHUB_OUTPUT is set the results are appended to it as step outputs.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const write = (rel, text) => writeFileSync(join(root, rel), text);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/// Replace, and fail loudly when the field is not there at all. Presence is
/// decided by the pattern matching, not by the text changing: stamping a file
/// that already carries the target version is a no-op, not an error.
function replaceOrThrow(rel, text, re, replacement, what) {
  if (!re.test(text)) throw new Error(`${rel}: no ${what} found`);
  return text.replace(re, replacement);
}

/// Replace a top-level `"version": "…"` at the given indent. npm and Tauri both
/// write these files with two-space indent, so the indentation identifies the
/// field without parsing anything.
function stampJson(rel, display, indents) {
  let text = read(rel);
  for (const n of indents) {
    text = replaceOrThrow(
      rel,
      text,
      new RegExp(`(\\r?\\n${" ".repeat(n)}"version": ")[^"]*(")`),
      `$1${display}$2`,
      `version at indent ${n}`,
    );
  }
  write(rel, text);
}

// --- the two versions -----------------------------------------------------

const mode = arg("mode", "dev");

// Strip any previous dev suffix: stamping twice must not produce
// "1.0.0-dev.aaa-dev.bbb".
const base = (arg("base") ?? /"version": "([^"]*)"/.exec(read("package.json"))[1]).split("-")[0];
if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`bad base version: ${base}`);

let display;
let numeric;

if (mode === "release") {
  const tag = arg("tag");
  if (!tag) throw new Error("--mode release needs --tag");
  display = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(display)) throw new Error(`tag ${tag} is not a plain x.y.z`);
  numeric = `${display}.0`;
} else if (mode === "dev") {
  const hash = arg("hash");
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error(`bad --hash: ${hash}`);
  display = `${base}-dev.${hash}`;
  numeric = `${base}.${arg("build", "0")}`;
} else {
  throw new Error(`unknown --mode ${mode}`);
}

// --- stamp ----------------------------------------------------------------

stampJson("package.json", display, [2]);
stampJson("package-lock.json", display, [2, 6]); // root entry and packages[""]
stampJson("src-tauri/tauri.conf.json", display, [2]);

write(
  "src-tauri/Cargo.toml",
  replaceOrThrow("src-tauri/Cargo.toml", read("src-tauri/Cargo.toml"), /^version = "[^"]*"$/m, `version = "${display}"`, "version line"),
);

// Cargo rewrites its own entry on the next build, but nothing rewrites it back,
// so a dev stamp would leave the lock dirty until some later version bump.
write(
  "src-tauri/Cargo.lock",
  replaceOrThrow(
    "src-tauri/Cargo.lock",
    read("src-tauri/Cargo.lock"),
    /(\r?\nname = "openaula"\r?\nversion = ")[^"]*(")/,
    `$1${display}$2`,
    "openaula entry",
  ),
);

{
  const rel = "installer/openaula.iss";
  let text = read(rel);
  text = replaceOrThrow(rel, text, /^#define AppVersion "[^"]*"$/m, `#define AppVersion "${display}"`, "AppVersion define");
  text = replaceOrThrow(rel, text, /^#define AppVersionNumeric "[^"]*"$/m, `#define AppVersionNumeric "${numeric}"`, "AppVersionNumeric define");
  write(rel, text);
}

const out = { display, numeric, base };
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(""));
}
