import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { run } from '..';

const environment = {
  GH_PAT: '123abc',
  GH_USERNAME: 'clippy',
  GIST_ID: '456def',
  GITHUB_TOKEN: '123abcd',
};

const events = [
  {
    type: 'IssuesEvent',
    repo: { name: 'clippy/take-over-github' },
    payload: { action: 'opened', issue: { number: 1 } },
  },
  {
    type: 'IssueCommentEvent',
    repo: { name: 'clippy/take-over-github' },
    payload: { action: 'closed', issue: { number: 1 } },
  },
  {
    type: 'PullRequestEvent',
    repo: { name: 'clippy/take-over-github' },
    payload: { action: 'closed', pull_request: { number: 2, merged: true } },
  },
  {
    type: 'PullRequestEvent',
    repo: { name: 'clippy/take-over-github' },
    payload: { action: 'closed', pull_request: { number: 3, merged: false } },
  },
  {
    type: 'PullRequestEvent',
    repo: {
      name: 'clippy/really-really-really-really-really-really-really-really-really-long',
    },
    payload: { action: 'opened', pull_request: { number: 3 } },
  },
];

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => JSON.stringify(body),
});

const mockFetch = (...responses) => {
  const fetchImplementation = jest.fn();

  for (const nextResponse of responses) {
    if (nextResponse instanceof Error) {
      fetchImplementation.mockRejectedValueOnce(nextResponse);
    } else {
      fetchImplementation.mockResolvedValueOnce(nextResponse);
    }
  }

  return fetchImplementation;
};

const createLogger = () => ({
  debug: jest.fn(),
  log: jest.fn(),
});

describe('activity-box', () => {
  beforeEach(() => {
    delete process.env.ACTIVITY_BOX_RETRY_DELAY_MS;
  });

  it('updates the Gist with the expected string when events exist', async () => {
    const fetchImplementation = mockFetch(
      response(events),
      response({ files: { 'activity.md': {} } }),
      response({}),
    );

    await run({ env: environment, fetchImplementation, log: createLogger() });

    expect(fetchImplementation.mock.calls[2]).toMatchSnapshot();
  });

  it('retries transient failures when fetching user activity', async () => {
    process.env.ACTIVITY_BOX_RETRY_DELAY_MS = '0';

    const log = createLogger();
    const fetchImplementation = mockFetch(
      new Error('Premature close'),
      response(events),
      response({ files: { 'activity.md': {} } }),
      response({}),
    );

    await run({ env: environment, fetchImplementation, log });

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(log.debug).toHaveBeenCalledWith(
      'Retrying activity fetch for clippy after transient error (1/3)',
    );
  });

  it('handles failure to update the Gist', async () => {
    const fetchImplementation = mockFetch(
      response(events),
      response({ files: { 'activity.md': {} } }),
      response({ message: '404' }, { ok: false, status: 404 }),
    );

    await expect(
      run({ env: environment, fetchImplementation, log: createLogger() }),
    ).rejects.toThrow('404');
  });

  it('updates the Gist with fallback message if no events are found', async () => {
    const fetchImplementation = mockFetch(
      response([]),
      response({ files: { 'activity.md': {} } }),
      response({}),
    );

    await run({ env: environment, fetchImplementation, log: createLogger() });

    expect(fetchImplementation.mock.calls[2]).toMatchSnapshot();
  });
});
