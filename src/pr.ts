const COMMENT_TAG_LINK = '<!-- openapi-sync-link -->'
const COMMENT_TAG_WARNING = '<!-- openapi-sync-warning -->'
const COMMENT_TAG_MERGED = '<!-- openapi-sync-merged -->'
const WARNING_LABEL = 'Source PR Not Merged'

export interface PrOptions {
  githubToken: string
  sourceRepo: string
  sourcePrNumber: number
  sourcePrMerged: boolean
  targetRepo: string
  targetPrNumber: number
}

interface GitHubComment {
  id: number
  body: string
}

/** Make an authenticated request to the GitHub API. */
async function githubApi(
  method: string,
  url: string,
  token: string,
  body?: Record<string, unknown>
): Promise<Response> {
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  }
  if (body !== undefined) {
    options.body = JSON.stringify(body)
  }
  return fetch(url, options)
}

/** Find an existing comment on a PR/issue by its HTML comment tag. */
async function findComment(repo: string, prNumber: number, tag: string, token: string): Promise<GitHubComment | null> {
  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`
  const response = await githubApi('GET', url, token)

  if (!response.ok) {
    console.warn(`Warning: Failed to list comments on ${repo}#${prNumber}: ${response.status}`)
    return null
  }

  const comments: unknown = await response.json()
  if (!Array.isArray(comments)) {
    return null
  }
  return comments.find((c: GitHubComment) => c.body.includes(tag)) ?? null
}

/** Create or update a comment on a PR/issue, identified by its HTML comment tag. */
async function upsertComment(repo: string, prNumber: number, tag: string, body: string, token: string): Promise<void> {
  const existing = await findComment(repo, prNumber, tag, token)

  if (existing) {
    const url = `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`
    const response = await githubApi('PATCH', url, token, { body })
    if (!response.ok) {
      console.warn(`Warning: Failed to update comment on ${repo}#${prNumber}: ${response.status}`)
    }
  } else {
    const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`
    const response = await githubApi('POST', url, token, { body })
    if (!response.ok) {
      console.warn(`Warning: Failed to create comment on ${repo}#${prNumber}: ${response.status}`)
    }
  }
}

/** Add a label to a PR/issue. */
async function addLabel(repo: string, prNumber: number, label: string, token: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels`
  const response = await githubApi('POST', url, token, { labels: [label] })
  if (!response.ok) {
    console.warn(`Warning: Failed to add label "${label}" to ${repo}#${prNumber}: ${response.status}`)
  }
}

/** Remove a label from a PR/issue. */
async function removeLabel(repo: string, prNumber: number, label: string, token: string): Promise<void> {
  const encodedLabel = encodeURIComponent(label)
  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels/${encodedLabel}`
  const response = await githubApi('DELETE', url, token)
  // 404 means label wasn't there
  if (!response.ok && response.status !== 404) {
    console.warn(`Warning: Failed to remove label "${label}" from ${repo}#${prNumber}: ${response.status}`)
  }
}

/** Handle PR lifecycle actions. */
export async function handlePrLifecycle(options: PrOptions): Promise<void> {
  const { githubToken, sourceRepo, sourcePrNumber, sourcePrMerged, targetRepo, targetPrNumber } = options

  const targetPrUrl = `https://github.com/${targetRepo}/pull/${targetPrNumber}`

  // Comment on source PR with link to target PR
  const linkBody = `${COMMENT_TAG_LINK}\nOpenAPI Sync PR: [${targetRepo}#${targetPrNumber}](${targetPrUrl})`
  await upsertComment(sourceRepo, sourcePrNumber, COMMENT_TAG_LINK, linkBody, githubToken)

  // Handle source PR status on target PR
  if (!sourcePrMerged) {
    await addLabel(targetRepo, targetPrNumber, WARNING_LABEL, githubToken)

    const warningBody = `${COMMENT_TAG_WARNING}\n⚠️ The source changes are not finalized yet. Do not merge this PR until the source changes are ready.`
    await upsertComment(targetRepo, targetPrNumber, COMMENT_TAG_WARNING, warningBody, githubToken)
  } else {
    await removeLabel(targetRepo, targetPrNumber, WARNING_LABEL, githubToken)

    const mergedBody = `${COMMENT_TAG_MERGED}\n✅ The source changes have been finalized. This PR is ready for review.`
    await upsertComment(targetRepo, targetPrNumber, COMMENT_TAG_MERGED, mergedBody, githubToken)
  }
}
