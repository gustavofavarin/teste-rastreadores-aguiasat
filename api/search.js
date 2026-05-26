import { waitUntil } from '@vercel/functions';
import { runSearch } from '../server/shared.js';

export default async function handler(req, res) {
  const q = String(req.query?.q ?? '').trim();
  const force = req.query?.force === '1' || req.query?.force === 'true';

  if (!q) {
    res.status(400).json({ error: 'Parâmetro "q" é obrigatório.' });
    return;
  }

  const result = await runSearch({ q, force, waitUntil });
  if (!result.ok) {
    res.status(502).json({ error: 'Todas as fontes falharam.', warnings: result.warnings });
    return;
  }
  res.status(200).json(result.payload);
}
