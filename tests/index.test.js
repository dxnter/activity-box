import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Toolkit } from 'actions-toolkit';
import { GistBox } from 'gist-box';
import nock from 'nock';

jest.mock('gist-box');

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

describe('activity-box', () => {
  let runAction, tools;

  beforeEach(() => {
    delete process.env.ACTIVITY_BOX_RETRY_DELAY_MS;

    GistBox.prototype.update = jest.fn();

    Toolkit.run = (actionFunction) => {
      runAction = actionFunction;
    };

    // eslint-disable-next-line unicorn/prefer-module
    require('..');

    tools = new Toolkit({
      logger: {
        info: jest.fn(),
        success: jest.fn(),
        warn: jest.fn(),
        fatal: jest.fn(),
        debug: jest.fn(),
      },
    });

    tools.exit = {
      success: jest.fn(),
      failure: jest.fn(),
    };
  });

  it('updates the Gist with the expected string when events exist', async () => {
    nock('https://api.github.com')
      .get('/users/clippy/events/public?per_page=100')
      .reply(200, events);

    await runAction(tools);
    expect(GistBox.prototype.update).toHaveBeenCalled();
    expect(GistBox.prototype.update.mock.calls[0][0]).toMatchSnapshot();
  });

  it('retries transient failures when fetching user activity', async () => {
    process.env.ACTIVITY_BOX_RETRY_DELAY_MS = '0';

    nock('https://api.github.com')
      .get('/users/clippy/events/public?per_page=100')
      .replyWithError('Premature close')
      .get('/users/clippy/events/public?per_page=100')
      .reply(200, events);

    await runAction(tools);

    expect(tools.exit.failure).not.toHaveBeenCalled();
    expect(GistBox.prototype.update).toHaveBeenCalled();
    expect(tools.log.debug).toHaveBeenCalledWith(
      'Retrying activity fetch for clippy after transient error (1/3)',
    );
  });

  it('handles failure to update the Gist', async () => {
    nock('https://api.github.com')
      .get('/users/clippy/events/public?per_page=100')
      .reply(200, events);

    GistBox.prototype.update.mockImplementationOnce(() => {
      throw new Error('404');
    });

    await runAction(tools);
    expect(tools.exit.failure).toHaveBeenCalled();
    expect(tools.exit.failure.mock.calls).toMatchSnapshot();
  });

  it('updates the Gist with fallback message if no events are found', async () => {
    nock('https://api.github.com')
      .get('/users/clippy/events/public?per_page=100')
      .reply(200, []);

    await runAction(tools);

    expect(GistBox.prototype.update).toHaveBeenCalled();
    expect(GistBox.prototype.update.mock.calls[0][0]).toMatchSnapshot();
  });
});
