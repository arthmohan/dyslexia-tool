export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { original, transformed } = req.body;
  if (!original || !transformed) return res.status(400).json({ error: 'Missing text' });

  try {
    const embed = async (text) => {
  const response = await fetch(
    'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HF_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: text,
        options: { wait_for_model: true }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }

  const data = await response.json();
  return Array.isArray(data[0]) ? data[0] : data;
};

    const [vecA, vecB] = await Promise.all([
      embed(original.slice(0, 2000)),
      embed(transformed.slice(0, 2000))
    ]);

    const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    const score = dot / (magA * magB);

    res.status(200).json({ score: Math.round(score * 100) });
  } catch (err) {
    console.log('Similarity error:', err.message);
    res.status(200).json({ score: null, error: err.message });
  }
}
