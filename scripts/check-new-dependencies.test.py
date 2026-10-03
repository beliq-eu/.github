#!/usr/bin/env python3
"""Runs check-new-dependencies.py as a subprocess against throwaway git repos.

The registries are a local HTTP server that answers in npm's, PyPI's and Packagist's shapes,
so every case is deterministic. With GUARD_LIVE_REGISTRIES=1 one more case runs against the
real registries, to prove those shapes still hold.

Run: python3 scripts/check-new-dependencies.test.py
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).with_name('check-new-dependencies.py')

# The user's own git config (hooks, signing, identity includes) stays out of the throwaway repos.
GIT_ENV = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}


def days_ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%S.000Z')


class FakeRegistry:
    """Answers GET requests from a path -> (status, JSON body) table and records each path."""

    def __init__(self):
        self.routes = {}
        self.requested = []
        registry = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                registry.requested.append(self.path)
                status, body = registry.routes.get(self.path, (404, {'error': 'not found'}))
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def npm(self, name, created_days_ago):
        self.routes[f"/npm/{urllib.parse.quote(name, safe='@')}"] = (
            200, {'name': name, 'versions': {'1.0.0': {}}, 'time': {'created': days_ago(created_days_ago)}})

    def pypi(self, normalized, first_days_ago):
        self.routes[f'/pypi/{normalized}/'] = (200, {'files': [
            {'filename': 'b.whl', 'upload-time': days_ago(first_days_ago - 1)},
            {'filename': 'a.tar.gz', 'upload-time': days_ago(first_days_ago)},
        ]})

    def packagist(self, name, first_days_ago, dev_only=False):
        versions = [{'version': '1.1.0', 'time': days_ago(first_days_ago - 1)},
                    {'version': '1.0.0', 'time': days_ago(first_days_ago)}]
        self.routes[f'/packagist/p2/{name}.json'] = (200, {'packages': {name: [] if dev_only else versions}})
        if dev_only:
            self.routes[f'/packagist/p2/{name}~dev.json'] = (200, {'packages': {name: versions}})

    def env(self):
        return {'GUARD_NPM_REGISTRY': f'{self.base}/npm',
                'GUARD_PYPI_SIMPLE': f'{self.base}/pypi',
                'GUARD_PACKAGIST': f'{self.base}/packagist'}


def make_repo(root, base_files, head_files):
    """A repo whose HEAD~1 holds base_files and HEAD holds head_files (None deletes a file)."""
    repo = Path(tempfile.mkdtemp(dir=root))

    def commit(files, message):
        for path, content in files.items():
            target = repo / path
            if content is None:
                target.unlink()
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content if isinstance(content, str) else json.dumps(content))
        subprocess.run(['git', 'add', '-A'], cwd=repo, check=True, env=GIT_ENV)
        subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
                        'commit', '-q', '--allow-empty', '-m', message], cwd=repo, check=True, env=GIT_ENV)

    subprocess.run(['git', 'init', '-q', str(repo)], check=True, env=GIT_ENV)
    commit(base_files, 'base')
    commit(head_files, 'head')
    return repo


class NewDependencyCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.registry = FakeRegistry()

    @classmethod
    def tearDownClass(cls):
        cls.registry.server.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        self.registry.routes.clear()
        self.registry.requested.clear()

    def run_check(self, base, head, body='', base_ref='HEAD~1', extra_env=None):
        repo = make_repo(self.tmp.name, base, head)
        env = {**GIT_ENV, **self.registry.env(), 'PR_BODY': body, **(extra_env or {})}
        result = subprocess.run([sys.executable, str(SCRIPT), base_ref, 'HEAD'], cwd=repo, env=env,
                                capture_output=True, text=True, timeout=120)
        return result.returncode, result.stdout, result.stderr

    def test_no_new_dependency_passes(self):
        pkg = {'dependencies': {'left-pad': '^1.3.0'}}
        code, out, err = self.run_check({'package.json': pkg}, {'package.json': pkg, 'README.md': 'x'})
        self.assertEqual(code, 0, err)
        self.assertIn('1 manifests, 0 new direct dependencies, 0 findings', out)
        self.assertEqual(self.registry.requested, [])

    def test_a_new_npm_dependency_with_a_reason_passes(self):
        self.registry.npm('left-pad', 3000)
        code, out, err = self.run_check(
            {'package.json': {'dependencies': {}}},
            {'package.json': {'dependencies': {'left-pad': '^1.3.0'}}},
            body='Adds padding.\r\n\r\nNew-Dependency: left-pad pads the invoice number column\r\n')
        self.assertEqual(code, 0, err)
        self.assertIn('package.json: left-pad (npm): pads the invoice number column', out)
        self.assertIn('1 new direct dependencies, 0 findings', out)

    def test_a_new_dependency_without_a_line_fails_and_names_the_line(self):
        self.registry.npm('left-pad', 3000)
        code, _, err = self.run_check(
            {'package.json': {'dependencies': {}}},
            {'package.json': {'devDependencies': {'left-pad': '1.3.0'}}},
            body='New-Dependency: right-pad is not the one added')
        self.assertEqual(code, 1)
        self.assertIn('package.json: left-pad (npm) is new; add "New-Dependency: left-pad <why it is needed>"', err)
        self.assertIn('close and reopen the pull request', err)

    def test_a_line_without_a_reason_fails(self):
        self.registry.npm('left-pad', 3000)
        code, _, err = self.run_check(
            {'package.json': {}},
            {'package.json': {'dependencies': {'left-pad': '1.3.0'}}},
            body='New-Dependency: left-pad -')
        self.assertEqual(code, 1)
        self.assertIn('the New-Dependency line for left-pad gives no reason', err)

    def test_a_name_the_registry_does_not_know_fails(self):
        code, _, err = self.run_check(
            {'package.json': {}},
            {'package.json': {'dependencies': {'leftpad-utils-pro': '1.0.0'}}},
            body='New-Dependency: leftpad-utils-pro pads things')
        self.assertEqual(code, 1)
        self.assertIn('leftpad-utils-pro does not exist on npm, or has no published release', err)

    def test_an_unpublished_npm_package_fails(self):
        self.registry.routes['/npm/gone'] = (200, {'name': 'gone', 'time': {'unpublished': {}}})
        code, _, err = self.run_check({'package.json': {}}, {'package.json': {'dependencies': {'gone': '1'}}},
                                      body='New-Dependency: gone reason')
        self.assertEqual(code, 1)
        self.assertIn('gone does not exist on npm', err)

    def test_a_young_package_fails_until_a_young_line_says_why(self):
        self.registry.npm('fresh-sdk', 5)
        files = ({'package.json': {}}, {'package.json': {'dependencies': {'fresh-sdk': '1.0.0'}}})
        code, _, err = self.run_check(*files, body='New-Dependency: fresh-sdk the vendor SDK')
        self.assertEqual(code, 1)
        self.assertRegex(err, r'fresh-sdk was first published on \d{4}-\d\d-\d\d, 5 days ago; one younger than 30 days')
        code, _, err = self.run_check(
            *files, body='New-Dependency: fresh-sdk the vendor SDK\nYoung-Dependency: fresh-sdk released with the API it wraps')
        self.assertEqual(code, 0, err)

    def test_the_age_floor_is_thirty_days(self):
        self.registry.npm('just-old-enough', 30)
        self.registry.npm('one-day-short', 29)
        code, _, err = self.run_check(
            {'package.json': {}},
            {'package.json': {'dependencies': {'just-old-enough': '1', 'one-day-short': '1'}}},
            body='New-Dependency: just-old-enough a\nNew-Dependency: one-day-short b')
        self.assertEqual(code, 1)
        self.assertIn('one-day-short was first published', err)
        self.assertNotIn('just-old-enough was', err)

    def test_moving_a_dependency_between_sections_or_manifests_is_not_new(self):
        code, out, err = self.run_check(
            {'package.json': {'devDependencies': {'left-pad': '1'}}},
            {'package.json': {'dependencies': {'left-pad': '1'}}, 'packages/a/package.json': {'dependencies': {'left-pad': '1'}}})
        self.assertEqual(code, 0, err)
        self.assertIn('2 manifests, 0 new direct dependencies', out)

    def test_a_scoped_name_is_fetched_with_its_slash_encoded(self):
        self.registry.npm('@acme/http', 400)
        code, _, err = self.run_check({'package.json': {}}, {'package.json': {'dependencies': {'@acme/http': '2.0.0'}}},
                                      body='- New-Dependency: `@acme/http` the HTTP client')
        self.assertEqual(code, 0, err)
        self.assertIn('/npm/@acme%2Fhttp', self.registry.requested)

    def test_an_alias_checks_the_package_it_installs(self):
        self.registry.npm('real-name', 400)
        code, _, err = self.run_check({'package.json': {}}, {'package.json': {'dependencies': {'nick': 'npm:real-name@^2'}}},
                                      body='New-Dependency: real-name aliased as nick')
        self.assertEqual(code, 0, err)
        self.assertEqual(self.registry.requested, ['/npm/real-name'])

    def test_local_dependencies_are_not_checked(self):
        code, out, err = self.run_check(
            {'package.json': {}},
            {'package.json': {'dependencies': {'sibling': 'file:../sibling', 'ws': 'workspace:*', 'tilde': './x'}}})
        self.assertEqual(code, 0, err)
        self.assertIn('0 new direct dependencies', out)

    def test_a_tilde_range_is_a_registry_version_not_a_path(self):
        code, _, err = self.run_check({'package.json': {}}, {'package.json': {'dependencies': {'left-pad': '~1.3.0'}}})
        self.assertEqual(code, 1)
        self.assertIn('left-pad (npm) is new', err)

    def test_a_git_dependency_needs_its_line_but_no_registry(self):
        files = ({'package.json': {}}, {'package.json': {'dependencies': {'forked': 'github:acme/forked#v1'}}})
        code, _, err = self.run_check(*files)
        self.assertEqual(code, 1)
        self.assertIn('forked (npm) is new', err)
        code, out, err = self.run_check(*files, body='New-Dependency: forked carries a fix upstream has not released')
        self.assertEqual(code, 0, err)
        self.assertIn('forked comes from a git or URL source; its existence and age are not checked', out)
        self.assertEqual(self.registry.requested, [])

    def test_pyproject_dependencies_are_read_and_names_normalized(self):
        self.registry.pypi('typing-extensions', 2000)
        self.registry.pypi('zope-interface', 2000)
        self.registry.pypi('hatch-vcs', 2000)
        base = '[project]\nname = "svc"\ndependencies = ["httpx>=0.27"]\n'
        head = ('[build-system]\nrequires = ["hatchling", "hatch-vcs"]\n'
                '[project]\nname = "svc"\ndependencies = [\n  "httpx>=0.27",\n'
                '  "Typing_Extensions[extra]>=4; python_version < \'3.13\'",\n]\n'
                '[project.optional-dependencies]\ndev = ["svc[test]", "zope.interface"]\n'
                '[dependency-groups]\nlint = [{include-group = "dev"}]\n')
        body = ('New-Dependency: typing.extensions backports\nNew-Dependency: Zope_Interface plugin registry\n'
                'New-Dependency: hatch-vcs version from tags\nNew-Dependency: hatchling build backend')
        self.registry.pypi('hatchling', 2000)
        code, out, err = self.run_check({'pyproject.toml': base}, {'pyproject.toml': head}, body=body)
        self.assertEqual(code, 0, err)
        self.assertIn('4 new direct dependencies, 0 findings', out)
        self.assertNotIn('svc', ' '.join(self.registry.requested))

    def test_a_pip_compile_lock_is_skipped_and_a_direct_list_is_read(self):
        lock = 'certifi==2025.1.1 \\\n    --hash=sha256:00\n    # via requests\nidna==3.10\n    # via requests\n'
        direct = '# runtime\nrequests==2.32.3 \\\n    --hash=sha256:11\n-r other.txt\nhttps://example.com/x.whl\n'
        self.registry.pypi('requests', 4000)
        code, out, err = self.run_check({'requirements.lock.txt': '', 'requirements.txt': ''},
                                        {'requirements.lock.txt': lock, 'requirements.txt': direct},
                                        body='New-Dependency: requests HTTP')
        self.assertEqual(code, 0, err)
        self.assertIn('1 new direct dependencies, 0 findings', out)
        self.assertEqual(self.registry.requested, ['/pypi/requests/'])

    def test_composer_skips_platform_names_and_falls_back_to_branch_versions(self):
        self.registry.packagist('acme/tagged', 900)
        self.registry.packagist('acme/branch-only', 900, dev_only=True)
        code, out, err = self.run_check(
            {'composer.json': {'require': {'php': '>=8.1'}}},
            {'composer.json': {'require': {'php': '>=8.2', 'ext-json': '*', 'Acme/Tagged': '^1'},
                               'require-dev': {'acme/branch-only': 'dev-main'}}},
            body='New-Dependency: acme/tagged a\nNew-Dependency: acme/branch-only b')
        self.assertEqual(code, 0, err)
        self.assertIn('2 new direct dependencies, 0 findings', out)
        self.assertIn('/packagist/p2/acme/branch-only~dev.json', self.registry.requested)

    def test_vendored_manifests_are_skipped(self):
        code, out, err = self.run_check({'README.md': 'x'}, {'vendor/lib/composer.json': {'require': {'evil/pkg': '1'}},
                                                             'node_modules/x/package.json': {'dependencies': {'y': '1'}}})
        self.assertEqual(code, 0, err)
        self.assertIn('0 manifests', out)

    def test_a_registry_that_keeps_failing_makes_the_check_exit_2(self):
        self.registry.routes['/npm/flaky'] = (503, {})
        code, _, err = self.run_check({'package.json': {}}, {'package.json': {'dependencies': {'flaky': '1'}}},
                                      body='New-Dependency: flaky reason')
        self.assertEqual(code, 2)
        self.assertIn('HTTP 503', err)
        self.assertEqual(self.registry.requested.count('/npm/flaky'), 3)

    def test_a_broken_manifest_makes_the_check_exit_2(self):
        code, _, err = self.run_check({'package.json': {}}, {'package.json': '{"dependencies": '})
        self.assertEqual(code, 2)
        self.assertIn('HEAD:package.json could not be parsed', err)

    def test_a_missing_base_makes_the_check_exit_2(self):
        code, _, err = self.run_check({'package.json': {}}, {'package.json': {}}, base_ref='HEAD~5')
        self.assertEqual(code, 2)
        self.assertIn('git ls-tree', err)


@unittest.skipUnless(os.environ.get('GUARD_LIVE_REGISTRIES') == '1', 'set GUARD_LIVE_REGISTRIES=1 to query the real registries')
class LiveRegistries(unittest.TestCase):
    def test_old_packages_pass_and_unknown_names_fail_on_each_registry(self):
        unknown = f'guard-no-such-package-{uuid.uuid4().hex}'
        with tempfile.TemporaryDirectory() as root:
            repo = make_repo(root, {'README.md': 'x'}, {
                'package.json': {'dependencies': {'left-pad': '1.3.0', '@sindresorhus/is': '7', unknown: '1'}},
                'requirements.txt': f'requests==2.32.3\n{unknown}==1\n',
                'composer.json': {'require': {'monolog/monolog': '^3', f'{unknown}/{unknown}': '1'}},
            })
            body = '\n'.join(f'New-Dependency: {n} live check' for n in
                             ('left-pad', '@sindresorhus/is', 'requests', 'monolog/monolog', unknown, f'{unknown}/{unknown}'))
            env = {k: v for k, v in GIT_ENV.items() if not k.startswith('GUARD_')}
            result = subprocess.run([sys.executable, str(SCRIPT), 'HEAD~1', 'HEAD'], cwd=repo,
                                    env={**env, 'PR_BODY': body}, capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stderr.count('does not exist on'), 3, result.stderr)
        # The unknown name is new on npm and on PyPI alike, so seven, not six.
        self.assertIn('7 new direct dependencies, 3 findings', result.stdout)


if __name__ == '__main__':
    unittest.main()
