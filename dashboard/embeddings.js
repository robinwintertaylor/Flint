// Generates a text embedding vector.
// Provider priority: OpenAI → OpenRouter → Mammouth → null (embeddings disabled)
// All three use the same OpenAI-compatible /v1/embeddings endpoint format.

const PROVIDERS = [
  {
    name:    'openai',
    envKey:  'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    model:   'text-embedding-3-small',
  },
  {
    name:    'openrouter',
    envKey:  'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    model:   'openai/text-embedding-3-small',
  },
  {
    name:    'mammouth',
    envKey:  'MAMMOUTH_API_KEY',
    baseURL: 'https://api.mammouth.ai/v1',
    // Mammouth exposes GPT-compatible embedding endpoint; use the standard model name
    model:   'text-embedding-3-small',
  },
];

export async function generateEmbedding(text, { providerOverride } = {}) {
  const candidates = providerOverride
    ? PROVIDERS.filter(p => p.name === providerOverride)
    : PROVIDERS;

  for (const provider of candidates) {
    const key = process.env[provider.envKey];
    if (!key) continue;
    try {
      const res = await fetch(`${provider.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
          // OpenRouter requires an HTTP-Referer or site URL header
          ...(provider.name === 'openrouter' ? { 'HTTP-Referer': 'https://flint.local' } : {}),
        },
        body: JSON.stringify({ model: provider.model, input: text }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.warn(`[embeddings] ${provider.name} error ${res.status}: ${err.slice(0, 200)}`);
        continue;
      }
      const data = await res.json();
      const vec = data?.data?.[0]?.embedding;
      if (vec) return vec;
    } catch (err) {
      console.warn(`[embeddings] ${provider.name} failed: ${err.message}`);
    }
  }
  return null;
}

// Returns which embedding provider is currently active (first with a key).
export function activeEmbeddingProvider() {
  for (const p of PROVIDERS) {
    if (process.env[p.envKey]) return { name: p.name, model: p.model };
  }
  return null;
}
