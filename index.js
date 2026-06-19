import 'dotenv/config';

export const MAX_LENGTH = 63;
export const MAX_LINES = 5;

const githubApiUrl = 'https://api.github.com';

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

const githubRequest = async (
  path,
  { token, method = 'GET', body, fetchImplementation = globalThis.fetch } = {},
) => {
  const response = await fetchImplementation(`${githubApiUrl}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'activity-box',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = text.length === 0 ? undefined : JSON.parse(text);

  if (!response.ok) {
    const error = new Error(
      data?.message ?? `GitHub request failed with status ${response.status}`,
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
};

export const fetchPublicEvents = async ({
  username,
  token,
  log,
  fetchImplementation,
}) => {
  const retryDelayMs = Number(process.env.ACTIVITY_BOX_RETRY_DELAY_MS ?? 1000);
  const maxAttempts = 3;
  const encodedUsername = encodeURIComponent(username);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await githubRequest(
        `/users/${encodedUsername}/events/public?per_page=100`,
        {
          token,
          fetchImplementation,
        },
      );
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

const updateGist = async ({ id, token, content, fetchImplementation }) => {
  const gist = await githubRequest(`/gists/${id}`, {
    token,
    fetchImplementation,
  });
  const filename = Object.keys(gist.files ?? {})[0];

  if (!filename) {
    throw new Error(`No files found in Gist with ID: ${id}`);
  }

  await githubRequest(`/gists/${id}`, {
    token,
    method: 'PATCH',
    body: {
      files: {
        [filename]: {
          content,
        },
      },
    },
    fetchImplementation,
  });
};

export const run = async ({
  env: environment = process.env,
  fetchImplementation = globalThis.fetch,
  log = console,
} = {}) => {
  const { GIST_ID, GH_USERNAME, GH_PAT, GITHUB_TOKEN } = environment;

  if (!GIST_ID || !GH_USERNAME || !GH_PAT || !GITHUB_TOKEN) {
    throw new Error('Missing one or more required environment variables.');
  }

  let events;

  try {
    log.debug(`Fetching activity for ${GH_USERNAME}`);

    events = await fetchPublicEvents({
      username: GH_USERNAME,
      token: GITHUB_TOKEN,
      log,
      fetchImplementation,
    });

    log.debug(`Found ${events.length} events for ${GH_USERNAME}`);
  } catch (fetchError) {
    log.debug('Failed to fetch user activity');

    throw fetchError;
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

  try {
    log.debug(`Updating Gist with ID: ${GIST_ID}`);

    await updateGist({
      id: GIST_ID,
      token: GH_PAT,
      content,
      fetchImplementation,
    });

    log.log('Gist updated successfully!');
  } catch (updateError) {
    log.debug('Failed to update the Gist');

    throw updateError;
  }
};

const main = async () => {
  try {
    await run();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};

if (process.env.NODE_ENV !== 'test') {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main();
}
