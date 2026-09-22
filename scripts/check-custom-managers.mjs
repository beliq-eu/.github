#!/usr/bin/env node
// Proves that every Renovate marker comment in the beliq-eu repos is actually read by a
// manager, and that every `npm install -g npm@<version>` line carries one.
//
// renovate-config-validator checks that default.json is well formed. It never opens a
// consuming repo, so it cannot tell a working manager from one whose file pattern matches
// nothing. That gap is what this script closes, and it is the gap the npm pin fell into:
// the pin was added 2026-09-19 and no manager read it until 2026-09-22.
//
// Usage: node scripts/check-custom-managers.mjs <repo-dir> [<repo-dir> ...]
// CI clones every beliq-eu repo and passes them all; see .github/workflows/ci.yml.

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

const PRESET = new URL('../default.json', import.meta.url)

// A marker comment, anchored to a comment position so the literal does not also count
// where it is quoted: renovate.json holds it inside matchStrings, and a test holds it
// inside a regex. Marker positions are compared against the manager's own match positions,
// so a marker the regex cannot read is a failure rather than a silent drop-out.
const MARKER = 'renovate: datasource='
const MARKER_LINE = /^[ \t]*(?:#|\/\/)[ \t]*renovate: datasource=/gm

// Byte offsets of every marker comment's `renovate:` keyword, which is where the manager's
// regex starts matching.
function markerOffsets(content) {
  return [...content.matchAll(MARKER_LINE)].map((m) => m.index + m[0].indexOf(MARKER))
}

// The pin shape 7c introduced in seven release workflows. No built-in manager reads a
// version inside a `run:` line, so each of these needs a marker comment to stay current.
const NPM_PIN = /npm install -g npm@(\d+\.\d+\.\d+)/g

// Renovate's `github-actions` manager already extracts this action's `version:` input as a
// `uses-with` dependency (verified 2026-09-22 against beliq-sdk-python: three sites, all
// three proposed 0.12.17 when lowered to 0.12.10). A marker here would be read a second
// time by the custom manager and reported as a duplicate dependency.
const ALREADY_MANAGED = [{ uses: 'astral-sh/setup-uv@', withinLines: 6 }]

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', 'coverage'])
const TEXT_FILE = /\.(ya?ml|json|mjs|cjs|js|ts|sh|toml|md)$/

const failures = []
const fail = (repo, file, message) => failures.push(`${repo}${file ? `/${file}` : ''}: ${message}`)

// A `managerFilePatterns` entry is either `/regex/` or a glob. Only the regex form is
// convertible, so a glob is rejected instead of being half-read.
function toRegExp(pattern, repo) {
  const m = /^\/(.+)\/$/.exec(pattern)
  if (!m) {
    fail(repo, null, `managerFilePatterns entry is not a /regex/: ${pattern}`)
    return null
  }
  try {
    return new RegExp(m[1])
  } catch (err) {
    fail(repo, null, `managerFilePatterns entry is not a valid regex: ${pattern} (${err.message})`)
    return null
  }
}

async function loadManagers(repoDir, repo) {
  const managers = []
  const add = (source, list) => {
    for (const m of list ?? []) {
      if (m.customType !== 'regex') continue
      const patterns = m.managerFilePatterns?.map((p) => toRegExp(p, repo)).filter(Boolean) ?? []
      for (const raw of m.matchStrings ?? []) managers.push({ source, patterns, raw })
    }
  }
  add('default.json', JSON.parse(await readFile(PRESET, 'utf8')).customManagers)
  try {
    add('renovate.json', JSON.parse(await readFile(join(repoDir, 'renovate.json'), 'utf8')).customManagers)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return managers
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), base, out)
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      out.push(relative(base, join(dir, entry.name)))
    }
  }
  return out
}

function matchesIn(manager, content) {
  // A fresh regex per call: /g carries lastIndex between uses.
  return [...content.matchAll(new RegExp(manager.raw, 'g'))]
}

async function checkRepo(repoDir) {
  const repo = basename(repoDir)
  const managers = await loadManagers(repoDir, repo)
  if (managers.length === 0) fail(repo, null, 'no regex custom manager applies, not even the shared one')

  let markedSites = 0
  let npmPins = 0

  for (const file of await walk(repoDir)) {
    const content = await readFile(join(repoDir, file), 'utf8')
    const markers = markerOffsets(content)
    const claiming = managers.filter((m) => m.patterns.some((p) => p.test(file)))

    if (markers.length > 0) {
      if (claiming.length === 0) {
        fail(repo, file, `carries ${markers.length} marker comment(s) that no manager's file pattern claims`)
        continue
      }
      const read = new Set()
      for (const manager of claiming) {
        for (const match of matchesIn(manager, content)) {
          if (!markers.includes(match.index)) continue
          const { datasource, depName, currentValue } = match.groups ?? {}
          if (!datasource || !depName || !currentValue) {
            fail(repo, file, `${manager.source} matched but left a group empty: ${JSON.stringify(match.groups)}`)
            continue
          }
          read.add(match.index)
        }
      }
      const unread = markers.filter((o) => !read.has(o))
      if (unread.length > 0) {
        const lines = unread.map((o) => content.slice(0, o).split('\n').length)
        fail(repo, file, `marker comment on line ${lines.join(', ')} is not read by ${claiming.map((c) => c.source).join(' + ')}`)
      }
      markedSites += read.size
    }

    for (const [, version] of content.matchAll(NPM_PIN)) {
      npmPins += 1
      const site = claiming.flatMap((m) => matchesIn(m, content)).find((x) => x.groups?.currentValue === version)
      if (!site) {
        fail(repo, file, `pins npm@${version} in a run: line that no manager reads; add a marker comment above it`)
      } else if (site.groups.depName !== 'npm' || site.groups.datasource !== 'npm') {
        fail(repo, file, `the marker above npm@${version} reads ${site.groups.datasource}/${site.groups.depName}, not npm/npm`)
      }
    }

    for (const { uses, withinLines } of ALREADY_MANAGED) {
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        if (!line.includes(uses)) return
        const window = lines.slice(i + 1, i + 1 + withinLines).join('\n')
        if (markerOffsets(window).length > 0) {
          fail(repo, file, `a marker comment sits under ${uses}, whose version the github-actions manager already reads as a uses-with dependency`)
        }
      })
    }
  }

  return { repo, managers: managers.length, markedSites, npmPins }
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('usage: node scripts/check-custom-managers.mjs <repo-dir> [<repo-dir> ...]')
  process.exit(2)
}
for (const dir of dirs) {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) {
    console.error(`not a directory: ${dir}`)
    process.exit(2)
  }
}

const rows = []
for (const dir of dirs) rows.push(await checkRepo(dir))

for (const r of rows) {
  console.log(`${r.repo.padEnd(26)} managers=${r.managers}  markers read=${r.markedSites}  npm pins=${r.npmPins}`)
}

const totalMarkers = rows.reduce((n, r) => n + r.markedSites, 0)
const totalPins = rows.reduce((n, r) => n + r.npmPins, 0)
// A run that found nothing is a run that checked nothing: wrong directories, or a file
// pattern that stopped matching. Both look identical to a pass otherwise.
if (totalMarkers === 0) fail('(all)', null, `no marker comment read in any of the ${dirs.length} directories`)
if (totalPins === 0) fail('(all)', null, `no npm install -g npm@ pin found in any of the ${dirs.length} directories`)

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`\nok: ${totalMarkers} marker comment(s) read, ${totalPins} npm pin(s) covered, across ${dirs.length} repo(s)`)
