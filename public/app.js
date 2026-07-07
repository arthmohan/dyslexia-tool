// ── Settings Panel ──────────────────────────────────────────────────────────

const SETTINGS_KEY = 'cleartext-settings-v1';
const VALID_SETTINGS = {
  font:    ['comic', 'opendys'],
  spacing: ['normal', 'wide'],
  theme:   ['cream', 'dark', 'peach', 'contrast']
};
const DEFAULT_SETTINGS = { font: 'comic', spacing: 'normal', theme: 'cream' };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    // Guard against stale/invalid values from earlier versions.
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(VALID_SETTINGS)) {
      if (VALID_SETTINGS[key].includes(parsed[key])) out[key] = parsed[key];
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage disabled or full — silent fail, settings just won't persist.
  }
}

function toggleSettings() {
  document.getElementById('settings-panel').classList.toggle('open');
  document.getElementById('settings-overlay').classList.toggle('open');
}

function applySetting(group, value) {
  const groupClasses = {
    font:    ['font-comic', 'font-opendys'],
    spacing: ['spacing-normal', 'spacing-wide'],
    theme:   ['theme-cream', 'theme-dark', 'theme-peach', 'theme-contrast']
  }[group];
  if (!groupClasses) return;
  document.body.classList.remove(...groupClasses);
  document.body.classList.add(`${group}-${value}`);

  // Sync the button "active" state so restored settings show up in the UI.
  document.querySelectorAll(`[data-group="${group}"]`).forEach(b => {
    b.classList.toggle('active', b.dataset.value === value);
  });
}

function setSetting(group, btn) {
  const value = btn.dataset.value;
  applySetting(group, value);

  const current = loadSettings();
  current[group] = value;
  saveSettings(current);
}

document.addEventListener('DOMContentLoaded', () => {
  const settings = loadSettings();
  applySetting('font', settings.font);
  applySetting('spacing', settings.spacing);
  applySetting('theme', settings.theme);

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

  const text = await extractPdfStructured(pdf);

  if (isTextExtractionUsable(text, pdf.numPages)) {
    return text;
  }

  setUploadStatus('Scanned PDF detected. Running OCR...');
  return extractPdfWithOcr(pdf);
}

// Extracts text from a PDF while preserving line breaks, paragraphs, bullets,
// and headings. Uses each text item's y-coordinate and font height to group
// items into lines, detect paragraph gaps, and detect headings by relative size.
async function extractPdfStructured(pdf) {
  const allItems = [];
  const bodySizes = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    setUploadStatus(`Reading PDF page ${i} of ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!item.str) continue;
      // pdf.js item.transform = [scaleX, skewY, skewX, scaleY, x, y]. y is bottom-up,
      // so flip against the viewport height to get top-down coords.
      const x = item.transform[4];
      const yRaw = item.transform[5];
      const height = item.height || Math.abs(item.transform[3]) || 10;

      allItems.push({
        str: item.str,
        x,
        y: viewport.height - yRaw,
        height,
        pageIndex: i - 1
      });

      if (item.str.trim()) bodySizes.push(height);
    }

    allItems.push({ pageBreak: true, pageIndex: i - 1 });
  }

  if (!bodySizes.length) return '';

  // Median height = the body-text size. Anything meaningfully bigger is a heading.
  bodySizes.sort((a, b) => a - b);
  const bodySize = bodySizes[Math.floor(bodySizes.length / 2)] || 10;
  const headingThreshold = bodySize * 1.2;

  // Group items into lines by y-coordinate (tolerance = half a line height).
  const lines = [];
  let currentLine = null;

  for (const item of allItems) {
    if (item.pageBreak) {
      if (currentLine) { lines.push(currentLine); currentLine = null; }
      lines.push({ pageBreak: true });
      continue;
    }

    const sameLine = currentLine
      && currentLine.pageIndex === item.pageIndex
      && Math.abs(item.y - currentLine.y) < item.height * 0.5;

    if (sameLine) {
      // Insert a space if there's a visible gap between the previous glyph and this one.
      const needsSpace = currentLine.text.length
        && !currentLine.text.endsWith(' ')
        && !item.str.startsWith(' ');
      currentLine.text += (needsSpace && (item.x - currentLine.lastX) > item.height * 0.3 ? ' ' : '') + item.str;
      currentLine.maxHeight = Math.max(currentLine.maxHeight, item.height);
      currentLine.lastX = item.x + (item.str.length * item.height * 0.5);
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = {
        text: item.str,
        x: item.x,
        y: item.y,
        maxHeight: item.height,
        pageIndex: item.pageIndex,
        lastX: item.x + (item.str.length * item.height * 0.5)
      };
    }
  }
  if (currentLine) lines.push(currentLine);

  // Convert lines to markdown, detecting paragraph breaks, bullets, and headings.
  const output = [];
  let prevLine = null;

  for (const line of lines) {
    if (line.pageBreak) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      prevLine = null;
      continue;
    }

    const text = line.text.trim();
    if (!text) continue;

    // Paragraph break: a bigger-than-normal vertical gap OR heading transition.
    if (prevLine && prevLine.pageIndex === line.pageIndex) {
      const gap = line.y - (prevLine.y + prevLine.maxHeight);
      const paragraphGap = gap > line.maxHeight * 0.8;
      const sizeShift = Math.abs(line.maxHeight - prevLine.maxHeight) > bodySize * 0.3;
      if (paragraphGap || sizeShift) {
        if (output.length && output[output.length - 1] !== '') output.push('');
      }
    }

    // Heading: font clearly larger than body text.
    const isHeading = line.maxHeight >= headingThreshold;

    // Bullet: leading bullet character or dash. Numbered list: "1." / "1)".
    const bulletMatch = text.match(/^[•◦▪▫●○⁃•●○◦▪▫‣⁃*+\-]\s+(.+)/);
    const numberMatch = text.match(/^(\d+)[\.\)]\s+(.+)/);

    let md;
    if (isHeading && !bulletMatch && !numberMatch) {
      const ratio = line.maxHeight / bodySize;
      const level = ratio >= 1.8 ? 1 : ratio >= 1.4 ? 2 : 3;
      md = '#'.repeat(level) + ' ' + text;
    } else if (bulletMatch) {
      md = '- ' + bulletMatch[1];
    } else if (numberMatch) {
      md = numberMatch[1] + '. ' + numberMatch[2];
    } else {
      md = text;
    }

    output.push(md);
    prevLine = line;
  }

  // Collapse triple+ blank lines and trim trailing whitespace.
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
// Uses html2pdf.js (jsPDF + html2canvas) to generate the PDF entirely in-page,
// then triggers a download. No print dialog, no popup window, no extra clicks.

async function downloadPDF() {
  const text = window._transformedText;
  if (!text || !text.trim()) return;

  if (typeof html2pdf === 'undefined') {
    alert('PDF library did not load. Please refresh and try again.');
    return;
  }

  const btn = document.getElementById('btn-download-pdf');
  const originalLabel = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating PDF...';
  }

  const currentFont = document.body.classList.contains('font-opendys') ? 'opendys' : 'comic';
  const currentSpacing = document.body.classList.contains('spacing-wide') ? 'wide' : 'normal';
  const currentTheme = document.body.classList.contains('theme-dark') ? 'dark'
    : document.body.classList.contains('theme-peach') ? 'peach'
    : document.body.classList.contains('theme-contrast') ? 'contrast' : 'cream';

  const fontFamily = currentFont === 'opendys'
    ? "'OpenDyslexic', cursive"
    : "'Comic Neue', 'Comic Sans MS', cursive";

  const letterSpacing = currentSpacing === 'wide' ? '0.12em' : '0.08em';
  const wordSpacing = currentSpacing === 'wide' ? '0.25em' : '0.2em';
  const lineHeight = currentSpacing === 'wide' ? '2.4' : '2.2';

  const themes = {
    cream:    { bg: '#FAFAF7', text: '#1A1A1A' },
    dark:     { bg: '#1C1C1E', text: '#F5F0E8' },
    peach:    { bg: '#FDEBD0', text: '#1A1A1A' },
    contrast: { bg: '#0A1F3D', text: '#FDEBD0' }
  };
  const theme = themes[currentTheme];

  // Build an offscreen container sized to A4 width so html2canvas rasterizes
  // at the exact proportions jsPDF will save. Full-bleed theme colour, then
  // an inner padding acts as the printable margin.
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed;
    top: -10000px;
    left: 0;
    width: 794px;
    background: ${theme.bg};
    color: ${theme.text};
    font-family: ${fontFamily};
    font-size: 16px;
    line-height: ${lineHeight};
    letter-spacing: ${letterSpacing};
    word-spacing: ${wordSpacing};
    box-sizing: border-box;
  `;

  const inner = document.createElement('div');
  inner.style.cssText = `
    padding: 68px 60px;
    background: ${theme.bg};
    color: ${theme.text};
  `;
  inner.innerHTML = marked.parse(text);

  // Style the markdown children so they match the app's output-box look.
  const styleTag = document.createElement('style');
  styleTag.textContent = `
    .pdf-render h1, .pdf-render h2, .pdf-render h3,
    .pdf-render h4, .pdf-render h5, .pdf-render h6 {
      font-weight: 700; margin: 1em 0 0.4em; line-height: 1.4; color: ${theme.text};
    }
    .pdf-render h1 { font-size: 1.6em; }
    .pdf-render h2 { font-size: 1.4em; }
    .pdf-render h3 { font-size: 1.2em; }
    .pdf-render p { margin-bottom: 0.8em; }
    .pdf-render ul, .pdf-render ol { padding-left: 1.6em; margin-bottom: 0.8em; }
    .pdf-render li { margin-bottom: 0.3em; }
    .pdf-render strong { font-weight: 700; }
    .pdf-render em { font-style: italic; }
    .pdf-render blockquote {
      border-left: 4px solid currentColor;
      padding-left: 16px; margin: 0.8em 0; opacity: 0.85;
    }
  `;
  container.className = 'pdf-render';
  container.appendChild(styleTag);
  container.appendChild(inner);
  document.body.appendChild(container);

  // Give web fonts (Comic Neue via Google, OpenDyslexic via @font-face)
  // a moment to load before rasterizing so the PDF picks up the right glyphs.
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch { /* older browsers: skip */ }

  try {
    await html2pdf().set({
      margin: 0,
      filename: 'cleartext-output.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: {
        scale: 2,
        backgroundColor: theme.bg,
        useCORS: true,
        letterRendering: true
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation: 'portrait'
      },
      pagebreak: { mode: ['css', 'legacy'] }
    }).from(container).save();
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('Could not generate the PDF. ' + (err.message || 'Unknown error.'));
  } finally {
    container.remove();
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || 'Download PDF';
    }
  }
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
