#!/usr/bin/env node
// Proves on a Renovate dry run that default.json's rules for GitHub Actions pins still hold:
// Renovate does not follow a release tag to another commit, and the beliq-eu/.github pin,
// which follows a branch on purpose, still moves and merges itself.
//
// renovate-config-validator checks that default.json is well formed. It accepts a rule that
// matches nothing, so it stays green when a later edit scopes or orders these rules another
// way. Either mistake is silent in every repo that extends the preset: digest updates for
// actions come back and merge themselves, or the guard pin stops moving.
//
// Two steps, with the Renovate run between them left to the caller:
//
//   node scripts/check-action-pin-rules.mjs build <dir>
//     Writes a repo for Renovate to read: the workflows of test/action-pins/workflows under
//     <dir>/.github/workflows, and a renovate.json that holds default.json with
//     automerge.json applied on top. Renovate's local platform cannot resolve the `local>`
//     preset automerge.json extends, and resolving it would read the published default
//     branch and not this commit. <dir> must sit outside any git checkout, or Renovate lists
//     only the files git tracks there and finds none.
//
//   node scripts/check-action-pin-rules.mjs judge <log>
//     Reads the JSON log of `renovate --platform=local --enabled-managers=github-actions`,
//     run in <dir> with LOG_LEVEL=trace and LOG_FORMAT=json. The record of the branches
//     Renovate would open is written at trace level only. Prints the message of every
//     warning and error Renovate logged, because the caller sent its output to the file.
//
// Exit codes: 0 the rules hold, 1 one does not, 2 the check itself could not run.
// Neither step asserts which dep types the pin rule covers, or the release age.

import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ROOT = new URL('../', import.meta.url)
const FIXTURE = new URL('test/action-pins/workflows/', ROOT)

// What automerge.json extends. The merge in `build` stands in for exactly this.
const PARENT = 'local>beliq-eu/.github'

// The one pin that follows a branch on purpose. default.json leaves it out of both rules by
// this name.
const GUARD = 'beliq-eu/.github'

// Case 1 of the fixture: a full-version comment on a commit that is not the tag's. To
// Renovate that is what a moved tag looks like, and it stays so whatever upstream releases.
const PLANTED = '.github/workflows/01-tag-moved-off-the-pin.yml'

const ACTION_TYPES = new Set(['action', 'workflow'])

class CannotRun extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

async function build(dir) {
  const base = JSON.parse(await readFile(new URL('default.json', ROOT), 'utf8'))
  const automerge = JSON.parse(await readFile(new URL('automerge.json', ROOT), 'utf8'))
  const { extends: parents, $schema: _schema, packageRules = [], ...rest } = automerge
  if (parents?.length !== 1 || parents[0] !== PARENT) {
    throw new CannotRun(`automerge.json extends ${JSON.stringify(parents)}, not only ${PARENT}; the merge here no longer stands in for it`)
  }

  // Renovate applies the parent first: its rules come before the child's, and an object
  // such as vulnerabilityAlerts keeps the parent's keys the child does not set.
  const config = { ...base, packageRules: [...base.packageRules, ...packageRules] }
  for (const [key, value] of Object.entries(rest)) {
    config[key] = isObject(value) && isObject(base[key]) ? { ...base[key], ...value } : value
  }

  const workflows = join(dir, '.github', 'workflows')
  if ((await readdir(dir).catch(() => [])).length > 0) throw new CannotRun(`${dir} is not empty`)
  await mkdir(workflows, { recursive: true })
  const cases = (await readdir(FIXTURE)).filter((f) => f.endsWith('.yml')).sort()
  if (!cases.some((f) => PLANTED.endsWith(`/${f}`))) throw new CannotRun(`the fixture has no ${PLANTED}`)
  for (const file of cases) await copyFile(new URL(file, FIXTURE), join(workflows, file))
  await writeFile(join(dir, 'renovate.json'), `${JSON.stringify(config, null, 2)}\n`)
  console.log(`wrote ${cases.length} workflows and renovate.json to ${dir}`)
}

// Renovate's log levels from warn up.
const PROBLEM_LEVELS = new Map([[40, 'warn'], [50, 'error'], [60, 'fatal']])
const PROBLEM_LINE = /"level":(?:40|50|60)\b/

// The log runs to more than 100 MB at trace level, so only the lines that can hold
// something the check reads are parsed.
async function readLog(path) {
  const wanted = { lookup: 'packageFiles with updates', branches: 'branches' }
  const found = {}
  const problems = new Map()
  let version
  let number = 0
  const parse = (line) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new CannotRun(`line ${number} of the log is not JSON; was the run cut short?`)
    }
  }
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    number += 1
    if (version === undefined && line.includes('"renovateVersion":')) {
      const record = parse(line)
      if (typeof record.renovateVersion === 'string') version = record.renovateVersion
    }
    if (PROBLEM_LINE.test(line)) {
      const record = parse(line)
      if (PROBLEM_LEVELS.has(record.level)) {
        const problem = `${PROBLEM_LEVELS.get(record.level)}: ${record.msg}`
        problems.set(problem, (problems.get(problem) ?? 0) + 1)
      }
    }
    for (const [key, msg] of Object.entries(wanted)) {
      if (!line.includes(`"msg":${JSON.stringify(msg)}`)) continue
      const record = parse(line)
      if (record.msg === msg) found[key] = record
    }
  }
  // Only the message, never the record: a public repo's CI log is public.
  for (const [problem, count] of problems) console.log(`Renovate logged ${count} x ${problem}`)
  if (version === undefined) throw new CannotRun('the log names no Renovate version; was Renovate run with LOG_FORMAT=json?')
  for (const [key, msg] of Object.entries(wanted)) {
    if (found[key]) continue
    // Renovate 42, which npx installs under Node 22, rejects a preset default.json extends
    // and stops before either record.
    throw new CannotRun(`the log of Renovate ${version} has no "${msg}" record; either it stopped before the lookup or it was not run with LOG_LEVEL=trace`)
  }
  return { version, ...found }
}

function judge({ lookup, branches }) {
  const failures = []
  const passes = []
  const short = (digest) => String(digest ?? '').slice(0, 7)

  const deps = (lookup.config?.['github-actions'] ?? []).flatMap((file) =>
    (file.deps ?? []).map((dep) => ({ ...dep, packageFile: file.packageFile })),
  )
  const upgrades = (branches.branches ?? []).flatMap((branch) =>
    (branch.upgrades ?? []).map((upgrade) => ({ ...upgrade, branch })),
  )
  const planted = deps.find((d) => d.packageFile === PLANTED && ACTION_TYPES.has(d.depType))
  const guard = deps.find((d) => d.depName === GUARD)
  // A run that read no workflow must not pass as "no digest update anywhere".
  if (!planted || !guard) {
    throw new CannotRun(
      `Renovate extracted ${deps.length} dependencies and not both the planted pin and the ${GUARD} pin; ` +
        'was it run in the directory `build` wrote, outside any git checkout?',
    )
  }

  // 1. Without this the next check passes on a run that never saw a digest update.
  const offered = (planted.updates ?? []).find((u) => u.updateType === 'digest')
  if (offered) {
    passes.push(`the lookup offers a digest update for the planted pin (${planted.depName} ${planted.currentValue}, ${short(planted.currentDigest)} to ${short(offered.newDigest)})`)
  } else {
    failures.push(`the lookup offers no digest update for the planted pin in ${PLANTED}, so nothing shows that the rule is what keeps it out of a branch`)
  }

  // 2. The rule that turns digest updates off.
  const followed = upgrades.filter((u) => u.updateType === 'digest' && ACTION_TYPES.has(u.depType) && u.depName !== GUARD)
  if (followed.length === 0) {
    passes.push('no branch holds a digest update of an action or a reusable workflow')
  }
  for (const u of followed) {
    failures.push(`branch ${u.branch.branchName} holds a digest update of ${u.depName} (${u.packageFile}): Renovate would follow a tag or a branch to another commit`)
  }

  // 3. The exemption, from both rules.
  const moved = upgrades.find((u) => u.depName === GUARD && u.updateType === 'digest')
  // The guard pin's upgrade is the one upgrade this run is sure to hold. If it carries no
  // dep type, read 2 matched on a field that is gone and passed on nothing.
  if (moved && !ACTION_TYPES.has(moved.depType)) {
    throw new CannotRun(`the upgrade of the ${GUARD} pin has the dep type ${JSON.stringify(moved.depType)}, so the dep type of an upgrade can no longer be read`)
  }
  if (!moved) {
    failures.push(`no branch holds the digest update of the ${GUARD} pin: the pin would stop moving`)
  } else if (moved.pendingChecks === true || moved.branch.pendingChecks === true) {
    failures.push(`the digest update of the ${GUARD} pin is pending in ${moved.branch.branchName}: a release age holds it, and a branch has no release date to pass it`)
  } else if (moved.automerge !== true) {
    failures.push(`the digest update of the ${GUARD} pin in ${moved.branch.branchName} does not merge itself`)
  } else {
    passes.push(`branch ${moved.branch.branchName} holds the digest update of the ${GUARD} pin, not pending, with auto-merge on`)
  }

  return { passes, failures }
}

const [command, target] = process.argv.slice(2)
if (!['build', 'judge'].includes(command) || !target || process.argv.length !== 4) {
  console.error('usage: node scripts/check-action-pin-rules.mjs build <dir> | judge <renovate-log>')
  process.exit(2)
}

try {
  if (command === 'build') {
    await build(target)
  } else {
    const records = await readLog(target)
    console.log(`Renovate ${records.version}`)
    const { passes, failures } = judge(records)
    for (const line of passes) console.log(`ok    ${line}`)
    if (failures.length > 0) {
      console.error(`\n${failures.length} problem(s):`)
      for (const line of failures) console.error(`  ${line}`)
      process.exit(1)
    }
  }
} catch (err) {
  // A file system error carries a code. Anything else is a defect of this script.
  if (!(err instanceof CannotRun) && typeof err.code !== 'string') throw err
  console.error(`cannot run: ${err.message}`)
  process.exit(2)
}
