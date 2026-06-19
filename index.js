import 'dotenv/config';

import { Toolkit } from 'actions-toolkit';
import { GistBox, MAX_LENGTH, MAX_LINES } from 'gist-box';

const capitalize = (text = '') =>
  text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;

const truncate = (text = '') =>
  text.length <= MAX_LENGTH ? text : text.slice(0, MAX_LENGTH - 3) + '...';

const retryableErrorCodes = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const isRetryableFetchError = (error) => {
  if (retryableErrorCodes.has(error.cause?.code)) {
    return true;
  }

  if ([408, 409, 429].includes(error.status) || error.status >= 500) {
    return true;
  }

  return /premature close|socket hang up|network error/i.test(
    error.message ?? '',
  );
};

const fetchPublicEvents = async ({ github, username, log }) => {
  const retryDelayMs = Number(process.env.ACTIVITY_BOX_RETRY_DELAY_MS ?? 1000);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await github.activity.listPublicEventsForUser({
        username,
        per_page: 100,
      });

      return response.data || [];
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }

      log.debug(
        `Retrying activity fetch for ${username} after transient error (${attempt}/${maxAttempts})`,
      );

      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
};

const serializers = {
  IssueCommentEvent: (item) => {
    const issueNumber = item.payload?.issue?.number ?? 'Unknown';
    const repoName = item.repo?.name ?? 'Unknown Repository';

    return `💬 Commented on #${issueNumber} in ${repoName}`;
  },
  IssuesEvent: (item) => {
    const issueNumber = item.payload?.issue?.number ?? 'Unknown';
    const repoName = item.repo?.name ?? 'Unknown Repository';
    const action = capitalize(item.payload?.action ?? '');

    return `🚩 ${action} issue #${issueNumber} in ${repoName}`;
  },
  PullRequestEvent: (item) => {
    const prNumber = item.payload?.pull_request?.number ?? 'Unknown';
    const repoName = item.repo?.name ?? 'Unknown Repository';
    const merged = item.payload?.pull_request?.merged ?? false;
    const action = capitalize(item.payload?.action ?? '');
    const prefix = merged
      ? '🟢 Merged'
      : action === 'Opened'
        ? '🔀 Opened'
        : `❌ ${action}`;

    return `${prefix} PR #${prNumber} in ${repoName}`;
  },
};

Toolkit.run(
  async (tools) => {
    const { GIST_ID, GH_USERNAME, GH_PAT } = process.env;

    if (!GIST_ID || !GH_USERNAME || !GH_PAT) {
      return tools.exit.failure(
        new Error('Missing one or more required environment variables.'),
      );
    }

    let events;
    try {
      tools.log.debug(`Fetching activity for ${GH_USERNAME}`);

      events = await fetchPublicEvents({
        github: tools.github,
        username: GH_USERNAME,
        log: tools.log,
      });

      tools.log.debug(`Found ${events.length} events for ${GH_USERNAME}`);
    } catch (fetchError) {
      tools.log.debug('Failed to fetch user activity');

      return tools.exit.failure(fetchError);
    }

    let content = events
      .filter((event) => serializers[event.type])
      .slice(0, MAX_LINES)
      .map((event) => serializers[event.type](event))
      .map((line) => truncate(line))
      .join('\n');

    if (!content) {
      content = 'No recent activity found.';
    }

    const box = new GistBox({ id: GIST_ID, token: GH_PAT });

    try {
      tools.log.debug(`Updating Gist with ID: ${GIST_ID}`);

      await box.update({ content });

      tools.exit.success('Gist updated successfully!');
    } catch (updateError) {
      tools.log.debug('Failed to update the Gist');

      tools.exit.failure(updateError);
    }
  },
  {
    event: ['schedule', 'workflow_dispatch'],
    secrets: ['GITHUB_TOKEN', 'GH_PAT', 'GH_USERNAME', 'GIST_ID'],
  },
);
