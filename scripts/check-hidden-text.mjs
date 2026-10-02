#!/usr/bin/env node
// Fails when a tracked text file holds a character that changes how text reads without
// showing itself: a bidirectional control or mark, a zero-width character, or a Unicode tag
// character. A bidi override makes a reviewer see code in a different order than the
// compiler does (CVE-2021-42574), and tag characters spell out text an agent reads but a
// person reviewing the diff cannot see.
//
// A byte order mark at the very start of a file is allowed; anywhere else it is a zero-width
// no-break space.
//
// A file that has to hold one of these characters, an official fixture for instance, is
// listed in the repo's .github/hidden-text-allow.txt: one path per line, `#` starts a
// comment. An entry whose file no longer holds such a character fails as well, so the list
// cannot outlive its reason.
//
// Usage: node scripts/check-hidden-text.mjs <repo-dir> [<repo-dir> ...]
// Exit codes: 0 clean, 1 findings, 2 the check itself could not run.
// The output names the file, line, column and code point, never the line's text.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const NAMES = new Map([
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
])

// Built from the code points above at run time, so this file holds none of the characters
// it looks for.
const TAG_FIRST = 0xe0000
const TAG_LAST = 0xe007f
const HIDDEN = new RegExp(
  `[${[...NAMES.keys()].map((cp) => String.fromCodePoint(cp)).join('')}]` +
    `|[${String.fromCodePoint(TAG_FIRST)}-${String.fromCodePoint(TAG_LAST)}]`,
  'u',
)

const ALLOW_FILE = '.github/hidden-text-allow.txt'

// The same exemption as check-public-scrub.mjs: vendored code is not ours to rewrite.
const SKIP_DIR = /(^|\/)(vendor|node_modules)\//

// Enough to tell a binary file from text, the same window git uses.
const BINARY_SNIFF_BYTES = 8000

function trackedFiles(repoDir) {
  const out = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean)
}

function describe(codePoint) {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, '0')
  const name = NAMES.get(codePoint) ?? 'TAG CHARACTER'
  return `U+${hex} ${name}`
}

// Each hit as { line, column, codePoint }, with the column counted in code points.
function findHidden(text) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (!HIDDEN.test(line)) return
    let column = 0
    for (const char of line) {
      column++
      const codePoint = char.codePointAt(0)
      if (i === 0 && column === 1 && codePoint === 0xfeff) continue
      if (HIDDEN.test(char)) hits.push({ line: i + 1, column, codePoint })
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
    const hits = findHidden(buf.toString('utf8'))
    if (hits.length === 0) continue
    holding.add(file)
    if (allowed.has(file)) continue
    for (const { line, column, codePoint } of hits) {
      fail(`${repo}/${file}:${line}:${column}: ${describe(codePoint)}`)
    }
  }

  const trackedSet = new Set(tracked)
  for (const file of allowed) {
    if (!trackedSet.has(file)) {
      fail(`${repo}/${ALLOW_FILE}: ${file} is not a tracked file`)
    } else if (!holding.has(file)) {
      fail(`${repo}/${ALLOW_FILE}: ${file} holds no hidden character any more; remove the entry`)
    }
  }

  return scanned
}

async function main(argv) {
  const repoDirs = argv.slice(2)
  if (repoDirs.length === 0) {
    console.error('usage: check-hidden-text.mjs <repo-dir> [<repo-dir> ...]')
    return 2
  }
  const failures = []
  let files = 0
  for (const dir of repoDirs) files += await checkRepo(dir, (msg) => failures.push(msg))

  // A run that read nothing would otherwise look exactly like a clean one.
  if (files === 0) {
    console.error('check-hidden-text: no text file was read; nothing was checked')
    return 2
  }
  for (const msg of failures) console.error(msg)
  console.log(`check-hidden-text: ${files} files in ${repoDirs.length} repositories, ${failures.length} findings`)
  return failures.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main(process.argv)
} catch (err) {
  console.error(`check-hidden-text: ${err.stack ?? err}`)
  process.exitCode = 2
}
