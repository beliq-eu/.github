#!/usr/bin/env python3
"""Fails when a pull request adds a direct dependency that nobody vouched for.

A package name that a dependency manifest lists at <head>, and that no manifest of the same
ecosystem lists at <base>, is new. Each new name has to:

- exist on its registry (npm, PyPI or Packagist) with at least one published release;
- have been first published at least MIN_AGE_DAYS days ago, unless the pull request body
  holds a `Young-Dependency: <name> <reason>` line;
- appear in a `New-Dependency: <name> <reason>` line of the pull request body.

A model can invent a package name, and a squatter can register the invented name with
malware in it. The first rule catches the name nobody registered, the second the name
registered last week, and the third makes whoever adds a dependency say why, where a
reviewer reads it.

Read: package.json (dependencies, devDependencies, optionalDependencies, peerDependencies),
pyproject.toml ([project] dependencies and optional-dependencies, [dependency-groups],
[build-system] requires), requirements*.txt and requirements*.in, and composer.json (require
and require-dev). A requirements file that pip-compile wrote is skipped, because it pins
every transitive package too. A dependency on a local path is not checked. One on a git or
URL source cannot be checked against a registry and needs its reason line all the same.

Usage: check-new-dependencies.py <base> <head>
The pull request body comes from the PR_BODY environment variable.
Exit codes: 0 clean, 1 findings, 2 the check itself could not run.
The output names packages, manifests and reasons, which the pull request already shows.
"""

import json
import os
import re
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# A name squatted after a model invented it is new by construction. A month gives the
# registry's malware scanning and the package's other users time to catch it.
MIN_AGE_DAYS = 30

REGISTRY_TIMEOUT_SECONDS = 30
# Waits before the second and the third attempt. A registry that fails all three makes the
# check exit 2, never pass.
RETRY_DELAYS_SECONDS = (2, 5)

REGISTRIES = {
    'npm': os.environ.get('GUARD_NPM_REGISTRY', 'https://registry.npmjs.org'),
    'pypi': os.environ.get('GUARD_PYPI_SIMPLE', 'https://pypi.org/simple'),
    'packagist': os.environ.get('GUARD_PACKAGIST', 'https://repo.packagist.org'),
}
REGISTRY_NAMES = {'npm': 'npm', 'pypi': 'PyPI', 'packagist': 'Packagist'}

# The same exemption as the other checks: vendored code is not ours to vouch for.
SKIP_DIR = re.compile(r'(^|/)(vendor|node_modules)/')
REQUIREMENTS = re.compile(r'(^|/)requirements[^/]*\.(txt|in)$')
PIP_COMPILE_ANNOTATION = re.compile(r'^\s*#\s*via\b', re.M)

NPM_SECTIONS = ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')
NPM_LOCAL = ('file:', 'link:', 'workspace:', 'portal:', './', '../', '/', '~/')
NPM_EXTERNAL = re.compile(r'^(git(\+[a-z]+)?:|github:|gitlab:|bitbucket:|gist:|https?:|[^@/\s:]+/[^/\s]+$)')

PEP508_NAME = re.compile(r'^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$', re.S)
# What may follow a requirement's name: nothing, a version, a marker, a URL or a pip option.
# Anything else, `https://...` for instance, is not a requirement that starts with a name.
PEP508_REST = re.compile(r'^($|[<>=!~;@(]|--)')

TRAILER = re.compile(r'^[ \t]*(?:[-*][ \t]+)?(new|young)-dependency:[ \t]*`?([^\s`]+)`?(.*)$', re.I | re.M)


class CheckError(Exception):
    """The check could not run."""


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True)
    if result.returncode != 0:
        raise CheckError(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def normalize(ecosystem, name):
    if ecosystem == 'pypi':
        return re.sub(r'[-_.]+', '-', name).lower()
    if ecosystem == 'packagist':
        return name.lower()
    return name


def npm_deps(text):
    data = json.loads(text)
    for section in NPM_SECTIONS:
        for key, spec in (data.get(section) or {}).items():
            if not isinstance(spec, str):
                continue
            spec = spec.strip()
            if spec.startswith('npm:'):
                # An alias installs the package named after `npm:`, up to its version.
                target = spec[len('npm:'):]
                at = target.find('@', 1)
                yield 'npm', target if at < 0 else target[:at], 'registry'
            elif spec.startswith(NPM_LOCAL):
                continue
            elif NPM_EXTERNAL.match(spec):
                yield 'npm', key, 'external'
            else:
                yield 'npm', key, 'registry'


def pep508(requirement):
    match = PEP508_NAME.match(requirement)
    if not match or not PEP508_REST.match(match.group(2)):
        return None
    return 'pypi', match.group(1), 'external' if match.group(2).startswith('@') else 'registry'


def requirements_deps(text):
    if PIP_COMPILE_ANNOTATION.search(text):
        return
    for line in text.replace('\\\n', ' ').splitlines():
        line = re.sub(r'(^|\s)#.*', '', line).strip()
        # Option lines (-r, -c, -e, --index-url) name no package of their own.
        if not line or line.startswith('-'):
            continue
        dep = pep508(line)
        if dep:
            yield dep


def pyproject_deps(text):
    data = tomllib.loads(text)
    project = data.get('project') or {}
    requirements = list(project.get('dependencies') or [])
    for group in (project.get('optional-dependencies') or {}).values():
        requirements += group
    for group in (data.get('dependency-groups') or {}).values():
        # An {include-group = "..."} entry names another group, not a package.
        requirements += [r for r in group if isinstance(r, str)]
    requirements += (data.get('build-system') or {}).get('requires') or []
    # An extra can pull in the project's own other extras by naming the project.
    own = normalize('pypi', project['name']) if 'name' in project else None
    for requirement in requirements:
        dep = pep508(requirement)
        if dep and normalize('pypi', dep[1]) != own:
            yield dep


def composer_deps(text):
    data = json.loads(text)
    for section in ('require', 'require-dev'):
        for name in data.get(section) or {}:
            # A name without a vendor is a platform requirement: php, ext-json, lib-icu.
            if '/' in name:
                yield 'packagist', name, 'registry'


def parser_for(path):
    filename = path.rsplit('/', 1)[-1]
    if filename == 'package.json':
        return npm_deps
    if filename == 'pyproject.toml':
        return pyproject_deps
    if filename == 'composer.json':
        return composer_deps
    if REQUIREMENTS.search(path):
        return requirements_deps
    return None


def dependencies(ref):
    """{(ecosystem, normalized name): (name, source, manifest)} over every manifest at ref,
    and how many manifests were read."""
    found = {}
    manifests = 0
    for path in git('ls-tree', '-r', '-z', '--name-only', ref).decode().split('\0'):
        parse = parser_for(path) if path and not SKIP_DIR.search(path) else None
        if parse is None:
            continue
        manifests += 1
        text = git('show', f'{ref}:{path}').decode('utf-8')
        try:
            deps = list(parse(text))
        except (ValueError, AttributeError, TypeError) as err:
            raise CheckError(f'{ref}:{path} could not be parsed: {err}') from err
        for ecosystem, name, source in deps:
            found.setdefault((ecosystem, normalize(ecosystem, name)), (name, source, path))
    return found, manifests


def fetch_json(url, accept='application/json'):
    """The decoded body, or None for a 404."""
    request = urllib.request.Request(url, headers={'Accept': accept, 'User-Agent': 'beliq-eu-guard'})
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
        except (urllib.error.URLError, TimeoutError, ValueError) as err:
            error = str(err)
    raise CheckError(f'{url}: {error}')


def parse_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def first_published(ecosystem, name):
    """When the package's first release went up, or None if the registry has no release."""
    registry = REGISTRIES[ecosystem]
    if ecosystem == 'npm':
        doc = fetch_json(f"{registry}/{urllib.parse.quote(name, safe='@')}")
        # An unpublished package still answers, with no versions left.
        if not doc or not doc.get('versions'):
            return None
        stamps = [(doc.get('time') or {}).get('created')]
    elif ecosystem == 'pypi':
        doc = fetch_json(f"{registry}/{normalize('pypi', name)}/", 'application/vnd.pypi.simple.v1+json')
        if not doc or not doc.get('files'):
            return None
        stamps = [f.get('upload-time') for f in doc['files']]
    else:
        key = name.lower()
        stamps = []
        # Tagged releases first; a package with none has only branch versions.
        for suffix in ('', '~dev'):
            doc = fetch_json(f'{registry}/p2/{key}{suffix}.json')
            if doc is None:
                return None
            versions = (doc.get('packages') or {}).get(key) or []
            if versions:
                stamps = [v.get('time') for v in versions]
                break
        else:
            return None
    stamps = [parse_time(s) for s in stamps if s]
    if not stamps:
        raise CheckError(f'{REGISTRY_NAMES[ecosystem]} gave no publish time for {name}')
    return min(stamps)


def trailers(body):
    """{'new': [(name, reason)], 'young': [...]} from the pull request body."""
    found = {'new': [], 'young': []}
    for match in TRAILER.finditer(body or ''):
        reason = re.sub(r'^\s*[-:]+', '', match.group(3)).strip()
        found[match.group(1).lower()].append((match.group(2), reason))
    return found


def reason_for(entries, ecosystem, key):
    for name, reason in entries:
        if normalize(ecosystem, name) == key:
            return reason
    return None


def main(argv):
    if len(argv) != 3:
        print('usage: check-new-dependencies.py <base> <head>', file=sys.stderr)
        return 2
    base, _ = dependencies(argv[1])
    head, manifests = dependencies(argv[2])
    new = {key: value for key, value in head.items() if key not in base}
    lines = trailers(os.environ.get('PR_BODY', ''))
    now = datetime.now(timezone.utc)
    failures = []
    missing_line = False

    for (ecosystem, key), (name, source, path) in sorted(new.items()):
        registry = REGISTRY_NAMES[ecosystem]
        reason = reason_for(lines['new'], ecosystem, key)
        if reason is None:
            missing_line = True
            failures.append(f'{path}: {name} ({registry}) is new; add "New-Dependency: {name} <why it is needed>" to the pull request body')
        elif not reason:
            failures.append(f'{path}: the New-Dependency line for {name} gives no reason')
        else:
            print(f'{path}: {name} ({registry}): {reason}')

        if source == 'external':
            print(f'{path}: {name} comes from a git or URL source; its existence and age are not checked')
            continue
        first = first_published(ecosystem, name)
        if first is None:
            failures.append(f'{path}: {name} does not exist on {registry}, or has no published release')
            continue
        age = (now - first).days
        if age >= MIN_AGE_DAYS:
            continue
        young = reason_for(lines['young'], ecosystem, key)
        if young is None:
            missing_line = True
            failures.append(
                f'{path}: {name} was first published on {first:%Y-%m-%d}, {age} days ago; one younger than '
                f'{MIN_AGE_DAYS} days needs "Young-Dependency: {name} <why it cannot wait>" in the pull request body')
        elif not young:
            failures.append(f'{path}: the Young-Dependency line for {name} gives no reason')

    for failure in failures:
        print(failure, file=sys.stderr)
    if missing_line:
        print('A re-run of this job reads the pull request body as it was when the run started. After editing it, '
              'push a commit or close and reopen the pull request, unless the calling workflow also runs on `edited`.',
              file=sys.stderr)
    print(f'check-new-dependencies: {manifests} manifests, {len(new)} new direct dependencies, {len(failures)} findings')
    return 1 if failures else 0


try:
    sys.exit(main(sys.argv))
except CheckError as err:
    print(f'check-new-dependencies: {err}', file=sys.stderr)
    sys.exit(2)
