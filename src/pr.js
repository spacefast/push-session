import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export async function resolvePullRequest({ cwd = process.cwd(), ref, ...dependencies } = {}) {
  const client = await githubClient({ cwd, ...dependencies });
  let repo;
  let number;
  let url;
  if (client.gh) {
    const args = ["pr", "view", ...(ref && ref !== true ? [String(ref)] : []), "--json", "number,url,state"];
    const pull = await client.ghJson(args);
    ({ repo, number, url } = parsePullUrl(pull.url));
    if (pull.state !== "OPEN") throw new Error("The pull request is not open.");
  } else {
    if (ref && ref !== true && !/^\d+$/.test(String(ref))) {
      ({ repo, number } = parsePullUrl(ref));
    } else {
      const remote = await client.git(["remote", "get-url", "origin"]);
      const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?$/);
      if (!match) throw new Error("The origin remote is not a GitHub repository. Pass --pr <url>.");
      repo = match[1].replace(/\.git$/, "");
      if (ref && ref !== true) number = Number(ref);
    }
    let pull;
    if (number) {
      pull = await client.request(`repos/${repo}/pulls/${number}`);
    } else {
      const branch = await client.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
      const pulls = await client.request(`repos/${repo}/pulls?state=open&head=${head}&per_page=100`);
      if (!Array.isArray(pulls) || pulls.length !== 1) {
        throw new Error("Could not find exactly one open pull request for this branch. Pass --pr <number|url>.");
      }
      [pull] = pulls;
    }
    if (pull.state !== "open") throw new Error("The pull request is not open.");
    ({ repo, number, url } = parsePullUrl(pull.html_url));
  }
  const repository = await client.request(`repos/${repo}`);
  if (typeof repository.private !== "boolean") throw new Error("Could not determine whether the pull request repository is public.");
  return { repo, number, url, isPrivate: repository.private };
}

export async function upsertSessionComment({ repo, number, marker, body, ...dependencies }) {
  if (!REPO_PATTERN.test(repo) || !Number.isSafeInteger(number) || number < 1) throw new Error("Invalid pull request target.");
  if (!/^<!-- push-session:[^<>\r\n]+ -->$/.test(marker)) throw new Error("Invalid session comment marker.");
  const client = await githubClient(dependencies);
  const commentBody = `${marker}\n${body}`;
  for (let page = 1; ; page += 1) {
    const comments = await client.request(`repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("GitHub returned an unreadable comment list.");
    const existing = comments.find((comment) => comment.body?.split(/\r?\n/).includes(marker));
    if (existing) {
      if (!Number.isSafeInteger(existing.id)) throw new Error("GitHub returned an invalid comment ID.");
      const comment = await client.request(`repos/${repo}/issues/comments/${existing.id}`, "PATCH", { body: commentBody });
      return { action: "updated", url: comment.html_url };
    }
    if (comments.length < 100) break;
  }
  const comment = await client.request(`repos/${repo}/issues/${number}/comments`, "POST", { body: commentBody });
  return { action: "created", url: comment.html_url };
}

function parsePullUrl(value) {
  const match = String(value).match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Expected a GitHub pull request URL.");
  return { repo: match[1], number: Number(match[2]), url: `https://github.com/${match[1]}/pull/${match[2]}` };
}

async function githubClient({ cwd = process.cwd(), env = process.env, execImpl = execFileAsync, fetchImpl = globalThis.fetch } = {}) {
  const exec = (command, args) => execImpl(command, args, { cwd, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  let gh = false;
  try {
    await exec("gh", ["--version"]);
    gh = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not run gh. Check your GitHub CLI installation.");
  }
  if (!gh && !env.GITHUB_TOKEN) throw new Error("GitHub access is unavailable. Install and sign in to gh, or set GITHUB_TOKEN.");

  const ghJson = async (args) => {
    try {
      const { stdout } = await exec("gh", args);
      return JSON.parse(stdout);
    } catch {
      // exec errors can include the comment body; keep shared links out of warnings.
      throw new Error("GitHub CLI request failed. Check gh auth login, repository permissions, and the open PR; try --pr <url>.");
    }
  };
  return {
    gh,
    ghJson,
    async git(args) {
      try {
        const { stdout } = await exec("git", args);
        return stdout.trim();
      } catch {
        throw new Error("Could not resolve the current git branch or origin. Run inside the repository or pass --pr <url>.");
      }
    },
    async request(endpoint, method = "GET", data) {
      if (gh) {
        return ghJson(["api", "--hostname", "github.com", endpoint, "--method", method,
          ...(data ? ["--raw-field", `body=${data.body}`] : [])]);
      }
      let response;
      try {
        response = await fetchImpl(`https://api.github.com/${endpoint}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          ...(data && { body: JSON.stringify(data) }),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
      } catch {
        throw new Error("Could not reach the GitHub API.");
      }
      if (!response.ok) throw new Error(`GitHub request failed (${response.status}). Check GITHUB_TOKEN and repository permissions.`);
      try {
        return await response.json();
      } catch {
        throw new Error("GitHub returned an unreadable response.");
      }
    },
  };
}
