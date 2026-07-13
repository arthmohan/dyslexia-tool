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
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
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
        temperature: 0.35,
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

// The "all" profile: replace visually difficult words at the RIGHT REGISTER.
// Previous iterations tried two extremes: "do not hold back" (which made
// professional docs sound childish) and "preserve register above all with a
// 40-word do-not-touch list" (which made children's text get 3 replacements
// out of a paragraph full of candidates). This version treats register as a
// per-document DETECTION step, not a global override, and gives the model an
// explicit replacement target so it stops erring toward inaction.
const ALL_QUALITY_RULES = `
QUALITY RULES:

1. Before you start, judge the register in one internal sentence. Register is a strict constraint on how far you can simplify.

   - CHILDREN'S / GENERAL reading (nature articles, story-style writing, casual explainers): warm tone, everyday vocabulary. Your replacements can be warm and simple.
   - ADULT NEUTRAL (news, informational articles, general non-fiction): must still sound like a well-written adult article, not a children's book.
   - PROFESSIONAL / BUSINESS: preserve professional vocabulary. Words like "conversations", "stakeholders", "essential", "conservation" stay.
   - ACADEMIC / HISTORICAL / TECHNICAL: research writing, historical narrative, science, biography of important figures. Preserve formal register strictly. "Illustrated manuscripts" stays as "illustrated manuscripts", never "drawn manuscripts". "Surrounded himself with advisors" stays, never "encircled". "Magnificent buildings" or "monumental buildings", never "pretty buildings".

   Historical figures (Akbar, Napoleon, Gandhi), government/policy documents, scientific research, and biographies of important people are ALWAYS academic/formal register regardless of the surface simplicity of the words used.

2. Aim to replace 20-30% of content words that meet the visual-difficulty criteria. This is a real accessibility tool for dyslexic readers, not a minimal-edit tool. Do not hold back on obvious candidates. Every visually difficult word you leave unreplaced is a barrier for a dyslexic reader.

3. A word is a replacement candidate if it has visual difficulty (letter confusion, 8+ characters with a shorter equivalent, or dense letter shapes) AND a natural same-register replacement exists.

4. Phrase replacements ("place to stay", "make worse") often read more naturally than forced single-word swaps.

4a. Do not replace with metaphors or figurative words. "sustainable" -> "green" is wrong because "green" shifts the meaning to color or metaphor. "environmental" -> "green" is wrong for the same reason. The replacement must mean literally the same thing as the original.

4b. Do not drift register downward on adult text. Specific errors to never make:
   - "estimate" -> "guess" (estimate stays)
   - "consequences" -> "results" (loses the causal-negative meaning)
   - "populations" -> "groups" (populations is the correct ecology term)
   - "poaching" -> "hunting" (loses "illegal"; if you must replace, use "illegal hunting")
   - "survival" -> "life" (they mean different things)
   - "ultimately" -> "finally" (ultimately means "at its root/in the end", finally is temporal)
   - "Indigenous" -> "Native" (not modern synonyms)
   - "conservation" -> "protection" (conservation is a specific term; leave alone or use "saving")
   - "illustrated" -> "drawn" (illustrated is the correct manuscript term)
   - "surrounded" -> "encircled" (encircled means physically or militarily surrounded)
   - "immediately" -> "right away" (right away is casual register)
   - "commissioned/built" -> "set up" (rulers do not "set up" buildings)
   - "magnificent/monumental" -> "pretty" (pretty is never right for architecture, historical sites, or important places)
   - "communities" -> "groups" (communities carries a shared-identity meaning that groups does not)
   Match the register of the input; do not simplify below it.

4c. Do not change quantities or specifics. "Thousands of years" does not become "many years" - that loses information. "Detailed knowledge" does not become "full knowledge" - those mean different things. Substitute words that mean the same thing, not words that are just easier or more general.

5. NEVER touch, no matter how visually difficult they look:
   - Proper nouns, personal names, place names.
   - Species names or animal names (anacondas, dolphins, elephants, jaguars, sharks, etc.). If the passage is about an animal, that animal's name stays exactly as written.
   - Numbers, quantifiers, and quantities. "Thousands", "millions", "billion", "hundred", "several" stay. The modifier "approximately" can be swapped to "about", but the number itself stays.
   - Dates, currency, acronyms.
   - Scientific or technical terms that are the subject of the passage.

6. PRESERVE ALL FORMATTING as markdown. Headings stay headings (# ## ###). Bullets stay bullets (- or *). Numbered lists stay numbered (1. 2. 3.). Paragraph breaks stay. Bold and italic stay.

7. Do not add or remove content. Never invent new phrases, clauses, or sentences. Only replace existing words.

8. Return the output as clean markdown. No commentary. No code fences.

9. GRAMMAR CHECK every replacement before finalising. A broken-grammar output is worse than an unreplaced word.
   - Past participles after "have/has/had": "they have gone" not "they have went". "she has seen" not "she has saw". "they had come" not "they had came".
   - Noun vs adjective mismatch: "the difficulty of the task" (noun) cannot become "the hard of the task" (adjective). Either replace the entire phrase ("the difficulty of the task" -> "how hard the task is") or leave both words alone.
   - Article + noun agreement: "a policy" cannot become "a policies".
   - Verb tense consistency across the sentence.
   If any replacement produces broken grammar, revert it.`;

// ── Per-profile prompts ──

function buildAllPrompt(text, chunkNote) {
  const { good, bad } = loadFewShotExamples();

  let examplesSection = '';
  if (good.length > 0 || bad.length > 0) {
    examplesSection = `\nReference replacements:
${good.length > 0 ? good.join('\n') : ''}
${bad.length > 0 ? '\nKnown bad (never do these):\n' + bad.join('\n') : ''}`;
  }

  return `You are a dyslexia accessibility tool. Your job is to make text easier for dyslexic readers by replacing visually difficult words with clearer alternatives, while preserving the meaning and voice of the original text.

Target words that are hard to read because of:
- Confusing letter patterns (b/d, p/q, l/i, ll, dd, bb, pp)
- Excessive length (8+ characters where a shorter equivalent exists)
- Visually crowded shapes (double letters, dense ascender/descender clusters)

Be thorough. Scan every content word. Every visually difficult word you leave unreplaced is a barrier for a dyslexic reader. Aim to catch every reasonable candidate.
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

// User-selected reading level target. Prepended to every prompt so the model
// knows how aggressively to simplify BEFORE it does register detection on
// its own. Solves the problem of the model reading a historical/formal text
// as if it were casual because the sentences happen to be short.
const READING_LEVEL_PREAMBLE = {
  elementary: `READER TARGET: Elementary school student (Grade 3-5, roughly age 8-10).
Replace freely. Warm, simple, everyday vocabulary is welcome. You may drop
below the source register if the replacement is genuinely easier for a young
reader. Aim for the top of the 20-30% replacement range.`,

  middle: `READER TARGET: Middle school student (Grade 6-8, roughly age 11-14).
Replace moderately. Use everyday adult vocabulary. Do not go down to
children's register. Aim for the middle of the 20-30% replacement range.`,

  high: `READER TARGET: High school student / general adult reader (Grade 9-12).
Replace with a light touch. Preserve the register of the source. Do not
simplify below the source level. Aim for the lower end of the 20-30%
replacement range - selectivity matters more than volume here.`,

  formal: `READER TARGET: College / academic / professional / historical reader.
Preserve the formal register STRICTLY. Only replace words that are visually
difficult AND have a same-register synonym. Historical narratives about
figures like Emperor Akbar, scientific writing, legal documents, and
professional/business writing all fall in this category regardless of
sentence length. When in doubt, LEAVE THE WORD ALONE. Aim for 10-15%
replacement, quality over volume.`
};

function getReadingLevelPreamble(readingLevel) {
  return READING_LEVEL_PREAMBLE[readingLevel] || READING_LEVEL_PREAMBLE.high;
}

async function transformChunk(chunk, profile, chunkIndex, totalChunks, readingLevel) {
  const chunkNote = totalChunks > 1
    ? `\nThis is chunk ${chunkIndex + 1} of ${totalChunks}. Keep consistent tone and style.`
    : '';

  const builder = promptBuilders[profile] || promptBuilders.all;
  const preamble = getReadingLevelPreamble(readingLevel);
  const prompt = `${preamble}\n\n${builder(chunk, chunkNote)}`;
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

  const { text, profile, readingLevel } = req.body;
  const normalizedText = normalizeInputText(text);

  if (!normalizedText) return res.status(400).json({ error: 'No text provided' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY in environment.' });
  if (normalizedText.length > MAX_INPUT_CHARS) {
    return res.status(400).json({
      error: `This document is too large right now. Please keep it under ${MAX_INPUT_CHARS.toLocaleString()} characters.`
    });
  }

  const validProfile = promptBuilders[profile] ? profile : 'all';
  const validReadingLevel = READING_LEVEL_PREAMBLE[readingLevel] ? readingLevel : 'high';

  try {
    const chunks = splitIntoChunks(normalizedText);
    const transformedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const transformedChunk = await transformChunk(chunks[i], validProfile, i, chunks.length, validReadingLevel);
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
