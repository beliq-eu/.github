// Runs check-session-paths.mjs as a subprocess against throwaway git repos.
// Run: node --test scripts/check-session-paths.test.mjs
//
// Every path the check looks for is joined from its parts at run time, so this file stays
// clean under the check it tests (CI runs the check over this repo too).

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-session-paths.mjs', import.meta.url).pathname
const THIS_FILE = new URL(import.meta.url).pathname

// under('~', 'plans', 'x.md') is the home-relative path to a plan named x.md.
const under = (prefix, ...parts) => [prefix, '.claude', ...parts].join('/')

// Joined too, since the public scrub reads a literal home path in this file as a leak.
const HOME = ['', 'home', 'someone'].join('/')
const PLAN = under('~', 'plans', 'lets-go-live-starry-cook.md')
const SESSION = '0f3c2a71-5d4e-4b8a-9c61-2e7f80a4d913'
const PROJECT = '-home-someone-Projects-beliq'

const work = mkdtempSync(join(tmpdir(), 'session-paths-test-'))
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

test('a clean repo passes, durable paths under the same directory included', () => {
  const dir = makeRepo({
    'README.md': [
      '# beliq',
      `Settings live in \`${under('~', 'settings.json')}\`, hooks in \`${under('~', 'hooks')}/\`.`,
      `Skills: ${under('.', 'skills', 'plan-pass', 'SKILL.md')}`,
      '',
    ].join('\n'),
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /1 files in 1 repositories, 0 findings/)
})

test('a plan path fails with file, line and rule, in every spelling', () => {
  const dir = makeRepo({
    'docs/a.md': [
      'intro',
      `The decision is in \`${PLAN}\`.`,
      `Copied from ${under(HOME, 'plans', 'x.md')}`,
      `[plan](${under('../..', 'plans', 'x.md')})`,
      '',
    ].join('\n'),
  })
  const r = run(dir)
  assert.equal(r.code, 1)
  for (const line of [2, 3, 4]) {
    assert.match(r.err, new RegExp(`${basename(dir)}/docs/a\\.md:${line}: path to a Claude Code plan file`))
  }
  assert.match(r.out, /3 findings/)
})

test('a session transcript, its subagents and its tool results each fail', () => {
  const dir = makeRepo({
    'notes.md': [
      under('~', 'projects', PROJECT, `${SESSION}.jsonl`),
      under('~', 'projects', PROJECT, SESSION, 'subagents', 'agent-1.jsonl'),
      under(HOME, 'projects', PROJECT, SESSION, 'tool-results', 'out.txt'),
      '',
    ].join('\n'),
  })
  const r = run(dir)
  assert.equal(r.code, 1)
  for (const line of [1, 2, 3]) {
    assert.match(r.err, new RegExp(`notes\\.md:${line}: path to a Claude Code session transcript`))
  }
})

test('the directory alone, with its trailing slash, fails too', () => {
  const dir = makeRepo({ 'a.md': `Plans sit in ${under('~', 'plans')}/ and sessions in ${under('~', 'projects')}/.\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /a\.md:1: path to a Claude Code plan file/)
  assert.match(r.err, /a\.md:1: path to a Claude Code session transcript/)
})

test("a project's memory directory passes", () => {
  const dir = makeRepo({
    'a.md': [
      under('~', 'projects', PROJECT, 'memory', 'MEMORY.md'),
      `\`${under('~', 'projects', '<project>', 'memory')}\``,
      `[note](${under('../..', 'projects', PROJECT, 'memory', 'note.md')})`,
      under('~', 'projects', PROJECT, 'memory'),
      '',
    ].join('\n'),
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
})

test('a memory path does not excuse a transcript path on the same line', () => {
  const memory = under('~', 'projects', PROJECT, 'memory', 'x.md')
  const transcript = under('~', 'projects', PROJECT, `${SESSION}.jsonl`)
  const dir = makeRepo({ 'a.md': `${memory} and ${transcript}\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /a\.md:1: path to a Claude Code session transcript/)
  assert.match(r.out, /1 findings/)
})

test("a session directory's own memory-named subdirectory is not the project's memory", () => {
  const dir = makeRepo({ 'a.md': `${under('~', 'projects', PROJECT, SESSION, 'memory', 'x.md')}\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /a\.md:1: path to a Claude Code session transcript/)
})

test('the output never carries the line text', () => {
  const dir = makeRepo({ 'a.txt': `please-do-not-echo-me ${PLAN}\n` })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.err + r.out, /please-do-not-echo-me|starry-cook/)
})

test('untracked, binary, vendored and node_modules files are not read', () => {
  const dir = makeRepo(
    {
      'README.md': 'clean\n',
      'blob.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(PLAN)]),
      'vendor/lib/x.php': `<?php // ${PLAN}\n`,
      'node_modules/y/index.js': `// ${PLAN}\n`,
    },
    { 'scratch.md': `${PLAN}\n` },
  )
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /1 files in 1 repositories, 0 findings/)
})

test('an allow-listed file passes; comments and blank lines in the list are ignored', () => {
  const dir = makeRepo({
    '.github/session-paths-allow.txt': '# dated snapshots\n\nREVIEW-2026-08-15.md  # records what was true then\n',
    'REVIEW-2026-08-15.md': `Plan: ${PLAN}\n`,
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
})

test('an allow-list entry whose file names no such path any more fails', () => {
  const dir = makeRepo({
    '.github/session-paths-allow.txt': 'REVIEW-2026-08-15.md\n',
    'REVIEW-2026-08-15.md': 'clean now\n',
  })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /session-paths-allow\.txt: REVIEW-2026-08-15\.md names no such path any more/)
})

test('an allow-list entry naming no tracked file fails', () => {
  const dir = makeRepo({ '.github/session-paths-allow.txt': 'gone.md\n', 'README.md': 'clean\n' })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /session-paths-allow\.txt: gone\.md is not a tracked file/)
})

test('the allow list exempts only the files it names', () => {
  const dir = makeRepo({
    '.github/session-paths-allow.txt': 'a.md\n',
    'a.md': `${PLAN}\n`,
    'b.md': `${PLAN}\n`,
  })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /b\.md:1: path to a Claude Code plan file/)
  assert.doesNotMatch(r.err, /\/a\.md:/)
})

test('the check and this test pass the check themselves', () => {
  const dir = makeRepo({
    'scripts/check-session-paths.mjs': readFileSync(SCRIPT),
    'scripts/check-session-paths.test.mjs': readFileSync(THIS_FILE),
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.err)
})

test('several repos are checked in one run, each finding prefixed by its repo', () => {
  const clean = makeRepo({ 'a.md': 'clean\n' })
  const dirty = makeRepo({ 'b.md': `${PLAN}\n` })
  const r = run(clean, dirty)
  assert.equal(r.code, 1)
  assert.match(r.err, new RegExp(`^${basename(dirty)}/b\\.md:1:`, 'm'))
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
