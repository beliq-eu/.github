// Runs check-hidden-text.mjs as a subprocess against throwaway git repos.
// Run: node --test scripts/check-hidden-text.test.mjs
//
// Every hidden character below is built from its code point at run time, so this file stays
// clean under the check it tests (CI runs the check over this repo too).

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-hidden-text.mjs', import.meta.url).pathname
const c = (codePoint) => String.fromCodePoint(codePoint)

const RLO = c(0x202e)
const ZWSP = c(0x200b)
const BOM = c(0xfeff)
const TAG_A = c(0xe0041)
const LRI = c(0x2066)

const work = mkdtempSync(join(tmpdir(), 'hidden-text-test-'))
after(() => rmSync(work, { recursive: true, force: true }))

// files: { path: content } committed; untracked: { path: content } left out of the index.
function makeRepo(files, untracked = {}) {
  const dir = mkdtempSync(join(work, 'repo-'))
  execFileSync('git', ['init', '-q', dir])
  for (const [path, content] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const paths = Object.keys(files)
  if (paths.length) execFileSync('git', ['-C', dir, 'add', '--', ...paths])
  return dir
}

function run(...dirs) {
  const r = spawnSync(process.execPath, [SCRIPT, ...dirs], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('a clean repo passes', () => {
  const dir = makeRepo({ 'README.md': `# beliq\n\nVisible non-ASCII passes: gr${c(0xfc)}${c(0xdf)}e, ${c(0x20ac)}5.\n` })
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /1 files in 1 repositories, 0 findings/)
})

test('a bidi override fails with file, line, column and code point', () => {
  const dir = makeRepo({ 'src/a.js': `const ok = 1\nif (x) { ${RLO}y }\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, new RegExp(`${basename(dir)}/src/a\\.js:2:10: U\\+202E RIGHT-TO-LEFT OVERRIDE`))
})

test('a zero-width space and an isolate each count', () => {
  const dir = makeRepo({ 'a.md': `one${ZWSP}two ${LRI}three\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /a\.md:1:4: U\+200B ZERO WIDTH SPACE/)
  assert.match(r.err, /a\.md:1:9: U\+2066 LEFT-TO-RIGHT ISOLATE/)
  assert.match(r.out, /2 findings/)
})

test('a tag character fails, counted as one column though it is two UTF-16 units', () => {
  const dir = makeRepo({ 'notes.txt': `ab${TAG_A}c${ZWSP}\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /notes\.txt:1:3: U\+E0041 TAG CHARACTER/)
  assert.match(r.err, /notes\.txt:1:5: U\+200B ZERO WIDTH SPACE/)
})

test('a byte order mark passes at the start of a file and fails anywhere else', () => {
  const lead = makeRepo({ 'data.xml': `${BOM}<?xml version="1.0"?>\n<a/>\n` })
  assert.equal(run(lead).code, 0)

  const inner = makeRepo({ 'data.xml': `<?xml version="1.0"?>\n<a>${BOM}</a>\n` })
  const r = run(inner)
  assert.equal(r.code, 1)
  assert.match(r.err, /data\.xml:2:4: U\+FEFF ZERO WIDTH NO-BREAK SPACE/)
})

test('the output never carries the line text', () => {
  const dir = makeRepo({ 'a.txt': `please-do-not-echo-me ${TAG_A}\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.err + r.out, /please-do-not-echo-me/)
})

test('untracked, binary, vendored and node_modules files are not read', () => {
  const dir = makeRepo(
    {
      'README.md': 'clean\n',
      'blob.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(RLO)]),
      'vendor/lib/x.php': `<?php ${RLO}\n`,
      'node_modules/y/index.js': `${ZWSP}\n`,
    },
    { 'scratch.txt': `${RLO}\n` },
  )
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /1 files in 1 repositories, 0 findings/)
})

test('an allow-listed file passes; comments and blank lines in the list are ignored', () => {
  const dir = makeRepo({
    '.github/hidden-text-allow.txt': '# official fixtures\n\ntests/fixtures/page.html  # snapshot of the source page\n',
    'tests/fixtures/page.html': `<p>${ZWSP}</p>\n`,
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
})

test('an allow-list entry whose file holds nothing hidden any more fails', () => {
  const dir = makeRepo({
    '.github/hidden-text-allow.txt': 'tests/fixtures/page.html\n',
    'tests/fixtures/page.html': '<p>clean now</p>\n',
  })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /hidden-text-allow\.txt: tests\/fixtures\/page\.html holds no hidden character any more/)
})

test('an allow-list entry naming no tracked file fails', () => {
  const dir = makeRepo({ '.github/hidden-text-allow.txt': 'gone.html\n', 'README.md': 'clean\n' })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /hidden-text-allow\.txt: gone\.html is not a tracked file/)
})

test('the allow list exempts only the files it names', () => {
  const dir = makeRepo({
    '.github/hidden-text-allow.txt': 'a.txt\n',
    'a.txt': `${ZWSP}\n`,
    'b.txt': `${ZWSP}\n`,
  })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /b\.txt:1:1: U\+200B/)
  assert.doesNotMatch(r.err, /\/a\.txt:/)
})

test('several repos are checked in one run, each finding prefixed by its repo', () => {
  const clean = makeRepo({ 'a.txt': 'clean\n' })
  const dirty = makeRepo({ 'b.txt': `${RLO}\n` })
  const r = run(clean, dirty)
  assert.equal(r.code, 1)
  assert.match(r.err, new RegExp(`^${basename(dirty)}/b\\.txt:1:1:`, 'm'))
  assert.match(r.out, /2 files in 2 repositories, 1 findings/)
})

test('a run that reads no text file is an error, not a pass', () => {
  const dir = makeRepo({ 'blob.bin': Buffer.from([0, 1, 2]) })
  const r = run(dir)
  assert.equal(r.code, 2)
  assert.match(r.err, /no text file was read/)
})

test('no repo argument is an error', () => {
  const r = run()
  assert.equal(r.code, 2)
  assert.match(r.err, /usage:/)
})
