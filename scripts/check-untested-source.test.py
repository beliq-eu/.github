#!/usr/bin/env python3
"""Runs check-untested-source.py as a subprocess against throwaway git repos.

Run: python3 scripts/check-untested-source.test.py
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('check-untested-source.py')

# The user's own git config (hooks, signing, identity includes) stays out of the throwaway repos.
GIT_ENV = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}

BASE = {
    'app/selection.py': 'def pick():\n    return 1\n',
    'app/data.json': '{}\n',
    'src/route.ts': 'export const a = 1;\n',
    'scripts/build.py': 'print(1)\n',
    'tests/test_selection.py': 'def test_pick():\n    assert True\n',
    'README.md': 'x\n',
}


def make_repo(root, head_files):
    """A repo whose HEAD~1 holds BASE and HEAD holds BASE changed by head_files (None deletes)."""
    repo = Path(tempfile.mkdtemp(dir=root))

    def commit(files, message):
        for path, content in files.items():
            target = repo / path
            if content is None:
                target.unlink()
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        subprocess.run(['git', 'add', '-A'], cwd=repo, check=True, env=GIT_ENV)
        subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
                        'commit', '-q', '--allow-empty', '-m', message], cwd=repo, check=True, env=GIT_ENV)

    subprocess.run(['git', 'init', '-q', str(repo)], check=True, env=GIT_ENV)
    commit(BASE, 'base')
    commit(head_files, 'head')
    return repo


class UntestedSourceCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_check(self, head, body='', prefixes=('app/', 'src'), base_ref='HEAD~1'):
        repo = make_repo(self.tmp.name, head)
        result = subprocess.run([sys.executable, str(SCRIPT), base_ref, 'HEAD', *prefixes], cwd=repo,
                                env={**GIT_ENV, 'PR_BODY': body}, capture_output=True, text=True, timeout=60)
        return result.returncode, result.stdout, result.stderr

    def test_a_source_change_without_a_test_or_a_line_fails_and_names_the_file(self):
        code, out, err = self.run_check({'app/selection.py': 'def pick():\n    return 2\n'}, body='Picks 2.')
        self.assertEqual(code, 1)
        self.assertIn('  app/selection.py\n', err)
        self.assertIn('"No-Test: <why no test can hold this change>"', err)
        self.assertIn('close and reopen the pull request', err)
        self.assertIn('1 source files and 0 test files', out)

    def test_a_source_change_with_a_test_change_passes(self):
        code, out, err = self.run_check({
            'app/selection.py': 'def pick():\n    return 2\n',
            'tests/test_selection.py': 'def test_pick():\n    assert pick() == 2\n',
        })
        self.assertEqual(code, 0, err)
        self.assertIn('1 source files and 1 test files', out)

    def test_a_new_fixture_under_a_test_directory_counts_as_a_test(self):
        code, _, err = self.run_check({
            'src/route.ts': 'export const a = 2;\n',
            'test/fixtures/invoice.xml': '<Invoice/>\n',
        })
        self.assertEqual(code, 0, err)

    def test_a_reason_line_passes_and_is_printed(self):
        code, out, err = self.run_check(
            {'src/route.ts': '// The engine answers in under 1 s.\nexport const a = 1;\n'},
            body='Adds a comment.\r\n\r\nNo-Test: a comment only, no behaviour changes\r\n')
        self.assertEqual(code, 0, err)
        self.assertIn('No-Test: a comment only, no behaviour changes', out)

    def test_the_line_may_be_a_bullet_in_any_case(self):
        code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n'},
                                      body='- no-test: `log text only`')
        self.assertEqual(code, 0, err)

    def test_a_line_without_a_reason_fails(self):
        code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n'}, body='No-Test:  ``\n')
        self.assertEqual(code, 1)
        self.assertIn('The No-Test line gives no reason.', err)

    def test_a_line_that_does_not_start_the_line_does_not_count(self):
        code, _, _ = self.run_check({'src/route.ts': 'export const a = 2;\n'},
                                    body='<!-- No-Test: from the template -->\nSee No-Test: below')
        self.assertEqual(code, 1)

    def test_a_line_inside_a_multiline_comment_or_a_code_fence_does_not_count(self):
        head = {'src/route.ts': 'export const a = 2;\n'}
        for body in ('<!--\nNo-Test: <reason>\n-->\n', 'Example:\n```\nNo-Test: a comment only\n```\n',
                     '<!-- the template, never closed\nNo-Test: x'):
            code, _, _ = self.run_check(head, body=body)
            self.assertEqual(code, 1, body)
        code, _, err = self.run_check(head, body='<!-- template -->\n```\nexample\n```\nNo-Test: log text only')
        self.assertEqual(code, 0, err)

    def test_markdown_under_a_test_directory_is_not_a_test(self):
        code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n', 'test/README.md': 'How to run.\n'})
        self.assertEqual(code, 1)
        self.assertIn('  src/route.ts\n', err)

    def test_a_prefix_is_read_as_git_prints_paths(self):
        code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n'}, prefixes=('./src',))
        self.assertEqual(code, 1)
        self.assertIn('  src/route.ts\n', err)

    def test_a_prefix_outside_the_repository_makes_the_check_exit_2(self):
        for bad in ('.', '/', '../src'):
            code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n'}, prefixes=(bad,))
            self.assertEqual(code, 2, bad)
            self.assertIn('is not a directory inside the repository', err)

    def test_a_test_file_under_a_source_prefix_is_a_test_not_source(self):
        code, out, err = self.run_check({'src/route.test.ts': 'test("a", () => {});\n'})
        self.assertEqual(code, 0, err)
        self.assertIn('0 source files and 1 test files', out)

    def test_a_file_without_a_code_extension_is_not_source(self):
        code, out, err = self.run_check({'app/data.json': '{"a": 1}\n'})
        self.assertEqual(code, 0, err)
        self.assertIn('0 source files', out)

    def test_code_outside_the_prefixes_is_not_source(self):
        code, _, err = self.run_check({'scripts/build.py': 'print(2)\n'})
        self.assertEqual(code, 0, err)

    def test_a_prefix_matches_whole_directory_names_only(self):
        code, _, err = self.run_check({'application/x.py': 'x = 1\n', 'srcs/y.ts': 'export {};\n'})
        self.assertEqual(code, 0, err)

    def test_deleting_source_needs_no_test(self):
        code, _, err = self.run_check({'app/selection.py': None})
        self.assertEqual(code, 0, err)

    def test_a_renamed_source_file_counts_as_added(self):
        code, _, err = self.run_check({'app/selection.py': None, 'app/pick.py': BASE['app/selection.py']})
        self.assertEqual(code, 1)
        self.assertIn('  app/pick.py\n', err)

    def test_vendored_code_is_skipped(self):
        code, _, err = self.run_check({'src/vendor/lib.js': 'x();\n', 'app/node_modules/m/i.js': 'y();\n'})
        self.assertEqual(code, 0, err)

    def test_no_prefix_is_a_usage_error(self):
        code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n'}, prefixes=())
        self.assertEqual(code, 2)
        self.assertIn('usage:', err)

    def test_a_missing_base_makes_the_check_exit_2(self):
        code, _, err = self.run_check({'src/route.ts': 'export const a = 2;\n'}, base_ref='no-such-ref')
        self.assertEqual(code, 2)
        self.assertIn('check-untested-source: git diff no-such-ref HEAD', err)


if __name__ == '__main__':
    unittest.main()
