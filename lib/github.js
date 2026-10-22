// Fetches a public GitHub repository through the GitHub REST API.
// Nothing from the repository is ever executed: the code is downloaded as a
// zip archive and read as text.
import { readZip } from './zip.js';

const API = 'https://api.github.com';
const MAX_ZIP_BYTES = 60 * 1024 * 1024;   // refuse very large archives
const MAX_FILE_BYTES = 250 * 1024;        // skip single files larger than this
const MAX_TOTAL_BYTES = 40 * 1024 * 1024; // total uncompressed text we keep

export class UserError extends Error {}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  'venv', '.venv', 'env', '__pycache__', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.idea', '.vscode', '.gradle', 'Pods', '.dart_tool', '.pytest_cache', '.mypy_cache',
  'bower_components', '.terraform', '.cache', '.parcel-cache',
]);

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tif', 'tiff', 'psd', 'ai',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'jar', 'war', 'ear', 'class', 'exe', 'dll',
  'so', 'dylib', 'o', 'a', 'lib', 'pyc', 'pyo', 'mp3', 'mp4', 'wav', 'ogg', 'mov', 'avi',
  'mkv', 'webm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'sqlite', 'sqlite3', 'db', 'mdb',
  'accdb', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'bin', 'dat', 'pkl', 'pickle',
  'h5', 'hdf5', 'onnx', 'pt', 'pth', 'npy', 'npz', 'parquet', 'apk', 'ipa', 'dmg', 'iso',
]);

const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock',
  'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'go.sum', 'packages.lock.json', 'bun.lockb',
]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

/** Validate and parse a https://github.com/<owner>/<repo> URL. */
export function parseRepoUrl(input, label = 'Repository') {
  if (typeof input !== 'string' || !input.trim()) throw new UserError(`${label} URL is missing.`);
  const s = input.trim();
  let u;
  try { u = new URL(s); } catch { throw new UserError(`${label}: "${s}" is not a valid URL.`); }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password ||
      u.port || u.search || u.hash) {
    throw new UserError(`${label}: only https://github.com/<owner>/<repository> URLs are accepted.`);
  }
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new UserError(`${label}: the URL must point to a repository, like https://github.com/owner/repo.`);
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw new UserError(`${label}: "${owner}/${repo}" is not a valid GitHub repository name.`);
  }
  return { owner, repo };
}

export function validateRef(ref, label = 'Branch') {
  if (ref == null || ref === '') return null;
  const r = String(ref).trim();
  if (!r) return null;
  if (!REF_RE.test(r) || r.includes('..') || r.startsWith('/') || r.endsWith('/')) {
    throw new UserError(`${label}: "${r}" is not a valid branch name or commit SHA.`);
  }
  return r;
}

function ghHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'uni-project-reviewer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(path, notFoundMessage) {
  const res = await fetch(API + path, { headers: ghHeaders() });
  if (res.status === 404) throw new UserError(notFoundMessage);
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new UserError('GitHub API rate limit reached. Wait an hour, or add a GITHUB_TOKEN environment variable in Vercel to raise the limit.');
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${path}`);
  return res;
}

const ghJson = async (path, msg) => (await ghFetch(path, msg)).json();

function extOf(path) {
  const base = path.split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function skipReason(path, size) {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((s) => SKIP_DIRS.has(s))) return 'dependency/build folder';
  const base = segments[segments.length - 1];
  if (LOCK_FILES.has(base)) return 'lock file';
  if (/\.min\.(js|css)$/i.test(base) || base.endsWith('.map')) return 'minified/generated';
  if (BINARY_EXT.has(extOf(base))) return 'binary';
  if (size > MAX_FILE_BYTES) return 'too large';
  return null;
}

/** Extract only the code cells of a Jupyter notebook. */
function notebookToText(raw) {
  try {
    const nb = JSON.parse(raw);
    return (nb.cells || []).map((c, i) => {
      const src = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
      return `# ---- cell ${i + 1} (${c.cell_type}) ----\n${src}`;
    }).join('\n\n');
  } catch {
    return raw;
  }
}

/**
 * Download a repository at an exact commit.
 * @returns {Promise<{owner, repo, branch, sha, description, inventory, files, commits, commitsTruncated}>}
 */
export async function fetchRepo({ owner, repo }, ref, label = 'Repository') {
  const name = `${owner}/${repo}`;
  const missing = `${label} ${name} was not found, or it is private. Only public repositories can be reviewed (unless a GITHUB_TOKEN with access is configured).`;

  const meta = await ghJson(`/repos/${owner}/${repo}`, missing);
  const branch = ref || meta.default_branch;
  const commit = await ghJson(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
    `${label}: branch or commit "${branch}" does not exist in ${name}.`,
  );
  const sha = commit.sha;

  const zipRes = await ghFetch(`/repos/${owner}/${repo}/zipball/${sha}`, missing);
  const declared = Number(zipRes.headers.get('content-length') || 0);
  if (declared > MAX_ZIP_BYTES) throw new UserError(`${label} ${name} is too large to review (over 60 MB).`);
  const buf = Buffer.from(await zipRes.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new UserError(`${label} ${name} is too large to review (over 60 MB).`);

  const inventory = [];
  let total = 0;
  const entries = readZip(buf, {
    filter: ({ name: full, size }) => {
      const path = full.split('/').slice(1).join('/'); // drop "owner-repo-sha/" prefix
      if (!path) return false;
      const reason = skipReason(path, size);
      if (reason) { inventory.push({ path, size, included: false, reason }); return false; }
      if (total + size > MAX_TOTAL_BYTES) {
        inventory.push({ path, size, included: false, reason: 'size budget' });
        return false;
      }
      total += size;
      return true;
    },
  });

  const files = [];
  for (const { name: full, data } of entries) {
    const path = full.split('/').slice(1).join('/');
    if (data.subarray(0, 8000).includes(0)) {
      inventory.push({ path, size: data.length, included: false, reason: 'binary' });
      continue;
    }
    let text = data.toString('utf8');
    if (path.toLowerCase().endsWith('.ipynb')) text = notebookToText(text);
    files.push({ path, text });
    inventory.push({ path, size: data.length, included: true });
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));

  const rawCommits = await ghJson(`/repos/${owner}/${repo}/commits?sha=${sha}&per_page=100`, missing);
  const commits = rawCommits.map((c) => ({
    sha: c.sha.slice(0, 7),
    author: c.commit?.author?.name || '',
    login: c.author?.login || '',
    authorDate: c.commit?.author?.date || '',
    committerDate: c.commit?.committer?.date || '',
    message: (c.commit?.message || '').split('\n')[0].slice(0, 140),
  }));

  return {
    owner, repo, branch, sha,
    description: meta.description || '',
    createdAt: meta.created_at || '',
    pushedAt: meta.pushed_at || '',
    inventory, files, commits,
    commitsTruncated: rawCommits.length === 100,
  };
}

/** Commit history of a single file: how many commits touched it and when it first appeared. */
export async function fileHistory(r, path) {
  try {
    const list = await ghJson(
      `/repos/${r.owner}/${r.repo}/commits?sha=${r.sha}&path=${encodeURIComponent(path)}&per_page=100`,
      'not found',
    );
    if (!list.length) return null;
    const dates = list.map((c) => c.commit?.author?.date).filter(Boolean).sort();
    return {
      commits: list.length,
      truncated: list.length === 100,
      firstAuthorDate: dates[0] || '',
      lastAuthorDate: dates[dates.length - 1] || '',
      firstCommitMessage: (list[list.length - 1].commit?.message || '').split('\n')[0].slice(0, 120),
    };
  } catch {
    return null;
  }
}
