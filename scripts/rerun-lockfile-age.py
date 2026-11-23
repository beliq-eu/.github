#!/usr/bin/env python3
"""Re-runs the failed `lockfile-age` job on the head of every open pull request.

check-lockfile-age.py fails while a lockfile holds a version that is too young, and nothing
re-runs it once the version has aged: no push, no event. Run once a day, this script re-runs it,
so the pull request goes green on its own and auto-merge can go ahead.

A head counts when its newest `lockfile-age` job, by start time, ended in failure. A run still
in progress, and a job that passed or was cancelled, are left alone.

Environment: GH_TOKEN (actions: write, pull-requests: read), GITHUB_REPOSITORY (owner/name),
GITHUB_API_URL (set by Actions; https://api.github.com otherwise).
Exit codes: 0 done, 2 the API could not be read or a re-run was refused. A refused re-run does not
stop the others.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

JOB_NAME = 'lockfile-age'
PAGE_SIZE = 100
API_TIMEOUT_SECONDS = 30


class ApiError(Exception):
    pass


def api(method, path, token, base):
    request = urllib.request.Request(f'{base}{path}', method=method, headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': f'Bearer {token}',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'beliq-eu-guard',
    })
    try:
        with urllib.request.urlopen(request, timeout=API_TIMEOUT_SECONDS) as response:
            body = response.read()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as err:
        raise ApiError(f'{method} {path}: HTTP {err.code}') from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise ApiError(f'{method} {path}: {err}') from err


def pages(path, key, token, base):
    """Every item of a paginated list. `key` names the array in an object answer, or None."""
    separator = '&' if '?' in path else '?'
    page = 1
    while True:
        body = api('GET', f'{path}{separator}per_page={PAGE_SIZE}&page={page}', token, base)
        items = body if key is None else body[key]
        yield from items
        if len(items) < PAGE_SIZE:
            return
        page += 1


def is_lockfile_age(job):
    # A job of a reusable workflow is named `<caller job> / <job>`.
    return job['name'] == JOB_NAME or job['name'].endswith(f' / {JOB_NAME}')


def newest_lockfile_age_job(repo, sha, token, base):
    jobs = []
    runs = pages(f'/repos/{repo}/actions/runs?event=pull_request&head_sha={sha}', 'workflow_runs', token, base)
    for run in runs:
        # The jobs of the run's latest attempt, which is what the pull request shows.
        jobs += [j for j in pages(f'/repos/{repo}/actions/runs/{run["id"]}/jobs', 'jobs', token, base)
                 if is_lockfile_age(j)]
    return max(jobs, key=lambda j: j.get('started_at') or '', default=None)


def main():
    token = os.environ['GH_TOKEN']
    repo = os.environ['GITHUB_REPOSITORY']
    base = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    rerun = 0
    refused = 0
    pulls = list(pages(f'/repos/{repo}/pulls?state=open', None, token, base))
    for pull in pulls:
        sha = pull['head']['sha']
        job = newest_lockfile_age_job(repo, urllib.parse.quote(sha), token, base)
        if job is None or job['conclusion'] != 'failure':
            continue
        try:
            api('POST', f'/repos/{repo}/actions/jobs/{job["id"]}/rerun', token, base)
        except ApiError as err:
            # GitHub refuses to re-run a run older than 30 days; the other heads still get theirs.
            refused += 1
            print(f'#{pull["number"]}: {err}', file=sys.stderr)
            continue
        rerun += 1
        print(f'#{pull["number"]}: re-ran {job["html_url"]}')
    print(f'rerun-lockfile-age: {len(pulls)} open pull requests, {rerun} jobs re-run, {refused} refused')
    return 2 if refused else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ApiError as err:
        print(f'rerun-lockfile-age: {err}', file=sys.stderr)
        sys.exit(2)
