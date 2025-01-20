import 'dotenv/config';

import { Toolkit } from 'actions-toolkit';
import { GistBox, MAX_LENGTH, MAX_LINES } from 'gist-box';

const capitalize = (string_) =>
  string_.slice(0, 1).toUpperCase() + string_.slice(1);

const truncate = (string_) =>
  string_.length <= MAX_LENGTH
    ? string_
    : string_.slice(0, MAX_LENGTH - 3) + '...';

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

    tools.log.debug(`Fetching activity for ${GH_USERNAME}`);
    const response = await tools.github.activity.listPublicEventsForUser({
      username: GH_USERNAME,
      per_page: 100,
    });

    const events = response.data || [];

    tools.log.debug(`Found ${events.length} events for ${GH_USERNAME}`);

    const content = events
      .filter((event) => serializers[event.type])
      .slice(0, MAX_LINES)
      .map((item) => serializers[item.type](item))
      .map((entry) => truncate(entry))
      .join('\n');

    const box = new GistBox({ id: GIST_ID, token: GH_PAT });

    try {
      tools.log.debug(`Updating Gist with ID: ${GIST_ID}`);

      await box.update({ content });

      tools.exit.success('Gist updated successfully!');
    } catch (error) {
      tools.log.debug('Failed to update the Gist');
      tools.exit.failure(error);
    }
  },
  {
    event: 'schedule',
    secrets: ['GITHUB_TOKEN', 'GH_PAT', 'GH_USERNAME', 'GIST_ID'],
  },
);
