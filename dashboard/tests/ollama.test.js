import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FLINT_TEST_MODE = '1';

import { isOllamaReachable, listModels, generate } from '../ollama.js';

test('isOllamaReachable returns true in TEST_MODE', async () => {
  assert.equal(await isOllamaReachable(), true);
});

test('listModels returns ["llama3"] in TEST_MODE', async () => {
  assert.deepEqual(await listModels(), ['llama3']);
});

test('generate returns "test response" in TEST_MODE', async () => {
  assert.equal(await generate('llama3', 'hello'), 'test response');
});
