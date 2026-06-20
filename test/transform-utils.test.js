import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupTransformedText,
  guardAgainstHallucination,
  normalizeInputText,
  splitIntoChunks
} from '../api/transform-utils.js';

// ── Transform utils tests (existing) ──

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

// ── Diff logic tests ──
// Duplicating the diff functions here since app.js is a browser script, not a module.

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'during','before','after','above','below','between','out','off','over','under',
  'again','further','then','once','here','there','when','where','why','how',
  'all','both','each','few','more','most','other','some','such','no','nor','not',
  'only','own','same','so','than','too','very','just','because','but','and','or',
  'if','while','although','though','that','this','these','those','i','me','my',
  'we','our','you','your','he','him','his','she','her','it','its','they','them',
  'their','what','which','who','whom'
]);

function tokenize(text) {
  return text
    .replace(/[#*_`~>\[\]()!]/g, '')
    .replace(/[^\w\s'-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 0);
}

function extractChangedWords(originalText, transformedText) {
  const origWords = tokenize(originalText);
  const transWords = tokenize(transformedText);
  const pairs = [];

  let oi = 0;
  let ti = 0;
  let hadMatch = false;

  while (oi < origWords.length && ti < transWords.length) {
    if (origWords[oi] === transWords[ti]) {
      hadMatch = true;
      oi++;
      ti++;
      continue;
    }

    if (!hadMatch) {
      oi++;
      ti++;
      continue;
    }

    let found = false;
    const nextOrig = origWords[oi + 1];

    if (nextOrig) {
      for (let span = 1; span <= 3; span++) {
        if (ti + span < transWords.length && transWords[ti + span] === nextOrig) {
          const origWord = origWords[oi];
          const replacement = transWords.slice(ti, ti + span).join(' ');

          if (origWord.length > 2 && !STOP_WORDS.has(origWord) && replacement.length > 1) {
            pairs.push({ original: origWord, replacement });
          }

          oi += 1;
          ti += span;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      hadMatch = false;
      const resyncLimit = Math.min(8, origWords.length - oi, transWords.length - ti);
      let resynced = false;
      for (let ahead = 1; ahead <= resyncLimit; ahead++) {
        if (origWords[oi + ahead] && origWords[oi + ahead] === transWords[ti + ahead]) {
          oi += ahead;
          ti += ahead;
          resynced = true;
          break;
        }
      }
      if (!resynced) {
        oi++;
        ti++;
      }
    }
  }

  return pairs;
}

// ── Diff: catches a real single-word substitution ──

test('extractChangedWords catches a clean single-word substitution', () => {
  const original = 'The accommodation was difficult to find.';
  const transformed = 'The location was hard to find.';
  const pairs = extractChangedWords(original, transformed);

  const originals = pairs.map(p => p.original);
  assert.ok(originals.includes('accommodation'), 'should detect accommodation -> location');
  assert.ok(originals.includes('difficult'), 'should detect difficult -> hard');
});

test('extractChangedWords catches a word-to-phrase substitution', () => {
  const original = 'The constellations are visible tonight.';
  const transformed = 'The groups of stars are visible tonight.';
  const pairs = extractChangedWords(original, transformed);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].original, 'constellations');
  assert.equal(pairs[0].replacement, 'groups of stars');
});

// ── Diff: does NOT produce garbage from shifted indices ──

test('extractChangedWords produces no garbage when text is fully rewritten', () => {
  const original = 'Hello, I am Arth Mohan and I work at Peepal Consulting.';
  const transformed = 'Hi, I\'m Arth Mohan and I work at Peepal Consulting.';
  const pairs = extractChangedWords(original, transformed);

  // Should NOT produce pairs like "the -> mohan" or "companies -> introduction"
  const garbage = pairs.filter(p =>
    p.original === 'the' || p.original === 'companies' ||
    p.replacement === 'mohan' || p.replacement === '#'
  );
  assert.equal(garbage.length, 0, 'should produce no garbage pairs');
});

test('extractChangedWords skips stop words and short words', () => {
  const original = 'It is a very good day.';
  const transformed = 'It was a very nice day.';
  const pairs = extractChangedWords(original, transformed);

  // "is" -> "was" should be skipped (stop word). "good" -> "nice" could be caught.
  const stopWordPairs = pairs.filter(p => STOP_WORDS.has(p.original));
  assert.equal(stopWordPairs.length, 0, 'should not record stop word substitutions');
});

test('extractChangedWords returns empty for identical texts', () => {
  const text = 'The quick brown fox jumps over the lazy dog.';
  const pairs = extractChangedWords(text, text);
  assert.equal(pairs.length, 0);
});

test('extractChangedWords handles totally different texts without crashing', () => {
  const original = 'Alpha beta gamma delta epsilon.';
  const transformed = 'One two three four five six seven.';
  const pairs = extractChangedWords(original, transformed);
  // Should return something (maybe empty, maybe partial) but definitely no crash
  assert.ok(Array.isArray(pairs));
});

// ── Hallucination guard tests ──

test('guardAgainstHallucination passes through normal output', () => {
  const original = 'The accommodation was approximately fundamental to the operation.';
  const transformed = 'The place to stay was roughly key to the operation.';
  const result = guardAgainstHallucination(original, transformed);
  assert.equal(result, transformed);
});

test('guardAgainstHallucination trims when model adds content', () => {
  const original = 'The study was fundamental. Results were clear.';
  const hallucinated = 'The study was key. Results were clear. Additionally the researchers found several other interesting patterns in the data that warranted further investigation and analysis across multiple domains.';
  const result = guardAgainstHallucination(original, hallucinated);
  assert.ok(result.length < hallucinated.length, 'should trim the output');
  assert.ok(result.includes('key'), 'should keep the real replacement');
});
