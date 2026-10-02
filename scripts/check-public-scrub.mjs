#!/usr/bin/env node
// Fails when a public repo carries internal planning material: a roadmap or runbook file, a
// local home path, a link to the private planning store, or a link into a GitHub account
// that is not on the public list in public-scrub.json. Every repo this account owns is
// public, so anything internal that lands in one is published on the next push.
//
// The patterns are generic on purpose. A list of the private names would publish them in
// this file, and the failure output names only the file, line and rule, never the matched
// text, because a public repo's CI log is public too.
//
// Usage: node scripts/check-public-scrub.mjs <repo-dir> [<repo-dir> ...]
// Exit codes: 0 clean, 1 findings, 2 the check itself could not run.
// CI runs it over this repo and a fresh clone of every other one; see
// .github/workflows/ci.yml. A repo can also call .github/workflows/public-scrub.yml.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repo holding this script is the source of the config and of the shared agent files.
const SOURCE_DIR = fileURLToPath(new URL('..', import.meta.url))

// Tracked file names that are internal by kind, wherever they sit.
const NAME_RULES = [
  { rule: 'roadmap file', test: (name) => /roadmap/i.test(name) },
  { rule: 'pass file', test: (name) => /^PASS-/.test(name) },
  { rule: 'submission runbook', test: (name) => /^submission/i.test(name) },
  { rule: 'pull request comment draft', test: (name) => /^pr-comment/i.test(name) },
]

// Each regex is written so that its own source text does not match it, which keeps this
// file clean under its own check.
const LINE_RULES = [
  { rule: 'link to a roadmap file', re: /roadmap\.md/i },
  { rule: 'name of a private planning store', re: /\b[a-z]+-hq\b/ },
  // Not preceded by a host or a word, so `example.com/home/` in a URL does not count.
  { rule: 'local home path', re: /(?<![\w.-])\/home\// },
  { rule: 'local workspace path', re: /~\/Projects/ },
]

const OWNER_RULES = [
  {
    rule: 'link into a GitHub account not on the public list',
    re: /(?:github\.com[/:]|raw\.githubusercontent\.com\/|api\.github\.com\/repos\/)([A-Za-z0-9][A-Za-z0-9-]*)/g,
  },
  {
    rule: 'issue or pull request reference into a GitHub account not on the public list',
    re: /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]*)\/[A-Za-z0-9._-]+#\d+/g,
  },
]

const SKIP_DIR = /(^|\/)(vendor|node_modules)\//

// A lockfile lists the source of every dependency, so its owners are whoever publishes
// them. It is exempt from the owner rules only: a private git dependency cannot be
// installed by a public repo's CI anyway, while a local path in a lockfile is still a leak.
const LOCKFILES = new Set([
  'composer.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'uv.lock',
  'poetry.lock',
])

// Enough to tell a binary file from text, the same window git uses.
const BINARY_SNIFF_BYTES = 8000

async function loadConfig() {
  const config = JSON.parse(await readFile(join(SOURCE_DIR, 'public-scrub.json'), 'utf8'))
  return {
    publicOwners: new Set(config.publicOwners.map((owner) => owner.toLowerCase())),
    agentFiles: config.agentFiles ?? [],
  }
}

function trackedFiles(repoDir) {
  const out = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean)
}

function scanText(text, file, config, report) {
  const lines = text.split('\n')
  const ownerRulesApply = !LOCKFILES.has(basename(file))
  lines.forEach((line, i) => {
    for (const { rule, re } of LINE_RULES) {
      if (re.test(line)) report(file, i + 1, rule)
    }
    if (!ownerRulesApply) return
    for (const { rule, re } of OWNER_RULES) {
      for (const m of line.matchAll(re)) {
        if (!config.publicOwners.has(m[1].toLowerCase())) report(file, i + 1, rule)
      }
    }
  })
}

async function checkRepo(repoDir, config, fail) {
  const repo = basename(resolve(repoDir))
  const report = (file, line, rule) => fail(`${repo}/${file}${line ? `:${line}` : ''}: ${rule}`)
  let scanned = 0

  for (const file of trackedFiles(repoDir)) {
    if (SKIP_DIR.test(file)) continue
    const name = basename(file)
    for (const { rule, test } of NAME_RULES) {
      if (test(name)) report(file, null, rule)
    }
    let buf
    try {
      buf = await readFile(join(repoDir, file))
    } catch (err) {
      // A tracked file deleted in the working tree, or a submodule entry.
      if (err.code === 'ENOENT' || err.code === 'EISDIR') continue
      throw err
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue
    scanText(buf.toString('utf8'), file, config, report)
    scanned++
  }

  for (const file of config.agentFiles) {
    const shared = await readFile(join(SOURCE_DIR, file))
    let own
    try {
      own = await readFile(join(repoDir, file))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      report(file, null, 'missing; every repo carries the shared copy from the .github repo')
      continue
    }
    if (!own.equals(shared)) report(file, null, 'differs from the shared copy in the .github repo')
  }

  return scanned
}

async function main(argv) {
  const repoDirs = argv.slice(2)
  if (repoDirs.length === 0) {
    console.error('usage: check-public-scrub.mjs <repo-dir> [<repo-dir> ...]')
    return 2
  }
  const config = await loadConfig()
  const failures = []
  let files = 0
  for (const dir of repoDirs) files += await checkRepo(dir, config, (msg) => failures.push(msg))

  // A run that read nothing would otherwise look exactly like a clean one.
  if (files === 0) {
    console.error('check-public-scrub: no text file was read; nothing was checked')
    return 2
  }
  for (const msg of failures) console.error(msg)
  console.log(`check-public-scrub: ${files} files in ${repoDirs.length} repositories, ${failures.length} findings`)
  return failures.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main(process.argv)
} catch (err) {
  console.error(`check-public-scrub: ${err.stack ?? err}`)
  process.exitCode = 2
}
