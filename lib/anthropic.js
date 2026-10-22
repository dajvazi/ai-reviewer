// Streams a response from the Claude Messages API using plain fetch (no SDK needed).

export class ClaudeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Yields parsed server-sent events from the Messages API.
 */
export async function* streamClaude({ apiKey, model, system, user, maxTokens, signal }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      // Cached, so several reviews within a few minutes reuse the long instructions cheaply.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 400);
    try { msg = JSON.parse(body).error?.message || msg; } catch { /* keep raw */ }
    throw new ClaudeError(res.status, msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.type === 'error') throw new ClaudeError(500, evt.error?.message || 'Claude API stream error');
      yield evt;
    }
  }
}
