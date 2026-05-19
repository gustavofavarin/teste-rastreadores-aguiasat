import {
  searchVehicles as searchGetrak,
} from '../server/getrak.js';
import {
  searchVehicles as searchDoTelematics,
  hasCredentials as hasDoCredentials,
} from '../server/dotelematics.js';
import { reverseGeocode } from '../server/geocode.js';

const GEOCODE_CONCURRENCY = 1;

function parseTimestamp(raw) {
  if (!raw) return null;
  const dateStr = typeof raw === 'string' ? raw : raw.date;
  if (!dateStr) return null;
  const iso = dateStr.replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stripIdPrefix(modulo) {
  if (!modulo) return null;
  return String(modulo).replace(/^ID/i, '');
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function normalizeRaw(v, fonte) {
  const lat = typeof v.lat === 'number' ? v.lat : Number(v.lat);
  const lon = typeof v.lon === 'number' ? v.lon : Number(v.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  return {
    id: stripIdPrefix(v.modulo),
    modulo: v.modulo ?? null,
    placa: v.placa ?? null,
    apelido: v.apelido ?? null,
    idVeiculo: v.id_veiculo ?? null,
    ultimaAtualizacao: parseTimestamp(v.datastatus) ?? parseTimestamp(v.data),
    voltagem: v.tensao_bateria ?? null,
    lat: hasCoords ? lat : null,
    lon: hasCoords ? lon : null,
    statusOnline: v.status_online ?? null,
    fonte,
  };
}

export default async function handler(req, res) {
  const q = String(req.query?.q ?? '').trim();
  const force = req.query?.force === '1' || req.query?.force === 'true';

  if (!q) {
    res.status(400).json({ error: 'Parâmetro "q" é obrigatório.' });
    return;
  }

  const sources = [
    { fonte: 'Getrak', run: () => searchGetrak(q, { force }) },
  ];
  if (hasDoCredentials()) {
    sources.push({ fonte: 'DO Telematics', run: () => searchDoTelematics(q, { force }) });
  }

  const settled = await Promise.allSettled(sources.map((s) => s.run()));

  const warnings = [];
  const snapshotTimestamps = [];
  let merged = [];

  settled.forEach((r, i) => {
    const { fonte } = sources[i];
    if (r.status === 'fulfilled') {
      const { results, updatedAt } = r.value;
      if (updatedAt) snapshotTimestamps.push(updatedAt);
      for (const v of results) merged.push(normalizeRaw(v, fonte));
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[/api/search] ${fonte} falhou:`, msg);
      warnings.push(`Fonte ${fonte} indisponível: ${msg}`);
    }
  });

  if (settled.every((r) => r.status === 'rejected')) {
    res.status(502).json({ error: 'Todas as fontes falharam.', warnings });
    return;
  }

  merged.sort((a, b) => {
    const ta = a.ultimaAtualizacao ? new Date(a.ultimaAtualizacao).getTime() : 0;
    const tb = b.ultimaAtualizacao ? new Date(b.ultimaAtualizacao).getTime() : 0;
    return tb - ta;
  });

  const sliced = merged.slice(0, 50);

  const results = await mapLimit(sliced, GEOCODE_CONCURRENCY, async (item) => {
    const localizacao =
      item.lat != null && item.lon != null
        ? await reverseGeocode(item.lat, item.lon)
        : null;
    return { ...item, localizacao };
  });

  const snapshotUpdatedAt = snapshotTimestamps.length
    ? new Date(Math.max(...snapshotTimestamps)).toISOString()
    : null;

  res.status(200).json({
    results,
    total: merged.length,
    truncated: merged.length > results.length,
    snapshotUpdatedAt,
    warnings,
  });
}
