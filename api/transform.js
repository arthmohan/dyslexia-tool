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

function loadFewShotExamples() {
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

// ── Profile definitions ──
// Each profile has:
//   target:     what to look for
//   examples:   hardcoded examples showing what TO replace and what to LEAVE ALONE
//   useCsvExamples: whether to include feedback.csv examples

const profileConfigs = {
  all: {
    target: 'visually confusing letter patterns (b/d, p/q, l/i, ll/li, n/u), visually complex words, and words longer than 6-8 characters',
    useCsvExamples: true,
    examples: ''
  },
  letters: {
    target: 'words where confusing letter shapes (b/d, p/q, l/i, ll/li, n/u, i/j) are the main readability barrier',
    useCsvExamples: false,
    examples: `
EXAMPLES FOR THIS PROFILE:
Replace (letter confusion is the core issue):
- "difficult" -> "hard" (d/i pattern makes it hard to track)
- "building" -> "making" (b/d/i/l pattern)
- "display" -> "show" (d/p/l/i cluster)
- "possible" -> "doable" or leave unchanged (p/b pattern, but only replace if context allows)

Leave unchanged (these words are long or complex, but NOT letter-confusion problems):
- "approximately" -> leave it (no confusing letter pattern)
- "fundamental" -> leave it (length is not your concern)
- "constellations" -> leave it (length and complexity, not letter confusion)
- "remarkable" -> leave it (no b/d/p/q/l/i issue)
- "proliferation" -> leave it (length, not letter shapes)

If you are unsure whether a word qualifies as letter confusion, leave it unchanged.`
  },
  length: {
    target: 'words longer than 7 characters, but ONLY when a shorter alternative preserves the exact meaning',
    useCsvExamples: false,
    examples: `
EXAMPLES FOR THIS PROFILE:
Replace (long word, shorter alternative exists):
- "approximately" -> "about"
- "accommodation" -> "place to stay"
- "demonstrated" -> "shown"
- "fundamental" -> "key"

Leave unchanged (long but no good short alternative, or already short enough):
- "bilateral" -> leave it (no common short synonym)
- "difficult" -> leave it (only 9 chars and no shorter precise alternative in most contexts)
- "display" -> leave it (7 chars, already short)
- "brilliant" -> leave it (no shorter word that means the same thing)

Only replace if the shorter alternative is precise. Do not sacrifice meaning for brevity.`
  },
  complex: {
    target: 'visually crowded words: double letters (ll, dd, pp, rr, tt, bb, ff, ss), dense vertical strokes, or irregular letter patterns that are hard to track on the page',
    useCsvExamples: false,
    examples: `
EXAMPLES FOR THIS PROFILE:
Replace (visually dense, hard to track):
- "accommodation" -> "place to stay" (cc + mm double letters)
- "address" -> "location" (dd + ss)
- "difficult" -> "hard" (ff + irregular shape)
- "brilliant" -> "gifted" (ll double letters)

Leave unchanged (long or has confusing letters, but NOT visually crowded):
- "approximately" -> leave it (no double letters, visually clean)
- "fundamental" -> leave it (visually regular shape)
- "destabilisation" -> leave it (long but not visually dense)
- "demonstrated" -> leave it (no doubled or crowded patterns)

Only replace words whose visual SHAPE is the problem, not words that are just long.`
  }
};

function buildPrompt(text, profile, chunkIndex, totalChunks) {
  const config = profileConfigs[profile] || profileConfigs.all;

  const chunkLabel = totalChunks > 1
    ? `\nThis is chunk ${chunkIndex + 1} of ${totalChunks} from a larger document. Keep the same tone and formatting style.`
    : '';

  // Build few-shot section
  let fewShotSection = '';
  if (config.useCsvExamples) {
    const { good, bad } = loadFewShotExamples();
    if (good.length > 0 || bad.length > 0) {
      fewShotSection = `
REFERENCE EXAMPLES (for replacement quality guidance, not a list of words to always replace):
${good.length > 0 ? 'Good:\n' + good.join('\n') : ''}
${bad.length > 0 ? '\nBad (never do these):\n' + bad.join('\n') : ''}`;
    }
  }

  return `You are a targeted accessibility tool for dyslexic readers. You make minimal, precise word replacements to improve readability.

=== YOUR CONSTRAINT ===
ONLY replace words that match this target: ${config.target}

Everything else stays exactly as written. Do not simplify, shorten, or improve words outside this target. If a word does not clearly match the target category, leave it unchanged.
=== END CONSTRAINT ===

RULES:
1. Assess reading level (1-10). Stay within one level of the original.
2. Be MINIMAL. A good transformation changes 2-5 words in a paragraph, not half the sentence.
3. Meaning must be exactly preserved. No precise replacement = leave the word.
4. Be consistent: same word gets same replacement throughout.
5. Never touch: proper nouns, names, places, acronyms, numbers, dates, scientific terms.
6. Do not add, remove, or rearrange content. No new headings, bullets, or formatting.
7. When in doubt, leave the word unchanged. Under-replacing is always better than over-replacing.
${chunkLabel}
${config.examples}
${fewShotSection}

Return ONLY the transformed text. No preamble, no notes, no code fences.

Text to process:
${text}`;
}

async function transformChunk(chunk, profile, chunkIndex, totalChunks) {
  const prompt = buildPrompt(chunk, profile, chunkIndex, totalChunks);
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

  try {
    const chunks = splitIntoChunks(normalizedText);
    const transformedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const transformedChunk = await transformChunk(chunks[i], validProfile, i, chunks.length);
      transformedChunks.push(transformedChunk);
    }

    const transformed = cleanupTransformedText(transformedChunks.join('\n\n'));

    res.status(200).json({ transformed });
  } catch (err) {
    console.log('Catch error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}