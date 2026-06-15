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
      if (isGood === 'true') {
        good.push(`- "${original.trim()}" -> "${replacement.trim()}"`);
      } else {
        bad.push(`- "${original.trim()}" -> "${replacement.trim()}" (WRONG)`);
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

function buildPrompt(text, target, fewShotSection, chunkIndex, totalChunks) {
  const chunkLabel = totalChunks > 1
    ? `This is chunk ${chunkIndex + 1} of ${totalChunks} from a larger document. Keep the same tone and formatting style as the input chunk.`
    : 'This is the full document.';

  return `You are an accessibility tool for dyslexic readers. You replace visually difficult words with easier alternatives while fully preserving meaning, tone, and reading level.

${chunkLabel}

--- STEP 1: ASSESS ---
Read the full text. Estimate reading level 1-10 (1=child, 10=academic). Keep the output within ONE level below the original. Never sacrifice precision for simplicity. A level 9 text stays at level 8, not level 5.

--- STEP 2: FIND TARGET WORDS ---
Flag words in these categories: ${target}

Look for:
- Letters b/d, p/q, l/i, ll/li, n/u, x/i, i/j in words
- Double letters ll, dd, pp, tt, bb, rr
- Long or complex words 7+ characters
- Visually dense or irregular words ONLY if a precise synonym exists in context

--- STEP 3: REPLACE ---
1. Replace as little as possible. Only change words that clearly improve readability.
2. Phrases are often better than single word replacements.
3. High reading level texts (7-10): keep replacements sophisticated.
4. Exact meaning must be preserved. If no accurate replacement exists, leave the word unchanged.
5. Be consistent within this chunk.
6. Never replace proper nouns, names, places, acronyms, numbers, dates, formulas, citations, references, URLs, email addresses, or scientific terms.
7. Do not add, remove, or invent facts.
8. Do not rewrite the whole passage if only a few words need changes.

${fewShotSection}

--- STEP 4: FORMAT ---
Return only the transformed text.
- Preserve the original structure as closely as possible.
- Keep existing headings, bullets, numbering, and paragraph breaks.
- Do not add new headings, lists, notes, comments, or explanations.
- Do not wrap the answer in code fences.
- If the safest choice is to leave a span unchanged, leave it unchanged.

Text to process:
${text}`;
}

async function transformChunk(chunk, target, fewShotSection, chunkIndex, totalChunks) {
  const prompt = buildPrompt(chunk, target, fewShotSection, chunkIndex, totalChunks);
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

  const profileInstructions = {
    all: 'visually confusing letter patterns (b/d, p/q, l/i, ll/li, n/u), visually complex words, and words longer than 6-8 characters',
    letters: 'visually confusing letter patterns only (b/d, p/q, l/i, ll/li, n/u)',
    length: 'words longer than 7 characters — flag every word over 7 characters and replace with a shorter word or phrase if one exists',
    complex: 'words with visually crowded or irregular letter shapes — including double letters (ll, dd, pp, rr, tt), mixed ascenders and descenders (b, d, p, q, f, g, j, y), and irregular sequences that are hard to track visually'
  };

  const target = profileInstructions[profile] || profileInstructions.all;
  const { good, bad } = loadFewShotExamples();

  const fewShotSection = `
--- REFERENCE EXAMPLES ---
These are verified good replacements — use these as guidance:
${good.join('\n')}

These are known bad replacements — never do these:
${bad.join('\n')}
`;

  try {
    const chunks = splitIntoChunks(normalizedText);
    const transformedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const transformedChunk = await transformChunk(chunks[i], target, fewShotSection, i, chunks.length);
      transformedChunks.push(transformedChunk);
    }

    const transformed = cleanupTransformedText(transformedChunks.join('\n\n'));

    res.status(200).json({ transformed });
  } catch (err) {
    console.log('Catch error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}
