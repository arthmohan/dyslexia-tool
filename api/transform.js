import fs from 'fs';
import path from 'path';
import {
  cleanupTransformedText,
  guardAgainstHallucination,
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

// ── Shared quality rules ──
// Constrained profiles get these. They enforce the "1-2 levels down, same register" behavior.
const QUALITY_RULES = `
QUALITY RULES:
- Reduce reading level by 1-2 levels, no more. Level 9 text becomes level 7-8, not level 4.
- The output must sound like the same type of writing. Academic stays academic. Professional stays professional. Casual stays casual.
- Every replacement must make the sentence easier to read, not harder or more awkward.
- If a replacement changes the register (e.g. "partnerships" -> "tie-ups" in formal text), skip it or find a better fit (e.g. "partnerships" -> "alliances").
- Phrase replacements ("place to stay") are often better than single-word swaps ("location") because they read more naturally.
- Never touch proper nouns, names, numbers, acronyms, dates, or scientific terms.
- Preserve all formatting: headings, bullets, paragraph breaks, emphasis.
- Do not add or remove content.`;

// The "all" profile: replace visually difficult words but PRESERVE REGISTER.
// The old version said "do not hold back" and the model made professional
// documents sound childish. The rules below lead with tone preservation
// and add an explicit do-not-touch list of common professional vocabulary.
const ALL_QUALITY_RULES = `
QUALITY RULES (in priority order):

1. PRESERVE REGISTER. This is the most important rule. If the input is professional, business, academic, or technical, the output must sound the same. Test every replacement: does the sentence still fit the document's tone? If not, keep the original word. A slightly harder word at the right register beats an easier word that sounds childish or out of place.

2. Reduce reading load by 1-2 levels, no more. Level 10 text becomes level 8-9, not level 4.

3. DO NOT replace these common professional/business/academic words even if they look complex. They are already accessible and replacing them destroys register:
   conversations, stakeholders, essential, effective, guidance, insurance, contracts, invoicing, compliance, regulations, requirements, framework, evaluation, professional, business, financial, industry, agreement, document, application, information, department, government, appropriate, particular, additional, significant, established, considerable, international, understanding, operations, activities, materials, resources, procedures, standards, policies, protocols, statements.

4. Only replace a word when BOTH conditions hold:
   (a) it is visually difficult (letter confusion, 8+ chars with a shorter equivalent, or dense visual shape), AND
   (b) a natural same-register replacement exists.
   If either fails, leave the word alone.

5. Phrase replacements ("place to stay", "make worse") often read more naturally than forced single-word swaps.

6. NEVER touch proper nouns, names, numbers, acronyms, dates, currency, technical terms, industry terms, or scientific terms.

7. PRESERVE ALL FORMATTING as markdown. Headings stay headings (# ## ###). Bullets stay bullets (- or *). Numbered lists stay numbered (1. 2. 3.). Paragraph breaks stay. Bold and italic stay.

8. Do not add or remove content. Never invent new phrases, clauses, or sentences. Only replace existing words.

9. Return the output as clean markdown so the frontend can render it. Do not wrap the response in code fences.`;

// ── Per-profile prompts ──

function buildAllPrompt(text, chunkNote) {
  const { good, bad } = loadFewShotExamples();

  let examplesSection = '';
  if (good.length > 0 || bad.length > 0) {
    examplesSection = `\nReference replacements:
${good.length > 0 ? good.join('\n') : ''}
${bad.length > 0 ? '\nKnown bad (never do these):\n' + bad.join('\n') : ''}`;
  }

  return `You are a dyslexia accessibility tool for adult readers of professional, academic, business, and general documents. Your job is to make text easier for dyslexic readers WITHOUT changing what the document sounds like.

Target words that are hard to read because of:
- Confusing letter patterns (b/d, p/q, l/i, ll, dd, bb, pp)
- Excessive length (8+ characters where a shorter same-register option exists)
- Visually crowded shapes (double letters, dense ascender/descender clusters)

Be selective. A dyslexic professional reading a business checklist wants a business checklist that is easier to scan, not a simplified children's version. When in doubt, leave the word alone. Preserving tone matters more than replacing every candidate word.
${ALL_QUALITY_RULES}
${examplesSection}
${chunkNote}
Return ONLY the transformed markdown, nothing else. No commentary, no code fences.

Text:
${text}`;
}

function buildLettersPrompt(text, chunkNote) {
  return `You are a dyslexia accessibility tool. Make text easier for dyslexic readers by replacing words that contain visually confusing letter combinations.

Target letters: b/d, p/q, l/i, i/j, and clusters of these (ll, dd, bb, pp, bd, bl, dl, pb, dp, il, li).

Scan each word. If it contains these confusing letter combinations and a clearer word exists, replace it. If the word does not contain these patterns, leave it exactly as written, even if it is long or complex.

Examples:
- "accommodation" -> "place to stay" (has d, cc, mm)
- "difficult" -> "hard" (has d, i, ff)
- "building" -> "making" (has b, d, i, l)
- "bilateral" -> "two-sided" (has b, l, i)
- "brilliant" -> "gifted" (has b, ll, i)
- "display" -> "show" (has d, p, l, i)
- "proliferation" -> "rapid growth" (has p, l, i)
- "constellations" -> "star patterns" (has ll, i)
${QUALITY_RULES}
${chunkNote}
Return ONLY the transformed text, nothing else.

Text:
${text}`;
}

function buildLengthPrompt(text, chunkNote) {
  return `You are a dyslexia accessibility tool. Make text easier for dyslexic readers by replacing long words with shorter alternatives.

Target: words with 8 or more characters. If a shorter word or phrase preserves the same meaning, replace it. If the word is 7 characters or fewer, leave it. If no shorter alternative fits precisely, leave the long word too.

Examples:
- "accommodation" -> "place to stay"
- "approximately" -> "roughly" or "about"
- "demonstrated" -> "shown"
- "fundamental" -> "core" or "key"
- "constellations" -> "star patterns"
- "destabilisation" -> "breakdown"
- "proliferation" -> "rapid growth"
- "jurisdictions" -> "regions"
- "incredible" -> "amazing"
${QUALITY_RULES}
${chunkNote}
Return ONLY the transformed text, nothing else.

Text:
${text}`;
}

function buildComplexPrompt(text, chunkNote) {
  return `You are a dyslexia accessibility tool. Make text easier for dyslexic readers by replacing visually crowded or dense-looking words.

Target: words with double letters (ll, dd, pp, rr, tt, bb, ff, ss, cc, mm, nn), dense clusters of tall/hanging letters (b, d, f, g, h, j, k, l, p, q, t, y packed together), or shapes that blur into each other when reading quickly.

Scan each word. If it looks visually dense and a cleaner-looking replacement exists, replace it. If the word has a clean visual shape, leave it regardless of length.

Examples:
- "accommodation" -> "place to stay" (cc, mm)
- "address" -> "location" (dd, ss)
- "difficult" -> "hard" (ff, dense shapes)
- "brilliant" -> "gifted" (ll)
- "destabilisation" -> "breakdown" (dense tall/hanging cluster)
- "constellations" -> "star patterns" (ll, dense shapes)
- "proliferation" -> "rapid growth" (dense cluster)
${QUALITY_RULES}
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

    const transformed = guardAgainstHallucination(
      normalizedText,
      cleanupTransformedText(transformedChunks.join('\n\n'))
    );

    res.status(200).json({ transformed });
  } catch (err) {
    console.log('Catch error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
}
