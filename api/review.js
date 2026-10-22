// POST /api/review  ->  streams newline-delimited JSON events:
//   {type:"status", message}  {type:"meta", ...}  {type:"text", text}
//   {type:"error", message}   {type:"done", usage}
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseRepoUrl, validateRef, fetchRepo, fileHistory, UserError } from '../lib/github.js';
import { compareRepos } from '../lib/similarity.js';
import { systemPrompt, buildUserMessage } from '../lib/prompt.js';
import { streamClaude, ClaudeError } from '../lib/anthropic.js';

const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
};
const LEVELS = new Set(['', '1st year', '2nd year', '3rd year', 'Final year / thesis', "Master's"]);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function passwordOk(given) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected) return false;
  const a = createHash('sha256').update(String(given || '')).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function POST(request) {
  if (!process.env.APP_PASSWORD || !process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'Server is not configured: set APP_PASSWORD and ANTHROPIC_API_KEY in Vercel environment variables.' });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Invalid request body.' }); }
  if (!passwordOk(body?.password)) return json(401, { error: 'Wrong password.' });

  // Validate everything before starting the stream.
  let primaryRef, compareRef, starterRef, branch, options, model;
  try {
    primaryRef = parseRepoUrl(body.repoUrl, 'Student repository');
    branch = validateRef(body.branch);
    compareRef = body.compareUrl?.trim() ? parseRepoUrl(body.compareUrl, 'Comparison repository') : null;
    starterRef = body.starterUrl?.trim() ? parseRepoUrl(body.starterUrl, 'Starter code repository') : null;
    const courseLevel = str(body.courseLevel, 40);
    if (!LEVELS.has(courseLevel)) throw new UserError('Unknown course level.');
    options = {
      courseLevel,
      deadline: str(body.deadline, 40),
      rubric: str(body.rubric, 8000),
      notes: str(body.notes, 2000),
    };
    model = MODELS[body.model] || process.env.MODEL || MODELS.opus;
  } catch (e) {
    return json(400, { error: e instanceof UserError ? e.message : 'Invalid input.' });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      try {
        send({ type: 'status', message: `Fetching ${primaryRef.owner}/${primaryRef.repo} from GitHub…` });
        const primary = await fetchRepo(primaryRef, branch, 'Student repository');

        let compare = null;
        let starter = null;
        if (compareRef) {
          send({ type: 'status', message: `Fetching ${compareRef.owner}/${compareRef.repo}…` });
          compare = await fetchRepo(compareRef, null, 'Comparison repository');
        }
        if (starterRef) {
          send({ type: 'status', message: `Fetching starter code ${starterRef.owner}/${starterRef.repo}…` });
          starter = await fetchRepo(starterRef, null, 'Starter code repository');
        }

        let similarity = null;
        const histories = [];
        if (compare) {
          send({ type: 'status', message: 'Comparing code similarity…' });
          similarity = compareRepos(primary.files, compare.files, starter?.files || []);
          for (const p of similarity.topPairs.slice(0, 4)) {
            const [a, b] = await Promise.all([fileHistory(primary, p.fileA), fileHistory(compare, p.fileB)]);
            histories.push({ fileA: p.fileA, fileB: p.fileB, a, b });
          }
        }

        const user = buildUserMessage({ primary, compare, starter, similarity, histories, options });
        send({
          type: 'meta',
          repo: `${primary.owner}/${primary.repo}`,
          sha: primary.sha,
          branch: primary.branch,
          files: primary.files.length,
          omitted: user.omitted.primary,
          compare: compare ? `${compare.owner}/${compare.repo}` : null,
          similarity: similarity ? { aInB: similarity.overallAinB, bInA: similarity.overallBinA } : null,
          model,
        });
        send({ type: 'status', message: 'Professor is reviewing the code…' });

        let usage = {};
        let stopReason = null;
        for await (const evt of streamClaude({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model,
          system: systemPrompt(),
          user: user.text,
          maxTokens: 14000,
          signal: request.signal,
        })) {
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            send({ type: 'text', text: evt.delta.text });
          } else if (evt.type === 'message_start') {
            usage = { ...evt.message?.usage };
          } else if (evt.type === 'message_delta') {
            usage = { ...usage, ...evt.usage };
            stopReason = evt.delta?.stop_reason || stopReason;
          }
        }
        send({ type: 'done', usage, stopReason });
      } catch (e) {
        if (e?.name === 'AbortError') return controller.close();
        let message = 'Something went wrong. Check the Vercel function logs.';
        if (e instanceof UserError) message = e.message;
        else if (e instanceof ClaudeError) message = `Claude API error (${e.status}): ${e.message}`;
        if (!(e instanceof UserError)) console.error(e);
        send({ type: 'error', message });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
