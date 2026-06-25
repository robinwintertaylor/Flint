const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function getBaseUrl() {
  return process.env.LMSTUDIO_URL ?? 'http://localhost:1234';
}

export async function isLmStudioReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  if (TEST_MODE()) return ['local-model'];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

export async function generate(model, prompt, opts = {}) {
  if (TEST_MODE()) return 'test response';
  const res = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...opts,
    }),
  });
  if (!res.ok) throw new Error(`LM Studio generate failed: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}
