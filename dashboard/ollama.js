const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function getBaseUrl() {
  return process.env.OLLAMA_URL ?? 'http://localhost:11434';
}

export async function isOllamaReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  if (TEST_MODE()) return ['llama3'];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

export async function generate(model, prompt, opts = {}) {
  if (TEST_MODE()) return 'test response';
  const res = await fetch(`${getBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, ...opts }),
  });
  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status}`);
  const data = await res.json();
  return data.response;
}
