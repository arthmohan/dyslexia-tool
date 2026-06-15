import fs from 'fs';
import path from 'path';

function csvEscape(field) {
  const str = String(field ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { original, replacement, good, context } = req.body;
  if (!original || !replacement) return res.status(400).json({ error: 'Missing fields' });

  const csvPath = path.join(process.cwd(), 'public', 'feedback.csv');
  const line = [
    csvEscape(original),
    csvEscape(replacement),
    csvEscape(good),
    csvEscape(context || 'general')
  ].join(',') + '\n';

  try {
    fs.appendFileSync(csvPath, line);
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
