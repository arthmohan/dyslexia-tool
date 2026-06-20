// ── Settings Panel ──────────────────────────────────────────────────────────

function toggleSettings() {
  document.getElementById('settings-panel').classList.toggle('open');
  document.getElementById('settings-overlay').classList.toggle('open');
}

function setSetting(group, btn) {
  document.querySelectorAll(`[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.value;

  if (group === 'font') {
    document.body.classList.remove('font-comic', 'font-opendys');
    document.body.classList.add('font-' + value);
  }
  if (group === 'spacing') {
    document.body.classList.remove('spacing-normal', 'spacing-wide');
    document.body.classList.add('spacing-' + value);
  }
  if (group === 'theme') {
    document.body.classList.remove('theme-cream', 'theme-dark', 'theme-peach');
    document.body.classList.add('theme-' + value);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('font-comic', 'spacing-normal', 'theme-cream');

  // ── Character counter ──
  const textarea = document.getElementById('paste-input');
  const charCount = document.getElementById('char-count');
  textarea.addEventListener('input', () => {
    charCount.textContent = textarea.value.length;
    window._inputSource = 'paste';
  });

  // ── Profile card selection ──
  document.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.profile-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      card.querySelector('input[type="radio"]').checked = true;
    });
  });

  // ── File upload ──
  const fileInput = document.getElementById('file-input');
  const uploadZone = document.getElementById('upload-zone');
  const fileName = document.getElementById('file-name');

  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

  uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    handleFile(e.dataTransfer.files[0]);
  });
});

// ── File Handling ────────────────────────────────────────────────────────────

let extractedText = '';
let currentUploadName = '';
const MAX_INPUT_CHARS = 24000;

async function handleFile(file) {
  if (!file) return;
  currentUploadName = file.name;
  const fileNameEl = document.getElementById('file-name');
  fileNameEl.textContent = file.name;
  const ext = file.name.split('.').pop().toLowerCase();
  setUploadStatus('Reading file...');

  try {
    if (ext === 'txt') {
      extractedText = await file.text();
    } else if (ext === 'docx') {
      extractedText = await extractDocx(file);
    } else if (ext === 'pdf') {
      extractedText = await extractPdf(file);
    } else {
      clearUploadStatus();
      alert('Unsupported file type. Please upload a PDF, .docx, or .txt file.');
      return;
    }
    document.getElementById('paste-input').value = extractedText;
    document.getElementById('char-count').textContent = extractedText.length;
    window._inputSource = 'file';
    clearUploadStatus();
  } catch (err) {
    clearUploadStatus();
    alert('Could not read this file. ' + err.message);
  }
}

async function extractDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    setUploadStatus(`Reading PDF page ${i} of ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }

  if (isTextExtractionUsable(text, pdf.numPages)) {
    return text;
  }

  setUploadStatus('Scanned PDF detected. Running OCR...');
  return extractPdfWithOcr(pdf);
}

function isTextExtractionUsable(text, pageCount) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const minChars = Math.max(40, pageCount * 25);
  const letterCount = (normalized.match(/[A-Za-z]/g) || []).length;
  return normalized.length >= minChars && letterCount >= Math.max(20, pageCount * 12);
}

async function extractPdfWithOcr(pdf) {
  if (!window.Tesseract) {
    throw new Error('OCR could not start because the Tesseract library did not load.');
  }

  let combinedText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    setUploadStatus(`Running OCR on page ${i} of ${pdf.numPages}...`);

    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({ canvasContext: context, viewport }).promise;

    const {
      data: { text }
    } = await Tesseract.recognize(canvas, 'eng', {
      logger: ({ status, progress }) => {
        if (status === 'recognizing text') {
          const percent = Math.round(progress * 100);
          setUploadStatus(`Running OCR on page ${i} of ${pdf.numPages}... ${percent}%`);
        }
      }
    });

    combinedText += `${text.trim()}\n`;
  }

  const normalized = combinedText.trim();
  if (!normalized) {
    throw new Error('OCR could not detect readable text in this PDF.');
  }

  return normalized;
}

function setUploadStatus(message) {
  const fileNameEl = document.getElementById('file-name');
  fileNameEl.textContent = message;
}

function clearUploadStatus() {
  const fileNameEl = document.getElementById('file-name');
  fileNameEl.textContent = currentUploadName;
}

// ── Transform ────────────────────────────────────────────────────────────────

async function runTransform() {
  const text = document.getElementById('paste-input').value.trim();
  if (!text) {
    alert('Please upload a file or paste some text first.');
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    alert(`This document is too large right now. Please keep it under ${MAX_INPUT_CHARS.toLocaleString()} characters.`);
    return;
  }

  const profile = document.querySelector('input[name="profile"]:checked').value;
  const source = window._inputSource || 'paste';
  const btn = document.getElementById('btn-transform');
  const progressWrap = document.getElementById('progress-wrap');
  const progressLabel = document.getElementById('progress-label');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  document.getElementById('section-output').style.display = 'none';

  try {
    progressLabel.textContent = 'Processing your text...';
    const transformRes = await fetch('/api/transform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, profile, source })
    });

    if (!transformRes.ok) {
      let errorMessage = 'Transform failed. Please try again.';

      try {
        const errorData = await transformRes.json();
        if (errorData?.error) {
          errorMessage = errorData.error;
        }
      } catch (parseErr) {
        // Keep the fallback message if the response body is not JSON.
      }

      throw new Error(errorMessage);
    }
    const { transformed } = await transformRes.json();

    progressLabel.textContent = 'Calculating similarity score...';
    const simRes = await fetch('/api/similarity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: text, transformed })
    });

    let score = null;
    if (simRes.ok) {
      const simData = await simRes.json();
      score = simData.score;
    }

    showOutput(transformed, score);

  } catch (err) {
    alert('Something went wrong: ' + err.message);
  } finally {
    btn.disabled = false;
    progressWrap.style.display = 'none';
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

function showOutput(text, score) {
  const section = document.getElementById('section-output');
  const outputBox = document.getElementById('output-box');
  const scoreBadge = document.getElementById('score-badge');
  const scoreValue = document.getElementById('score-value');

  const parsed = marked.parse(text || '');
  outputBox.innerHTML = parsed || `<p>${escapeHtml(text)}</p>`;
  window._transformedText = text;

  section.style.display = 'block';

  if (score !== null && score !== undefined) {
    scoreValue.textContent = score + '%';
    if (score < 60) {
      scoreBadge.classList.add('warning');
    } else {
      scoreBadge.classList.remove('warning');
    }
  } else {
    scoreValue.textContent = '--';
  }

  section.scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── PDF Download ─────────────────────────────────────────────────────────────

function downloadPDF() {
  const text = window._transformedText;
  if (!text || !text.trim()) return;

  const currentFont = document.body.classList.contains('font-opendys') ? 'opendys' : 'comic';
  const currentSpacing = document.body.classList.contains('spacing-wide') ? 'wide' : 'normal';
  const currentTheme = document.body.classList.contains('theme-dark') ? 'dark'
    : document.body.classList.contains('theme-peach') ? 'peach' : 'cream';

  const fontFamily = currentFont === 'opendys'
    ? "'OpenDyslexic', cursive"
    : "'Comic Neue', 'Comic Sans MS', cursive";

  const letterSpacing = currentSpacing === 'wide' ? '0.12em' : '0.08em';
  const wordSpacing = currentSpacing === 'wide' ? '0.25em' : '0.2em';
  const lineHeight = currentSpacing === 'wide' ? '2.4' : '2.2';

  const themes = {
    cream: { bg: '#FAFAF7', text: '#1A1A1A' },
    dark:  { bg: '#1C1C1E', text: '#F5F0E8' },
    peach: { bg: '#FDEBD0', text: '#1A1A1A' }
  };
  const theme = themes[currentTheme];

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>ClearText Output</title>
  <link href="https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&display=swap" rel="stylesheet"/>
  <style>
    @font-face {
      font-family: 'OpenDyslexic';
      src: url('${window.location.origin}/fonts/OpenDyslexic-Regular.otf') format('opentype');
      font-weight: 400;
    }
    @font-face {
      font-family: 'OpenDyslexic';
      src: url('${window.location.origin}/fonts/OpenDyslexic-Bold.otf') format('opentype');
      font-weight: 700;
    }
    body {
      font-family: ${fontFamily};
      font-size: 16px;
      line-height: ${lineHeight};
      letter-spacing: ${letterSpacing};
      word-spacing: ${wordSpacing};
      background: ${theme.bg};
      color: ${theme.text};
      padding: 48px;
      margin: 0;
    }
    h1, h2, h3, h4, h5, h6 { font-weight: 700; margin: 1em 0 0.4em; line-height: 1.4; }
    h1 { font-size: 1.6em; }
    h2 { font-size: 1.4em; }
    h3 { font-size: 1.2em; }
    p { margin-bottom: 0.8em; }
    ul, ol { padding-left: 1.6em; margin-bottom: 0.8em; }
    li { margin-bottom: 0.3em; }
    strong { font-weight: 700; }
    em { font-style: italic; }
    blockquote { border-left: 4px solid #2D5FA6; padding-left: 16px; margin: 0.8em 0; }
  </style>
</head>
<body>
  <div id="content"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
  <script>
    document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(text)});
    window.onload = () => setTimeout(() => { window.print(); window.close(); }, 1000);
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) alert('Please allow popups for this site to download PDF.');
}

// ── Feedback ─────────────────────────────────────────────────────────────────

// Words too common/short to ever be meaningful feedback pairs.
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

// Strips markdown formatting and punctuation, returns lowercase word array.
function tokenize(text) {
  return text
    .replace(/[#*_`~>\[\]()!]/g, '')        // strip markdown chars
    .replace(/[^\w\s'-]/g, ' ')              // strip remaining punctuation
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 0);
}

// Extracts word substitutions using a context-verified two-pointer walk.
// Only records a pair when:
//   - we arrived here after at least one matching word (left context verified)
//   - 1 original word was replaced by 1-3 transformed words
//   - the next word after the replacement matches in both texts (right context verified)
//   - the original word is >2 chars and not a stop word
function extractChangedWords(originalText, transformedText) {
  const origWords = tokenize(originalText);
  const transWords = tokenize(transformedText);
  const pairs = [];

  let oi = 0;
  let ti = 0;
  let hadMatch = false;

  while (oi < origWords.length && ti < transWords.length) {
    // Words match: advance both pointers.
    if (origWords[oi] === transWords[ti]) {
      hadMatch = true;
      oi++;
      ti++;
      continue;
    }

    // Words differ. Only attempt extraction if we have left context (hadMatch).
    if (!hadMatch) {
      oi++;
      ti++;
      continue;
    }

    // Try to match: 1 original word replaced by 1, 2, or 3 transformed words,
    // with the word after the replacement matching in both texts (right context).
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
      // Can't cleanly extract here. Try to resync by scanning ahead.
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

async function submitFeedback(isGood) {
  const original = document.getElementById('paste-input').value.trim();
  const transformed = window._transformedText;
  if (!original || !transformed) return;

  document.querySelectorAll('.feedback-btn').forEach(b => b.classList.remove('selected'));
  event.target.closest('.feedback-btn').classList.add('selected');

  const changed = extractChangedWords(original, transformed);

  try {
    await Promise.all(changed.slice(0, 10).map(pair =>
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original: pair.original,
          replacement: pair.replacement,
          good: isGood,
          context: 'user-feedback'
        })
      })
    ));
  } catch (err) {
    console.log('Feedback error:', err.message);
  }

  document.getElementById('feedback-thanks').style.display = 'block';
}
