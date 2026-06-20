export const MAX_INPUT_CHARS = 24000;
export const TARGET_CHUNK_CHARS = 3500;
// Phrase replacements can grow text slightly (e.g. "accommodation" -> "place to stay").
// Anything beyond this ratio means the model added content that wasn't in the original.
const MAX_GROWTH_RATIO = 1.20;

export function normalizeInputText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitIntoChunks(text, maxChunkChars = TARGET_CHUNK_CHARS) {
  const normalized = normalizeInputText(text);
  if (!normalized) return [];
  if (normalized.length <= maxChunkChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (paragraph.length <= maxChunkChars) {
      current = paragraph;
      continue;
    }

    const sentenceChunks = splitLargeParagraph(paragraph, maxChunkChars);
    chunks.push(...sentenceChunks.slice(0, -1));
    current = sentenceChunks[sentenceChunks.length - 1] || '';
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

function splitLargeParagraph(paragraph, maxChunkChars) {
  const sentences = paragraph.match(/[^.!?\n]+[.!?"]*\s*|.+$/g) || [paragraph];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const candidate = current ? `${current} ${trimmed}` : trimmed;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (trimmed.length <= maxChunkChars) {
      current = trimmed;
      continue;
    }

    const slices = splitHardByLength(trimmed, maxChunkChars);
    chunks.push(...slices.slice(0, -1));
    current = slices[slices.length - 1] || '';
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitHardByLength(text, maxChunkChars) {
  const words = text.split(/\s+/);
  const chunks = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
    } else if (!current) {
      chunks.push(word.slice(0, maxChunkChars));
      current = word.slice(maxChunkChars);
    } else {
      chunks.push(current);
      current = word;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function cleanupTransformedText(text) {
  let cleaned = normalizeInputText(text);

  cleaned = cleaned
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^(here(?:'s| is) the transformed text:?|transformed text:?|output:?)[ \t]*\n+/i, '')
    .replace(/([\*\-] .+?)\s{1,2}([A-Z][^*\-\n])/g, '$1\n\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

// Checks whether the model added content that wasn't in the original.
// Compares word counts: phrase replacements can grow text by ~15-20%,
// anything beyond that is hallucinated content. When caught, trims
// the output to the original's approximate length at a sentence boundary.
export function guardAgainstHallucination(original, transformed) {
  const origWordCount = original.split(/\s+/).filter(Boolean).length;
  const transWordCount = transformed.split(/\s+/).filter(Boolean).length;

  if (transWordCount <= Math.ceil(origWordCount * MAX_GROWTH_RATIO)) {
    return transformed;
  }

  console.log(`Hallucination guard: output grew from ${origWordCount} to ${transWordCount} words. Trimming.`);

  const words = transformed.split(/\s+/).filter(Boolean);
  const targetLength = Math.ceil(origWordCount * 1.10);
  const trimmed = words.slice(0, targetLength).join(' ');

  // Try to cut at the last sentence boundary so we don't end mid-thought.
  const lastSentenceEnd = trimmed.search(/[.!?][^.!?]*$/);
  if (lastSentenceEnd > trimmed.length * 0.75) {
    return trimmed.slice(0, lastSentenceEnd + 1);
  }

  return trimmed;
}
