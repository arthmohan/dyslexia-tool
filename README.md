# ClearText

A web tool that makes text easier to read for dyslexic readers. Paste text or upload a document, pick a reading profile, and get back the same content with visually difficult words replaced by clearer alternatives.

Live at [dyslexia-tool.vercel.app](https://dyslexia-tool.vercel.app)

## What it does

ClearText takes any text and replaces words that are hard for dyslexic readers to process. It reduces reading level by 1-2 levels while preserving meaning, tone, and register. Academic text stays academic. Professional text stays professional. Only the hardest words change.

Four reading profiles let users focus on what bothers them most:

- **All** - letter confusion, long words, and visually complex words
- **Letter Confusion** - words with b/d, p/q, l/i, ll/li patterns
- **Long Words** - words over 7 characters where shorter alternatives exist
- **Visual Complexity** - words with double letters, dense letter clusters

The tool also supports PDF, Word (.docx), and plain text file uploads. Scanned PDFs fall back to OCR via Tesseract.

## Stack

- **Frontend**: vanilla HTML/CSS/JS, Comic Neue and OpenDyslexic fonts
- **Backend**: Vercel serverless functions (Node.js, ES modules)
- **LLM**: Groq API running Llama 3.3 70B for text transformation
- **Similarity**: HuggingFace Inference API (all-MiniLM-L6-v2 embeddings)
- **File parsing**: PDF.js, Mammoth.js, Tesseract.js (CDN)
- **Markdown**: Marked.js for rendering transformed output

## Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and add your API keys:
   - `GROQ_API_KEY` from [console.groq.com](https://console.groq.com)
   - `HF_API_KEY` from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
3. Install the Vercel CLI: `npm i -g vercel`
4. Run locally: `vercel dev`

The app has no npm dependencies. All browser libraries are vendored in `public/libs/`.

## Deploy

```
vercel --prod
```

Make sure `GROQ_API_KEY` and `HF_API_KEY` are set in your Vercel project's environment variables.

## Project structure

```
api/
  transform.js        Main transform endpoint (Groq + prompt logic)
  transform-utils.js   Input normalization, chunking, output cleanup
  feedback.js          Feedback storage endpoint (CSV append)
  similarity.js        Semantic similarity endpoint (HuggingFace)
public/
  index.html           Single-page app
  app.js               Frontend logic (upload, transform, feedback, PDF)
  style.css            Styles, themes, responsive, print
  feedback.csv         Seed examples for few-shot prompting
  libs/                Vendored browser libraries (do not edit)
  fonts/               OpenDyslexic font files
test/
  transform-utils.test.js   Unit tests for chunking, cleanup, diff logic
```

## Tests

```
npm test
```

Runs with Node's built-in test runner (`node --test`). No test dependencies.

## How the feedback loop works

When a user clicks thumbs up or thumbs down, the app extracts word-level substitutions from the transformation using a context-verified two-pointer diff. These pairs are appended to `public/feedback.csv` with proper CSV escaping. On the next transformation, the "All" profile loads these pairs as few-shot examples in the Groq prompt.

The diff algorithm requires matching words on both sides of a substitution (left and right context) before recording a pair. Stop words and short words are filtered out. This prevents the garbage pairs that a naive index-by-index comparison would produce.

Note: on Vercel's serverless environment, filesystem writes to `feedback.csv` are ephemeral and reset on each deployment. The seed examples in the committed CSV persist.

## Known limitations

- 24,000 character input cap (chunking exists but the hard limit remains)
- OCR via Tesseract CDN can be slow on multi-page scanned PDFs
- Profile differentiation depends on LLM instruction-following, which is imperfect
- Similarity score measures embedding distance, not meaning preservation directly
- No HTML sanitization on marked.parse output (low risk for personal use)
- Feedback CSV is ephemeral on Vercel serverless
