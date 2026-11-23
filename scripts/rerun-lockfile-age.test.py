#!/usr/bin/env python3
"""Runs rerun-lockfile-age.py as a subprocess against a local HTTP server in the GitHub API's shape.

Run: python3 scripts/rerun-lockfile-age.test.py
"""

import json
import os
import subprocess
import sys
import threading
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).with_name('rerun-lockfile-age.py')
REPO = 'example-org/example-repo'


class FakeApi:
    """Answers from pulls, runs per head and jobs per run; records every request."""

    def __init__(self):
        self.pulls = []
        self.runs = {}
        self.jobs = {}
        self.posts = []
        self.requests = []
        self.refuse = set()
        self.fail_path = None
        api = self

        class Handler(BaseHTTPRequestHandler):
            def answer(self, status, body):
                payload = b'' if body is None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                api.requests.append(('GET', self.path, self.headers.get('Authorization')))
                url = urllib.parse.urlsplit(self.path)
                query = urllib.parse.parse_qs(url.query)
                page, size = int(query['page'][0]), int(query['per_page'][0])

                def window(items):
                    return items[(page - 1) * size:page * size]

                if api.fail_path and url.path == api.fail_path:
                    return self.answer(500, {'message': 'boom'})
                if url.path == f'/repos/{REPO}/pulls':
                    return self.answer(200, window(api.pulls))
                if url.path == f'/repos/{REPO}/actions/runs':
                    assert query['event'] == ['pull_request'], query
                    return self.answer(200, {'workflow_runs': window(api.runs.get(query['head_sha'][0], []))})
                prefix = f'/repos/{REPO}/actions/runs/'
                if url.path.startswith(prefix) and url.path.endswith('/jobs'):
                    run_id = int(url.path[len(prefix):-len('/jobs')])
                    return self.answer(200, {'jobs': window(api.jobs.get(run_id, []))})
                self.answer(404, {'message': 'Not Found'})

            def do_POST(self):
                api.requests.append(('POST', self.path, self.headers.get('Authorization')))
                api.posts.append(self.path)
                self.answer(403 if self.path in api.refuse else 201, None)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def pull(self, number, sha, runs, run_days_ago=1):
        """runs: [(run id, [(job id, name, status, conclusion, created_at)])]"""
        self.pulls.append({'number': number, 'head': {'sha': sha}})
        self.runs[sha] = [{'id': run_id, 'created_at': days_ago(run_days_ago)} for run_id, _ in runs]
        for run_id, jobs in runs:
            self.jobs[run_id] = [{'id': j, 'name': n, 'status': s, 'conclusion': c, 'created_at': t,
                                  'started_at': None if s == 'queued' else t,
                                  'html_url': f'https://example.invalid/job/{j}'} for j, n, s, c, t in jobs]


def days_ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')


def job(job_id, conclusion, created='2026-11-23T10:00:00Z', name='guard / lockfile-age', status='completed'):
    return (job_id, name, status, conclusion, created)


class RerunLockfileAge(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()

    def tearDown(self):
        self.api.server.shutdown()

    def run_script(self):
        env = {**os.environ, 'GH_TOKEN': 'test-token', 'GITHUB_REPOSITORY': REPO, 'GITHUB_API_URL': self.api.base}
        result = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
        return result.returncode, result.stdout, result.stderr

    def test_a_failed_lockfile_age_job_is_rerun_and_nothing_else(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure'), job(12, 'failure', name='guard / secrets')])])
        self.api.pull(8, 'bbb', [(2, [job(21, 'success')])])
        code, out, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [f'/repos/{REPO}/actions/jobs/11/rerun'])
        self.assertIn('#7: re-ran https://example.invalid/job/11', out)
        self.assertIn('2 open pull requests, 1 jobs re-run, 0 refused', out)
        self.assertTrue(all(auth == 'Bearer test-token' for _, _, auth in self.api.requests))

    def test_only_the_newest_job_on_a_head_counts(self):
        # A body edit starts a second run on the same head; the newer, passing job is what shows.
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure', '2026-11-23T10:00:00Z')]),
                                 (2, [job(21, 'success', '2026-11-23T11:00:00Z')])])
        self.api.pull(8, 'bbb', [(3, [job(31, 'success', '2026-11-23T10:00:00Z')]),
                                 (4, [job(41, 'failure', '2026-11-23T11:00:00Z')])])
        code, _, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [f'/repos/{REPO}/actions/jobs/41/rerun'])

    def test_a_newer_queued_job_beats_an_older_failed_one(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure', '2026-11-23T10:00:00Z')]),
                                 (2, [job(21, None, '2026-11-23T11:00:00Z', status='queued')])])
        code, _, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [])

    def test_a_timed_out_job_is_rerun(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'timed_out')])])
        code, _, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [f'/repos/{REPO}/actions/jobs/11/rerun'])

    def test_a_run_past_the_30_day_limit_is_named_and_not_rerun(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure')])], run_days_ago=31)
        self.api.pull(8, 'bbb', [(2, [job(21, 'failure')])], run_days_ago=29)
        code, out, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [f'/repos/{REPO}/actions/jobs/21/rerun'])
        self.assertIn('#7: https://example.invalid/job/11 is past the 30-day re-run limit', out)

    def test_a_job_in_progress_or_cancelled_is_left_alone(self):
        self.api.pull(7, 'aaa', [(1, [job(11, None, status='in_progress')])])
        self.api.pull(8, 'bbb', [(2, [job(21, 'cancelled')])])
        self.api.pull(9, 'ccc', [])
        code, out, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [])
        self.assertIn('3 open pull requests, 0 jobs re-run, 0 refused', out)

    def test_a_job_of_the_same_name_in_a_repo_own_workflow_counts(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure', name='lockfile-age')])])
        self.api.pull(8, 'bbb', [(2, [job(21, 'failure', name='lockfile-age-report')])])
        code, _, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.api.posts, [f'/repos/{REPO}/actions/jobs/11/rerun'])

    def test_every_page_of_pull_requests_is_read(self):
        for n in range(150):
            self.api.pull(n, f'sha{n}', [])
        self.api.pull(150, 'last', [(1, [job(11, 'failure')])])
        code, out, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertIn('151 open pull requests, 1 jobs re-run', out)

    def test_an_api_error_is_exit_2(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure')])])
        self.api.fail_path = f'/repos/{REPO}/actions/runs/1/jobs'
        code, _, err = self.run_script()
        self.assertEqual(code, 2)
        self.assertIn('HTTP 500', err)
        self.assertEqual(self.api.posts, [])

    def test_a_refused_rerun_is_exit_2_and_the_others_still_run(self):
        self.api.pull(7, 'aaa', [(1, [job(11, 'failure')])])
        self.api.pull(8, 'bbb', [(2, [job(21, 'failure')])])
        self.api.refuse = {f'/repos/{REPO}/actions/jobs/11/rerun'}
        code, out, err = self.run_script()
        self.assertEqual(code, 2)
        self.assertIn(f'#7: POST /repos/{REPO}/actions/jobs/11/rerun: HTTP 403', err)
        self.assertEqual(self.api.posts, [f'/repos/{REPO}/actions/jobs/11/rerun', f'/repos/{REPO}/actions/jobs/21/rerun'])
        self.assertIn('1 jobs re-run, 1 refused', out)


if __name__ == '__main__':
    unittest.main()
