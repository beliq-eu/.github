#!/usr/bin/env python3
"""Fails when a pull request puts a package version younger than MIN_AGE_HOURS into a yarn.lock.

Every yarn 1 lockfile the repository tracks at <head> is compared with the same path at <base>.
Each `name@version` that the head lockfile holds and the base one does not, dependencies of
dependencies included, is looked up on npm, and its publish time must be at least MIN_AGE_HOURS
old.

Why the lockfile and not the manifest: yarn 1 has no publish-date cutoff. Renovate can choose a
version that is old enough, and the `yarn upgrade` or `yarn install` it runs then locks the newest
version inside each range, whatever its age, for the package and for everything below it.

Only added versions are read. A version already on the base was checked by the pull request that
added it, and reading every entry costs too much: one packument can weigh over 30 MB.

Not read: an entry whose source is a local path, and one resolved from a host that is not the npm
registry. The second is named in the output.

Usage: check-lockfile-age.py <base> <head>
Exit codes: 0 clean, 1 findings, 2 the check itself could not run.
The output names packages, versions and lockfile paths, which the pull request already shows.
"""

import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

# Aikido Safe Chain refuses a tarball younger than this on the machines that install these
# lockfiles, so an install there fails on a version this check would let through.
MIN_AGE_HOURS = 72

# The packument of a busy package is tens of megabytes.
REGISTRY_TIMEOUT_SECONDS = 60
# Waits before the second and the third attempt. A registry that fails all three makes the
# check exit 2, never pass.
RETRY_DELAYS_SECONDS = (2, 5)
REGISTRY_WORKERS = 8

NPM_REGISTRY = os.environ.get('GUARD_NPM_REGISTRY', 'https://registry.npmjs.org')
REGISTRY_HOSTS = {'registry.yarnpkg.com', 'registry.npmjs.org'}

SKIP_DIR = re.compile(r'(^|/)(vendor|node_modules)/')
YARN1_HEADER = '# yarn lockfile v1'
LOCAL_SPEC = ('file:', 'link:')


class CheckError(Exception):
    """The check could not run."""


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True)
    if result.returncode != 0:
        raise CheckError(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def lockfile_paths(ref):
    return [p for p in git('ls-tree', '-r', '-z', '--name-only', ref).decode().split('\0')
            if p.rsplit('/', 1)[-1] == 'yarn.lock' and not SKIP_DIR.search(p)]


def split_descriptor(descriptor):
    """('name', 'range') from `name@range`; a scoped name keeps its leading @."""
    at = descriptor.find('@', 1)
    return (descriptor, '') if at < 0 else (descriptor[:at], descriptor[at + 1:])


def entries(text):
    """{(name, version): 'registry' | 'other:<host>'} for the entries a yarn 1 lockfile pins.

    A local path is left out. An entry with no `resolved` line, which a hand or bot edit can
    leave, counts as a registry entry."""
    found = {}
    for block in re.split(r'\n\s*\n', text):
        lines = [line for line in block.splitlines() if line]
        if not lines:
            continue
        first_key = lines[0].rstrip(':').split(', ')[0].strip('"')
        name, spec = split_descriptor(first_key)
        if spec.startswith('npm:'):
            name, _ = split_descriptor(spec[len('npm:'):])
        fields = {}
        for line in lines[1:]:
            match = re.match(r'^  (version|resolved) "?([^"]*)"?$', line)
            if match:
                fields[match.group(1)] = match.group(2)
        if 'version' not in fields or spec.startswith(LOCAL_SPEC):
            continue
        resolved = fields.get('resolved')
        host = urllib.parse.urlsplit(resolved).hostname if resolved else None
        if resolved is None or host in REGISTRY_HOSTS:
            found[(name, fields['version'])] = 'registry'
        else:
            found[(name, fields['version'])] = f'other:{host or resolved}'
    return found


def read_lockfile(ref, path):
    """The entries at ref:path, an empty dict if the path is absent, or None if not yarn 1."""
    result = subprocess.run(['git', 'cat-file', '-e', f'{ref}:{path}'], capture_output=True)
    if result.returncode != 0:
        return {}
    text = git('show', f'{ref}:{path}').decode('utf-8')
    if YARN1_HEADER not in text.split('\n\n', 1)[0]:
        return None
    return entries(text)


def fetch_json(url):
    """The decoded body, or None for a 404."""
    request = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'beliq-eu-guard'})
    error = None
    for delay in (0, *RETRY_DELAYS_SECONDS):
        time.sleep(delay)
        try:
            with urllib.request.urlopen(request, timeout=REGISTRY_TIMEOUT_SECONDS) as response:
                return json.load(response)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            error = f'HTTP {err.code}'
            if err.code < 500 and err.code != 429:
                break
        # OSError covers URLError, a timeout and a reset connection; HTTPException a body cut short.
        except (OSError, http.client.HTTPException, ValueError) as err:
            error = str(err) or type(err).__name__
    raise CheckError(f'{url}: {error}')


def publish_times(name):
    """{version: publish time} for one package, or None if npm does not know it."""
    doc = fetch_json(f"{NPM_REGISTRY}/{urllib.parse.quote(name, safe='@')}")
    if doc is None:
        return None
    return {version: datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            for version, stamp in (doc.get('time') or {}).items()
            # An unpublished package keeps an `unpublished` object here.
            if version not in ('created', 'modified') and isinstance(stamp, str)}


def main(argv):
    if len(argv) != 3:
        print('usage: check-lockfile-age.py <base> <head>', file=sys.stderr)
        return 2
    base_ref, head_ref = argv[1], argv[2]
    added = {}
    for path in lockfile_paths(head_ref):
        head = read_lockfile(head_ref, path)
        if head is None:
            print(f'{path}: not a yarn 1 lockfile, not read')
            continue
        base = read_lockfile(base_ref, path) or {}
        for key, source in head.items():
            if key not in base:
                added.setdefault(key, (source, path))

    for (name, version), (source, path) in sorted(added.items()):
        if source != 'registry':
            print(f'{path}: {name}@{version} comes from {source[len("other:"):]}, not from npm; its age is not checked')
    to_check = {key: path for key, (source, path) in added.items() if source == 'registry'}
    names = sorted({name for name, _ in to_check})
    with ThreadPoolExecutor(max_workers=REGISTRY_WORKERS) as pool:
        times = dict(zip(names, pool.map(publish_times, names)))

    now = datetime.now(timezone.utc)
    min_age = timedelta(hours=MIN_AGE_HOURS)
    failures = []
    clears = []
    for (name, version), path in sorted(to_check.items()):
        package_times = times[name]
        if package_times is None:
            failures.append(f'{path}: {name} does not exist on npm (read without a token)')
            continue
        published = package_times.get(version)
        if published is None:
            failures.append(f'{path}: npm gives no publish time for {name}@{version}')
            continue
        if now - published >= min_age:
            continue
        old_enough = published + min_age
        clears.append(old_enough)
        failures.append(
            f'{path}: {name}@{version} was published {published:%Y-%m-%d %H:%M} UTC, '
            f'{(now - published).total_seconds() / 3600:.0f} hours ago; it is {MIN_AGE_HOURS} hours old '
            f'at {old_enough:%Y-%m-%d %H:%M} UTC')

    for failure in failures:
        print(failure, file=sys.stderr)
    if clears and len(clears) == len(failures):
        print(f'Every version is {MIN_AGE_HOURS} hours old at {max(clears):%Y-%m-%d %H:%M} UTC. A re-run of this '
              'job after that time passes. Where the repository calls lockfile-age-rerun.yml on a schedule, that '
              're-run happens once a day without anyone pushing. To pass sooner, lock an older version.',
              file=sys.stderr)
    print(f'check-lockfile-age: {len(added)} added versions, {len(to_check)} read from npm, {len(failures)} findings')
    return 1 if failures else 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except CheckError as err:
        print(f'check-lockfile-age: {err}', file=sys.stderr)
        sys.exit(2)
