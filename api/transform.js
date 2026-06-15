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

// ── Prompt builders per profile ──
// Each is deliberately short and mechanical. No long instructions, no "leave
// unchanged" examples. Just: criteria, a few replacement examples, and "leave
// everything else alone."

function buildLettersPrompt(text, chunkNote) {
  return `You are a dyslexia accessibility tool. Your ONLY job: find words that contain visually confusing letter combinations and replace them with easier words.

Confusing combinations: b/d, p/q, l/i, i/j, ll, li, il, dd, bb, pp, nn/uu, bd, db, pb, dp.

Scan every word. If it contains one or more of these combinations AND a good replacement exists, replace it. If it does not contain these combinations, leave it exactly as is.

Examples:
- "accommodation" -> "place to stay" (has cc, mm, d)
- "difficult" -> "hard" (has d, i, ff)
- "building" -> "making" (has b, d, i, l)
- "display" -> "show" (has d, p, l, i)
- "bilateral" -> "two-way" (has b, l, i)
- "brilliant" -> "gifted" (has b, ll, i)
- "constellations" -> "star groups" (has ll, i)
- "proliferation" -> "rapid spread" (has p, l, i)

Keep reading level within one level of the original. Preserve meaning exactly. Never touch proper nouns, names, numbers, or acronyms. Do not add or remove content.
${chunkNote}
Return ONLY the transformed text, nothing else.

Text:
${text}`;
}

function buildLengthPrompt(text, chunkNote) {
  return `You are a dyslexia accessibility tool. Your ONLY job: find words longer than 7 characters and replace them with shorter alternatives.

Scan every word. If it has 8 or more characters AND a shorter word or phrase means the same thing, replace it. If the word is 7 characters or shorter, leave it. If no shorter alternative preserves the meaning, leave the long word too.

Examples:
- "accommodation" -> "place to stay"
- "approximately" -> "about"
- "demonstrated" -> "shown"
- "fundamental" -> "key"
- "constellations" -> "star groups"
- "destabilisation" -> "breakdown"
- "proliferation" -> "rapid spread"
- "jurisdictions" -> "regions"

Keep reading level within one level of the original. Preserve meaning exactly. Never touch proper nouns, names, numbers, or acronyms. Do not add or remove content.
${chunkNote}
Return ONLY the transformed text, nothing else.

Text:
${text}`;
}

function buildComplexPrompt(text, chunkNote) {
  return `You are a dyslexia accessibility tool. Your ONLY job: find visually crowded words and replace them with visually cleaner alternatives.

Visually crowded means: double letters (ll, dd, pp, rr, tt, bb, ff, ss, cc, mm, nn), dense clusters of tall/hanging letters (b, d, f, g, h, j, k, l, p, q, t, y close together), or letter shapes that blur into each other.

Scan every word. If it looks visually dense or crowded AND a cleaner-looking replacement exists, replace it. If the word has a clean visual shape, leave it regardless of length.

Examples:
- "accommodation" -> "place to stay" (cc, mm, dd)
- "address" -> "location" (dd, ss)
- "difficult" -> "hard" (ff, mixed shapes)
- "brilliant" -> "gifted" (ll)
- "destabilisation" -> "breakdown" (mixed tall/hanging letters clustered)
- "constellations" -> "star groups" (ll, mixed shapes)

Keep reading level within one level of the original. Preserve meaning exactly. Never touch proper nouns, names, numbers, or acronyms. Do not add or remove content.
${chunkNote}
Return ONLY the transformed text, nothing else.

Text:
${text}`;
}

function buildAllPrompt(text, chunkNote) {
  const { good, bad } = loadFewShotExamples();

  let examplesSection = '';
  if (good.length > 0 || bad.length > 0) {
    examplesSection = `\nReference replacements:
${good.length > 0 ? good.join('\n') : ''}
${bad.length > 0 ? '\nKnown bad replacements (never do these):\n' + bad.join('\n') : ''}`;
  }

  return `You are a dyslexia accessibility tool. Replace visually difficult words with easier alternatives.

Target these categories:
1. Words with confusing letter patterns (b/d, p/q, l/i, ll, dd, bb, pp)
2. Words longer than 7 characters where a shorter alternative exists
3. Visually crowded words with double letters or dense letter shapes

Be selective. A typical paragraph needs 3-6 replacements, not a full rewrite. Only replace a word when you have a clearly better alternative. Keep reading level within one level of the original. Preserve meaning exactly. Never touch proper nouns, names, numbers, or acronyms. Do not add or remove content.
${examplesSection}
${chunkNote}
Return ONLY the transformed text, nothing else.

Text:
${text}`;
}

const promptBuilders = {
  letters: buildLettersPrompt,
  length: buildLengthPrompt,
  complex: buildComplexPrompt,
  all: buildAllPrompt
};

async function transformChunk(chunk, profile, chunkIndex, totalChunks) {
  const chunkNote = totalChunks > 1
    ? `\nThis is chunk ${chunkIndex + 1} of ${totalChunks}. Keep consistent tone and style.`
    : '';

  const builder = promptBuilders[profile] || promptBuilders.all;
  const prompt = builder(chunk, chunkNote);
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

  const validProfile = promptBuilders[profile] ? profile : 'all';

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