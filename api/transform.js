import fs from 'fs';
import path from 'path';
import {
  cleanupTransformedText,
  MAX_INPUT_CHARS,
  normalizeInputText,
  splitIntoChunks
} from './transform-utils.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_RETRIES = 2;

// Parses a single CSV line, handling quoted fields with escaped quotes.
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// Check if a word contains visually confusing letter patterns (b/d, p/q, l/i, etc.)
function hasLetterConfusion(word) {
  const w = word.toLowerCase();
  return /[bdpq]/.test(w) || /l[il]|il|li/.test(w) || /[nu]{2}/.test(w) || /[ij]/.test(w);
}

// Check if a word has visual complexity (double letters, mixed ascenders/descenders)
function isVisuallyComplex(word) {
  const w = word.toLowerCase();
  return /(.)\1/.test(w) || /[bdfghjklpqty]{3,}/.test(w);
}

function loadFewShotExamples(profile) {
  try {
    const csvPath = path.join(process.cwd(), 'public', 'feedback.csv');
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n').slice(1);

    const good = [];
    const bad = [];

    lines.forEach(line => {
      const fields = parseCSVLine(line);
      const [original, replacement, isGood] = fields;
      if (!original || !replacement) return;

      const trimOrig = original.trim();
      const trimRepl = replacement.trim();

      // Filter examples to match the active profile so the model does not
      // treat cross-category examples as blanket permission.
      if (profile === 'letters') {
        if (!hasLetterConfusion(trimOrig)) return;
      } else if (profile === 'length') {
        if (trimOrig.length < 7) return;
      } else if (profile === 'complex') {
        if (!isVisuallyComplex(trimOrig)) return;
      }
      // 'all' profile: show everything

      if (isGood === 'true') {
        good.push(`- "${trimOrig}" -> "${trimRepl}"`);
      } else {
        bad.push(`- "${trimOrig}" -> "${trimRepl}" (WRONG)`);
      }
    });

    return { good, bad };
  } catch (err) {
    return { good: [], bad: [] };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryDelayMs(message = '') {
  const match = message.match(/try again in\s+([\d.]+)s/i);
  if (!match) return 0;
  return Math.ceil(Number(match[1]) * 1000);
}

async function requestGroq(prompt) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 4096
      })
    });

    const rawBody = await response.text();
    let data;

    try {
      data = rawBody ? JSON.parse(rawBody) : {};
    } catch (err) {
      data = { error: { message: rawBody || 'Groq returned an unreadable response' } };
    }

    console.log('Groq response status:', response.status);

    if (response.ok) {
      return data;
    }

    lastError = {
      status: response.status,
      message: data.error?.message || 'Groq request failed'
    };

    console.log('Groq error:', JSON.stringify(data, null, 2));

    if (response.status !== 429 || attempt === MAX_RETRIES) {
      break;
    }

    const delayMs = parseRetryDelayMs(lastError.message) || 25000;
    console.log(`Rate limited. Retrying in ${delayMs}ms...`);
    await sleep(delayMs);
  }

  const error = new Error(lastError?.message || 'Groq request failed');
  error.status = lastError?.status || 500;
  throw error;
}

const profileConfigs = {
  all: {
    target: 'visually confusing letter patterns (b/d, p/q, l/i, ll/li, n/u), visually complex words, and words longer than 6-8 characters',
    constraint: `You may replace words from ANY of these categories: confusing letter patterns, long words, and visually complex words. But still be selective. Only replace a word when a clearly better alternative exists. Most sentences should have 0-3 replacements, not wholesale rewriting.`,
    exclusions: ''
  },
  letters: {
    target: 'words containing visually confusing letter patterns: b/d, p/q, l/i, ll/li, n/u, i/j',
    constraint: `You may ONLY replace words where confusing letter shapes (b/d, p/q, l/i, ll/li, n/u, i/j) are the PRIMARY readability barrier. The letter pattern must be a significant part of why the word is hard to read, not just incidentally present.`,
    exclusions: `OFF LIMITS for this profile:
- Do NOT replace a word just because it is long. "approximately" is long but has no confusing letter pattern. Leave it.
- Do NOT replace a word just because it looks complex or has double letters. "accommodation" has double letters but its main issue is letter confusion (d). Only replace it if the b/d/p/q/l/i pattern is the problem.
- If a word's only issue is length or visual density, leave it unchanged.`
  },
  length: {
    target: 'words longer than 7 characters where a shorter, precise alternative exists',
    constraint: `You may ONLY replace words that are longer than 7 characters AND where a shorter word or phrase preserves the exact same meaning. The replacement must be noticeably shorter or simpler to scan.`,
    exclusions: `OFF LIMITS for this profile:
- Do NOT replace short words (7 characters or fewer), no matter how confusing their letters look.
- Do NOT replace a long word if no shorter alternative preserves its meaning precisely.
- "bilateral" is 9 characters, but if no short synonym fits the context, leave it.`
  },
  complex: {
    target: 'visually crowded words with double letters (ll, dd, pp, rr, tt, bb, ff, ss), dense ascender/descender clusters, or irregular letter shapes that are hard to track visually',
    constraint: `You may ONLY replace words whose visual shape is the readability barrier: double letters, dense vertical strokes, or crowded ascender/descender patterns. The word must genuinely look hard to track on the page.`,
    exclusions: `OFF LIMITS for this profile:
- Do NOT replace a word just because it is long. Length alone is not visual complexity.
- Do NOT replace a word because of b/d or p/q confusion. That belongs to a different profile.
- "fundamental" is long but visually clean. Leave it. "accommodation" has dd and mm, so it qualifies.`
  }
};

function buildPrompt(text, profile, fewShotSection, chunkIndex, totalChunks) {
  const config = profileConfigs[profile] || profileConfigs.all;

  const chunkLabel = totalChunks > 1
    ? `This is chunk ${chunkIndex + 1} of ${totalChunks} from a larger document. Keep the same tone and formatting style as the input chunk.`
    : '';

  return `You are a targeted accessibility tool for dyslexic readers.

YOUR SINGLE JOB: Find and replace ONLY the specific types of visually difficult words described in the ACTIVE PROFILE below. Leave all other words exactly as they are, even if you know a simpler alternative.

=== ACTIVE PROFILE ===
Target: ${config.target}
${config.constraint}
${config.exclusions ? '\n' + config.exclusions : ''}
=== END PROFILE ===

RULES:
1. Assess reading level (1-10). Keep output within one level of the original. A level 9 text stays at 8, not 5.
2. Replace as few words as possible. Most sentences need 0-2 replacements. If a sentence has no target words, return it unchanged.
3. Phrases are often better than single-word swaps ("accommodation" -> "place to stay").
4. Meaning must be exactly preserved. If no precise replacement exists, leave the word.
5. Be consistent: if you replace a word, replace it every time it appears.
6. Never replace: proper nouns, names, places, acronyms, numbers, dates, scientific terms, URLs.
7. Do not add, remove, or rearrange content. Do not add headings, bullets, or formatting that was not in the original.
8. Do not rewrite passages. Only swap individual words or short phrases.
${chunkLabel ? '\n' + chunkLabel : ''}
${fewShotSection}

Return ONLY the transformed text. No preamble, no notes, no code fences, no explanation.

Text to process:
${text}`;
}

async function transformChunk(chunk, profile, fewShotSection, chunkIndex, totalChunks) {
  const prompt = buildPrompt(chunk, profile, fewShotSection, chunkIndex, totalChunks);
  const data = await requestGroq(prompt);
  const transformed = cleanupTransformedText(data.choices?.[0]?.message?.content || '');

  if (!transformed) {
    const error = new Error('Groq returned no output');
    error.status = 500;
    throw error;
  }

  return transformed;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, profile } = req.body;
  const normalizedText = normalizeInputText(text);

  if (!normalizedText) return res.status(400).json({ error: 'No text provided' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY in environment.' });
  if (normalizedText.length > MAX_INPUT_CHARS) {
    return res.status(400).json({
      error: `This document is too large right now. Please keep it under ${MAX_INPUT_CHARS.toLocaleString()} characters.`
    });
  }

  const validProfile = profileConfigs[profile] ? profile : 'all';
  const { good, bad } = loadFewShotExamples(validProfile);

  let fewShotSection = '';
  if (good.length > 0 || bad.length > 0) {
    fewShotSection = `
REFERENCE EXAMPLES (for replacement quality, not blanket permission):
${good.length > 0 ? 'Good:\n' + good.join('\n') : ''}
${bad.length > 0 ? 'Bad (never do these):\n' + bad.join('\n') : ''}`;
  }

  try {
    const chunks = splitIntoChunks(normalizedText);
    const transformedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const transformedChunk = await transformChunk(chunks[i], validProfile, fewShotSection, i, chunks.length);
      transformedChunks.push(transformedChunk);
    }

    const transformed = cleanupTransformedText(transformedChunks.join('\n\n'));

    res.status(200).json({ transformed });
  } catch (err) {
    console.log('Catch error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}
