import fs from 'fs';
import path from 'path';

function loadFewShotExamples() {
  try {
    const csvPath = path.join(process.cwd(), 'public', 'feedback.csv');
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n').slice(1);

    const good = [];
    const bad = [];

    lines.forEach(line => {
      const [original, replacement, isGood, context] = line.split(',');
      if (!original || !replacement) return;
      if (isGood === 'true') {
        good.push(`- "${original.trim()}" -> "${replacement.trim()}"`);
      } else {
        bad.push(`- "${original.trim()}" -> "${replacement.trim()}" (WRONG — do not do this)`);
      }
    });

    return { good, bad };
  } catch (err) {
    return { good: [], bad: [] };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, profile } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const profileInstructions = {
    all: 'visually confusing letter patterns (b/d, p/q, l/i, ll/li, n/u), visually complex words, and words longer than 6-8 characters',
    letters: 'visually confusing letter patterns only (b/d, p/q, l/i, ll/li, n/u)',
    length: 'words longer than 7 characters — flag every word over 7 characters and replace with a shorter word or phrase if one exists',
    complex: 'visually complex words with high character shape density only'
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

  const prompt = `You are an accessibility tool for dyslexic readers. You replace visually difficult words with easier alternatives while fully preserving meaning, tone, and reading level.

--- STEP 1: ASSESS ---
Read the full text. Estimate reading level 1-10 (1=child, 10=academic). Keep the output within ONE level below the original. Never sacrifice precision for simplicity. A level 9 text stays at level 8, not level 5.

--- STEP 2: FIND TARGET WORDS ---
Flag words in these categories: ${target}

Look for:
- Letters b/d, p/q, l/i, ll/li, n/u, x/i, i/j in words (e.g. "building", "display", "ability", "people", "dribble", "accommodation")
- Double letters ll, dd, pp, tt, bb, rr (e.g. "address" -> "location", "difficult" -> "hard", "accommodation" -> "place to stay")
- Long or complex words 7+ characters (e.g. "constellations" -> "group of stars", "approximately" -> "about", "destabilisation" -> "breakdown", "fundamental" -> "key", "adequate" -> "enough", "proliferation" -> "rapid spread", "demonstrated" -> "shown")
- Visually dense or irregular words — ONLY if a precise synonym exists in context

--- STEP 3: REPLACE ---
1. Phrases are often better than single word replacements
2. High reading level texts (7-10): keep replacements sophisticated — "discourse" -> "public debate" not "talk"
3. Exact meaning must be preserved — if no accurate replacement exists, leave the word unchanged
4. Be CONSISTENT — if you replace a word once, replace it every time it appears
5. Never replace: proper nouns, names, places, acronyms, numbers, event names, brand names, scientific terms (biological, chemical, psychological)
6. Do not replace short simple words unnecessarily

${fewShotSection}

--- STEP 4: FORMAT AS MARKDOWN ---
Read the full text, understand its structure and intent, and format the output as clean markdown. Use your judgment:
- Headings for titles or section labels
- Bullet points for lists
- Bold for emphasis where it clearly exists in the original
- Paragraph breaks between distinct thoughts
- Keep it clean and readable — do not over-format plain conversational text
- Return ONLY the markdown, no explanation, no preamble
- Return ONLY the transformed text as markdown
- Do NOT add any notes, comments, reading level assessments, or explanations
- Do NOT add bullet points or lists that were not in the original
- Do NOT add any content that was not in the original text
- Do NOT add headings that were not in the original text — if the input has no heading, the output has no heading
- The last bullet point must end at the end of that bullet — the next sentence after the list must be on its own separate line, never merged onto the last bullet

Text to process:
${text}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 8192
      })
    });

    const data = await response.json();
    console.log('Groq response status:', response.status);

    if (!response.ok) {
      console.log('Groq error:', JSON.stringify(data, null, 2));
      return res.status(500).json({ error: data.error?.message || 'Groq request failed' });
    }

    let transformed = data.choices?.[0]?.message?.content;
if (!transformed) return res.status(500).json({ error: 'Groq returned no output' });

// Fix merged last bullet — split "- item text Next sentence" into two lines
transformed = transformed.replace(
  /([\*\-] .+?)\s{1,2}([A-Z][^*\-\n])/g,
  '$1\n\n$2'
);

res.status(200).json({ transformed });
  } catch (err) {
    console.log('Catch error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
