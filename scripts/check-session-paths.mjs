#!/usr/bin/env node
// Fails when a tracked text file names a Claude Code plan file or session transcript. Claude
// Code deletes both once they are older than `cleanupPeriodDays`, 30 days by default
// (https://code.claude.com/docs/en/claude-directory, "Cleaned up automatically"), and they
// exist only on the machine that wrote them. A committed path to one is a link that CI, every
// other machine and every later reader cannot follow, and that a month later leads nowhere on
// the writer's machine either. Whatever the reader needs from such a file belongs in the
// repo itself.
//
// Two paths count: `plans/` under `~/.claude`, and `projects/` under it anywhere but a
// project's `memory/` directory, which the sweep leaves alone. The tilde, the home directory
// and a relative prefix are all caught, since every spelling contains the same
// `.claude`-and-subdirectory part.
//
// A file that has to keep such a path, a dated snapshot that records what was true then for
// instance, is listed in the repo's .github/session-paths-allow.txt: one path per line, `#`
// starts a comment. An entry whose file no longer names such a path fails as well, so the
// list cannot outlive its reason.
//
// Usage: node scripts/check-session-paths.mjs <repo-dir> [<repo-dir> ...]
// Exit codes: 0 clean, 1 findings, 2 the check itself could not run.
// The output names the file, line and rule, never the line's text.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

// The escaped slashes keep each regex's own source text from matching it, so this file stays
// clean under its own check.
const RULES = [
  { rule: 'path to a Claude Code plan file', re: /\.claude\/plans\// },
  {
    rule: 'path to a Claude Code session transcript',
    re: /\.claude\/projects\/(?![^/\s]*\/memory(?:\/|$|[^\w-]))/,
  },
]

const ALLOW_FILE = '.github/session-paths-allow.txt'

// The same exemption as check-public-scrub.mjs: vendored code is not ours to rewrite.
const SKIP_DIR = /(^|\/)(vendor|node_modules)\//

// Enough to tell a binary file from text, the same window git uses.
const BINARY_SNIFF_BYTES = 8000

function trackedFiles(repoDir) {
  const out = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean)
}

// Each hit as { line, rule }.
function findPaths(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const { rule, re } of RULES) {
      if (re.test(line)) hits.push({ line: i + 1, rule })
    }
  })
  return hits
}

async function readAllowList(repoDir) {
  let text
  try {
    text = await readFile(join(repoDir, ALLOW_FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
}

async function checkRepo(repoDir, fail) {
  const repo = basename(resolve(repoDir))
  const allowed = new Set(await readAllowList(repoDir))
  const holding = new Set()
  const tracked = trackedFiles(repoDir)
  let scanned = 0

  for (const file of tracked) {
    if (SKIP_DIR.test(file)) continue
    let buf
    try {
      buf = await readFile(join(repoDir, file))
    } catch (err) {
      // A tracked file deleted in the working tree, or a submodule entry.
      if (err.code === 'ENOENT' || err.code === 'EISDIR') continue
      throw err
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue
    scanned++
    const hits = findPaths(buf.toString('utf8'))
    if (hits.length === 0) continue
    holding.add(file)
    if (allowed.has(file)) continue
    for (const { line, rule } of hits) fail(`${repo}/${file}:${line}: ${rule}`)
  }

  const trackedSet = new Set(tracked)
  for (const file of allowed) {
    if (!trackedSet.has(file)) {
      fail(`${repo}/${ALLOW_FILE}: ${file} is not a tracked file`)
    } else if (!holding.has(file)) {
      fail(`${repo}/${ALLOW_FILE}: ${file} names no such path any more; remove the entry`)
    }
  }

  return scanned
}

async function main(argv) {
  const repoDirs = argv.slice(2)
  if (repoDirs.length === 0) {
    console.error('usage: check-session-paths.mjs <repo-dir> [<repo-dir> ...]')
    return 2
  }
  const failures = []
  let files = 0
  for (const dir of repoDirs) files += await checkRepo(dir, (msg) => failures.push(msg))

  // A run that read nothing would otherwise look exactly like a clean one.
  if (files === 0) {
    console.error('check-session-paths: no text file was read; nothing was checked')
    return 2
  }
  for (const msg of failures) console.error(msg)
  console.log(`check-session-paths: ${files} files in ${repoDirs.length} repositories, ${failures.length} findings`)
  return failures.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main(process.argv)
} catch (err) {
  console.error(`check-session-paths: ${err.stack ?? err}`)
  process.exitCode = 2
}
