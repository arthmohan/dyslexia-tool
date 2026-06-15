import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupTransformedText,
  normalizeInputText,
  splitIntoChunks
} from '../api/transform-utils.js';

test('normalizeInputText cleans line endings and extra blank lines', () => {
  const result = normalizeInputText('Hello\r\n\r\nWorld  \n\n\nAgain');
  assert.equal(result, 'Hello\n\nWorld\n\nAgain');
});

test('splitIntoChunks keeps short text in one chunk', () => {
  const result = splitIntoChunks('Short paragraph only.', 100);
  assert.deepEqual(result, ['Short paragraph only.']);
});

test('splitIntoChunks breaks long text into multiple bounded chunks', () => {
  const input = [
    'Paragraph one with several words and enough length to matter.',
    'Paragraph two with several words and enough length to matter.',
    'Paragraph three with several words and enough length to matter.'
  ].join('\n\n');

  const result = splitIntoChunks(input, 80);
  assert.ok(result.length > 1);
  assert.ok(result.every(chunk => chunk.length <= 80));
});

test('cleanupTransformedText strips fences and boilerplate', () => {
  const result = cleanupTransformedText('```markdown\nHere is the transformed text:\n- item One more sentence\n```');
  assert.equal(result, '- item\n\nOne more sentence');
});
