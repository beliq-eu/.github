#!/usr/bin/env python3
"""Fails when a pull request changes source code and no test, and its body does not say why.

A bug that comes back is the costly kind, and a test that fails without the fix is what keeps
it out. No check can tell a bug fix from any other change, so this one asks the wider
question: a pull request that adds or modifies source and adds or modifies no test needs a
`No-Test: <reason>` line in its body, where a reviewer reads it.

A source file sits under one of the path prefixes given, has one of CODE_EXTENSIONS, and is
not itself a test. A test file is any file in the repo with a directory named in TEST_DIRS on
its path, or a name TEST_NAME matches; fixtures under a test directory count, Markdown there
does not. A deleted file needs no test, so only added and modified files are read. A rename
reads as a deletion and an addition. A No-Test line inside an HTML comment or a fenced code
block does not count, so a pull request template can show the line without meeting it.

Usage: check-untested-source.py <base> <head> <path prefix>...
The pull request body comes from the PR_BODY environment variable.
Exit codes: 0 clean, 1 findings, 2 the check itself could not run.
The output names changed files, which the pull request already shows.
"""

import os
import posixpath
import re
import subprocess
import sys

CODE_EXTENSIONS = ('.py', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.php')
TEST_DIRS = frozenset({'test', 'tests', 'e2e', '__tests__'})
TEST_NAME = re.compile(r'(\.(test|spec)\.[^.]+$|^test_.*\.py$|_test\.py$)')

# The same exemption as the other checks: vendored code is not ours to test.
SKIP_DIR = re.compile(r'(^|/)(vendor|node_modules)/')

TRAILER = re.compile(r'^[ \t]*(?:[-*][ \t]+)?no-test:(.*)$', re.I | re.M)
# An HTML comment, or a fenced code block, each to its end or to the end of the body.
HIDDEN = re.compile(r'<!--.*?(?:-->|\Z)|^[ \t]*(```|~~~).*?(?:^[ \t]*\1|\Z)', re.S | re.M)


class CheckError(Exception):
    """The check could not run."""


def changed_files(base, head):
    result = subprocess.run(
        ['git', 'diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', base, head],
        capture_output=True)
    if result.returncode != 0:
        raise CheckError(f"git diff {base} {head}: {result.stderr.decode(errors='replace').strip()}")
    names = result.stdout.decode(errors='replace').split('\0')
    return [p for p in names if p and not SKIP_DIR.search(p)]


def is_test(path):
    *dirs, name = path.split('/')
    if TEST_NAME.search(name):
        return True
    return any(d in TEST_DIRS for d in dirs) and not name.lower().endswith('.md')


def is_source(path, prefixes):
    return path.endswith(CODE_EXTENSIONS) and path.startswith(prefixes) and not is_test(path)


def reasons(body):
    """The text after each No-Test: line in the body, stripped."""
    visible = HIDDEN.sub('', body or '')
    return [m.group(1).strip().strip('`').strip() for m in TRAILER.finditer(visible)]


def prefix(path):
    """A path as git prints it, with one trailing slash: `./src` and `src/` give `src/`."""
    normal = posixpath.normpath(path).strip('/')
    if normal in ('', '.') or normal.startswith('..'):
        raise CheckError(f'{path!r} is not a directory inside the repository')
    return normal + '/'


def main(argv):
    if len(argv) < 4:
        print('usage: check-untested-source.py <base> <head> <path prefix>...', file=sys.stderr)
        return 2
    prefixes = tuple(prefix(p) for p in argv[3:])
    files = changed_files(argv[1], argv[2])
    sources = [p for p in files if is_source(p, prefixes)]
    tests = [p for p in files if is_test(p)]
    summary = f'check-untested-source: {len(sources)} source files and {len(tests)} test files added or changed'

    if not sources or tests:
        print(summary)
        return 0

    lines = reasons(os.environ.get('PR_BODY', ''))
    given = [r for r in lines if r]
    if given:
        for reason in given:
            print(f'No-Test: {reason}')
        print(summary)
        return 0

    print('These source files changed and no test did:', file=sys.stderr)
    for path in sources:
        print(f'  {path}', file=sys.stderr)
    if lines:
        print('The No-Test line gives no reason.', file=sys.stderr)
    print('Add a test that fails without the change, or a "No-Test: <why no test can hold this change>" '
          'line to the pull request body.', file=sys.stderr)
    print('A re-run of this job reads the pull request body as it was when the run started. After editing it, '
          'push a commit or close and reopen the pull request, unless the calling workflow also runs on `edited`.',
          file=sys.stderr)
    print(summary)
    return 1


try:
    sys.exit(main(sys.argv))
except CheckError as err:
    print(f'check-untested-source: {err}', file=sys.stderr)
    sys.exit(2)
