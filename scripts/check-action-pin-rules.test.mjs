// Runs check-action-pin-rules.mjs as a subprocess.
// Run: node --test scripts/check-action-pin-rules.test.mjs
//
// `build` is tested against this repo's real presets and fixture. `judge` is tested against
// small logs written here, which hold only the fields the check reads, with the names and
// nesting of a Renovate 44.145.1 trace log. They prove the check's own logic. That Renovate
// still writes those records is proved by the CI job, which runs the real thing.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-action-pin-rules.mjs', import.meta.url).pathname
const ROOT = new URL('../', import.meta.url)
const readJson = (name) => JSON.parse(readFileSync(new URL(name, ROOT), 'utf8'))

const work = mkdtempSync(join(tmpdir(), 'action-pin-rules-test-'))
after(() => rmSync(work, { recursive: true, force: true }))

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const PLANTED = '.github/workflows/01-tag-moved-off-the-pin.yml'
const GUARD_FILE = '.github/workflows/04-guard-pin.yml'
const GUARD_BRANCH = 'renovate/beliq-eu-github-workflows'
const PATCHES = 'renovate/dependency-updates-(patches)'

const plantedDep = (updates) => ({
  packageFile: PLANTED,
  deps: [{ depName: 'actions/checkout', depType: 'action', currentValue: 'v7.0.1', currentDigest: '9c091bb21b', updates }],
})
const guardDep = {
  packageFile: GUARD_FILE,
  deps: [{ depName: 'beliq-eu/.github', depType: 'workflow', currentValue: 'main', updates: [{ updateType: 'digest' }] }],
}
const guardUpgrade = (over = {}) => ({
  depName: 'beliq-eu/.github',
  depType: 'workflow',
  updateType: 'digest',
  automerge: true,
  packageFile: GUARD_FILE,
  ...over,
})
// A Docker image's digest update and an action's patch update: both belong in a branch.
const patchesBranch = (...more) => ({
  branchName: PATCHES,
  upgrades: [
    { depName: 'postgres', depType: 'service', updateType: 'digest', automerge: true },
    { depName: 'actions/checkout', depType: 'action', updateType: 'patch', automerge: true },
    ...more,
  ],
})

const holds = {
  files: [plantedDep([{ updateType: 'digest', newDigest: '3d3c42e5aa' }]), guardDep],
  branches: [{ branchName: GUARD_BRANCH, upgrades: [guardUpgrade()] }, patchesBranch()],
}

function judge({ files, branches }, { records } = {}) {
  const lines = records ?? [
    { msg: 'Renovate started', renovateVersion: '44.145.1' },
    { msg: 'packageFiles with updates', config: { 'github-actions': files } },
    { msg: 'branches', branches },
  ]
  const path = join(mkdtempSync(join(work, 'log-')), 'renovate.ndjson')
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return run('judge', path)
}

test('build writes every fixture workflow and automerge.json applied over default.json', () => {
  const dir = join(mkdtempSync(join(work, 'build-')), 'repo')
  const r = run('build', dir)
  assert.equal(r.code, 0, r.err)

  const fixture = readdirSync(new URL('test/action-pins/workflows/', ROOT)).sort()
  assert.deepEqual(readdirSync(join(dir, '.github', 'workflows')).sort(), fixture)
  assert.ok(fixture.includes(PLANTED.split('/').pop()))
  assert.ok(fixture.includes(GUARD_FILE.split('/').pop()))

  const base = readJson('default.json')
  const automerge = readJson('automerge.json')
  const config = JSON.parse(readFileSync(join(dir, 'renovate.json'), 'utf8'))
  assert.deepEqual(config.extends, base.extends)
  assert.deepEqual(config.packageRules, [...base.packageRules, ...automerge.packageRules])
  assert.deepEqual(config.vulnerabilityAlerts, { ...base.vulnerabilityAlerts, ...automerge.vulnerabilityAlerts })
  assert.equal(config.rebaseWhen, automerge.rebaseWhen)
  assert.deepEqual(config.schedule, base.schedule)
  assert.deepEqual(config.customManagers, base.customManagers)
})

test('build refuses a directory that already holds files', () => {
  const dir = mkdtempSync(join(work, 'used-'))
  writeFileSync(join(dir, 'renovate.json'), '{}\n')
  const r = run('build', dir)
  assert.equal(r.code, 2)
  assert.match(r.err, /is not empty/)
  assert.equal(readFileSync(join(dir, 'renovate.json'), 'utf8'), '{}\n')
})

test('a run in which the rules hold passes and names the Renovate version', () => {
  const r = judge(holds)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^Renovate 44\.145\.1$/m)
  assert.equal(r.out.match(/^ok {4}/gm).length, 3)
})

test('a digest update of an action in a branch fails', () => {
  const followed = { depName: 'actions/checkout', depType: 'action', updateType: 'digest', packageFile: PLANTED }
  const r = judge({ ...holds, branches: [holds.branches[0], patchesBranch(followed)] })
  assert.equal(r.code, 1)
  assert.match(r.err, /dependency-updates-\(patches\) holds a digest update of actions\/checkout/)
})

test('a digest update of a reusable workflow other than the guard fails', () => {
  const followed = { depName: 'octo-org/shared', depType: 'workflow', updateType: 'digest', packageFile: 'x.yml' }
  const r = judge({ ...holds, branches: [holds.branches[0], patchesBranch(followed)] })
  assert.equal(r.code, 1)
  assert.match(r.err, /holds a digest update of octo-org\/shared/)
})

test('the guard pin with no digest update in any branch fails', () => {
  const r = judge({ ...holds, branches: [patchesBranch()] })
  assert.equal(r.code, 1)
  assert.match(r.err, /no branch holds the digest update of the beliq-eu\/\.github pin/)
})

test('the guard pin held as pending fails, on the upgrade or on its branch', () => {
  const onUpgrade = judge({ ...holds, branches: [{ branchName: GUARD_BRANCH, upgrades: [guardUpgrade({ pendingChecks: true })] }] })
  assert.equal(onUpgrade.code, 1)
  assert.match(onUpgrade.err, /is pending in renovate\/beliq-eu-github-workflows/)

  const onBranch = judge({ ...holds, branches: [{ branchName: GUARD_BRANCH, pendingChecks: true, upgrades: [guardUpgrade()] }] })
  assert.equal(onBranch.code, 1)
  assert.match(onBranch.err, /is pending in renovate\/beliq-eu-github-workflows/)
})

test('the guard pin without auto-merge fails', () => {
  const r = judge({ ...holds, branches: [{ branchName: GUARD_BRANCH, upgrades: [guardUpgrade({ automerge: false })] }] })
  assert.equal(r.code, 1)
  assert.match(r.err, /does not merge itself/)
})

test('a planted pin the lookup offers no digest update for fails', () => {
  const r = judge({ ...holds, files: [plantedDep([{ updateType: 'patch' }]), guardDep] })
  assert.equal(r.code, 1)
  assert.match(r.err, /offers no digest update for the planted pin/)
})

test('a log without the branches record cannot be judged', () => {
  const r = judge(holds, {
    records: [
      { msg: 'Renovate started', renovateVersion: '44.145.1' },
      { msg: 'packageFiles with updates', config: { 'github-actions': holds.files } },
    ],
  })
  assert.equal(r.code, 2)
  assert.match(r.err, /no "branches" record/)
})

test('a log cut short in the middle of a record cannot be judged', () => {
  const path = join(mkdtempSync(join(work, 'log-')), 'renovate.ndjson')
  writeFileSync(path, `${JSON.stringify({ msg: 'Renovate started', renovateVersion: '44.145.1' })}\n{"msg":"branches","branches":[{"branchName"`)
  const r = run('judge', path)
  assert.equal(r.code, 2)
  assert.match(r.err, /line 2 of the log is not JSON/)
})

test('an upgrade that carries no dep type cannot be judged', () => {
  const r = judge({ ...holds, branches: [{ branchName: GUARD_BRANCH, upgrades: [guardUpgrade({ depType: undefined })] }] })
  assert.equal(r.code, 2)
  assert.match(r.err, /dep type of an upgrade can no longer be read/)
})

test('the messages of warnings and errors are printed, and nothing else of them', () => {
  const warning = { level: 40, msg: 'GitHub token is required for some dependencies', detail: 'not-for-the-log' }
  const r = judge(holds, {
    records: [
      { level: 30, msg: 'Renovate started', renovateVersion: '44.145.1' },
      warning,
      warning,
      { level: 50, msg: 'lookup failed' },
      { level: 20, msg: 'packageFiles with updates', config: { 'github-actions': holds.files } },
      { level: 10, msg: 'branches', branches: holds.branches },
    ],
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^Renovate logged 2 x warn: GitHub token is required for some dependencies$/m)
  assert.match(r.out, /^Renovate logged 1 x error: lookup failed$/m)
  assert.doesNotMatch(r.out + r.err, /not-for-the-log/)
})

test('build refuses a path that is a file', () => {
  const file = join(mkdtempSync(join(work, 'file-')), 'taken')
  writeFileSync(file, 'x')
  const r = run('build', file)
  assert.equal(r.code, 2)
  assert.match(r.err, /^cannot run: /)
  assert.equal(readFileSync(file, 'utf8'), 'x')
})

test('a run that extracted no dependency cannot be judged', () => {
  const r = judge({ files: [], branches: [] })
  assert.equal(r.code, 2)
  assert.match(r.err, /extracted 0 dependencies/)
})

test('a record that only carries the message name deeper down is not read as that record', () => {
  const r = judge(holds, {
    records: [
      { msg: 'Renovate started', renovateVersion: '44.145.1' },
      { msg: 'packageFiles with updates', config: { 'github-actions': holds.files } },
      { msg: 'branches', branches: holds.branches },
      { msg: 'something else', nested: { msg: 'branches', branches: [] } },
    ],
  })
  assert.equal(r.code, 0, r.err)
})
