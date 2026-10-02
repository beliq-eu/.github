// Runs check-public-scrub.mjs as a subprocess against throwaway git repos.
// Run: node --test scripts/check-public-scrub.test.mjs
//
// Every forbidden string below is assembled at run time, so this file stays clean under
// the check it tests (CI runs the check over this repo too).

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-public-scrub.mjs', import.meta.url).pathname
const REPO_ROOT = new URL('..', import.meta.url).pathname
const j = (...parts) => parts.join('')

const ROADMAP = j('ROAD', 'MAP')
const GH = j('github', '.', 'com')
const HOME = j('/ho', 'me/')
const LISTED = 'listed-owner'
const UNLISTED = 'other-owner'
const SHARED_AGENTS = '# shared agent file\n'

const work = mkdtempSync(join(tmpdir(), 'public-scrub-test-'))
after(() => rmSync(work, { recursive: true, force: true }))

// A source dir laid out like the .github repo, with its own config, so the tests do not
// depend on which account's public-scrub.json this copy of the script ships with.
function makeSource({ agentFiles = [] } = {}) {
  const dir = mkdtempSync(join(work, 'source-'))
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-public-scrub.mjs'))
  writeFileSync(join(dir, 'public-scrub.json'), JSON.stringify({ publicOwners: [LISTED], agentFiles }))
  for (const f of agentFiles) writeFileSync(join(dir, f), SHARED_AGENTS)
  return dir
}

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

function run(source, ...repos) {
  const r = spawnSync(process.execPath, [join(source, 'scripts', 'check-public-scrub.mjs'), ...repos], {
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

const source = makeSource()
const clean = { 'README.md': `See https://${GH}/${LISTED}/thing.\n` }

test('a clean repo passes and says how much it read', () => {
  const r = run(source, makeRepo(clean))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 files in 1 repositories, 0 findings/)
})

test('internal file names fail when tracked, wherever they sit', () => {
  for (const name of [`docs/${ROADMAP}.md`, `${ROADMAP.toLowerCase()}-notes.txt`, 'PASS-3-SMOKE.md', 'SUBMISSION.md', 'PR-COMMENT-2.md']) {
    const r = run(source, makeRepo({ ...clean, [name]: 'x\n' }))
    assert.equal(r.code, 1, `${name}: ${r.out}`)
    assert.ok(r.out.includes(name), r.out)
  }
})

test('an untracked internal file is not the gate\'s business', () => {
  const r = run(source, makeRepo(clean, { [`${ROADMAP}.md`]: 'x\n' }))
  assert.equal(r.code, 0, r.out)
})

test('vendor and node_modules are skipped', () => {
  const r = run(source, makeRepo({ ...clean, [`vendor/x/${ROADMAP}.md`]: `${HOME}x\n`, [`node_modules/y/${ROADMAP}.md`]: 'x\n' }))
  assert.equal(r.code, 0, r.out)
})

test('a lower-case name that only starts like a pass file passes', () => {
  const r = run(source, makeRepo({ ...clean, 'src/pass-through.ts': 'export {}\n' }))
  assert.equal(r.code, 0, r.out)
})

test('each content rule fails, and the output never repeats the matched text', () => {
  const cases = {
    'link to a roadmap file': `see ${ROADMAP}.md for the plan`,
    'name of a private planning store': `kept in ${j('acme', '-hq')} for now`,
    'local home path': `cd ${HOME}someone/work`,
    'local workspace path': `cd ${j('~/Pro', 'jects')}/acme`,
    'link into a GitHub account not on the public list': `https://${GH}/${UNLISTED}/repo`,
    'issue or pull request reference into a GitHub account not on the public list': `fixed in ${UNLISTED}/repo${j('#', '12')}`,
  }
  for (const [rule, line] of Object.entries(cases)) {
    const r = run(source, makeRepo({ 'notes.md': `first line\n${line}\n` }))
    assert.equal(r.code, 1, `${rule}: ${r.out}`)
    assert.ok(r.out.includes(`notes.md:2: ${rule}`), r.out)
    assert.ok(!r.out.includes(line), `matched text leaked into the output: ${r.out}`)
    assert.ok(!r.out.includes(UNLISTED), r.out)
  }
})

test('a home path inside a URL is not a local path', () => {
  const r = run(source, makeRepo({ 'notes.md': `https://example.org${HOME}page\n` }))
  assert.equal(r.code, 0, r.out)
})

test('listed owners pass in every link form, case-insensitively', () => {
  const lines = [
    `https://${GH}/${LISTED.toUpperCase()}/repo`,
    `git@${GH}:${LISTED}/repo.git`,
    `https://raw.githubusercontent.com/${LISTED}/repo/main/x`,
    `https://api.${GH}/repos/${LISTED}/repo`,
    `${LISTED}/repo${j('#', '7')}`,
  ]
  const r = run(source, makeRepo({ 'notes.md': lines.join('\n') }))
  assert.equal(r.code, 0, r.out)
})

test('a lockfile is exempt from the owner rules but not from the path rules', () => {
  const owner = run(source, makeRepo({ ...clean, 'package-lock.json': `"resolved": "https://${GH}/${UNLISTED}/dep"\n` }))
  assert.equal(owner.code, 0, owner.out)
  const path = run(source, makeRepo({ ...clean, 'composer.lock': `"url": "${HOME}someone/dep"\n` }))
  assert.equal(path.code, 1, path.out)
})

test('a binary file is not read as text', () => {
  const r = run(source, makeRepo({ ...clean, 'logo.png': Buffer.concat([Buffer.from([0]), Buffer.from(`${ROADMAP}.md`)]) }))
  assert.equal(r.code, 0, r.out)
})

test('agent files must equal the shared copy', () => {
  const agents = makeSource({ agentFiles: ['AGENTS.md', 'CLAUDE.md'] })
  const same = run(agents, makeRepo({ ...clean, 'AGENTS.md': SHARED_AGENTS, 'CLAUDE.md': SHARED_AGENTS }))
  assert.equal(same.code, 0, same.out)

  const drifted = run(agents, makeRepo({ ...clean, 'AGENTS.md': SHARED_AGENTS + 'local edit\n', 'CLAUDE.md': SHARED_AGENTS }))
  assert.equal(drifted.code, 1, drifted.out)
  assert.match(drifted.out, /AGENTS\.md: differs from the shared copy/)

  const missing = run(agents, makeRepo({ ...clean, 'AGENTS.md': SHARED_AGENTS }))
  assert.equal(missing.code, 1, missing.out)
  assert.match(missing.out, /CLAUDE\.md: missing/)
})

test('every repo passed is checked, not only the first', () => {
  const r = run(source, makeRepo(clean), makeRepo({ ...clean, 'SUBMISSION.md': 'x\n' }))
  assert.equal(r.code, 1, r.out)
})

test('a run that reads nothing is an error, not a pass', () => {
  assert.equal(run(source).code, 2)
  assert.equal(run(source, makeRepo({})).code, 2)
})

test('a directory that is not a git repo is an error, not a pass', () => {
  const r = run(source, mkdtempSync(join(work, 'plain-')))
  assert.equal(r.code, 2, r.out)
})

test('the repo that ships the script passes its own check', () => {
  const r = spawnSync(process.execPath, [SCRIPT, REPO_ROOT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
