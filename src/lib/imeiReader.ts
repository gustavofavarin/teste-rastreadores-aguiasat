export type ImeiReadResult =
  | { ok: true; value: string; warning?: string }
  | { ok: false; error: string };

type Extraction = { value: string; warning?: string };

const log = (...args: unknown[]) => console.log('[imei]', ...args);

// Padrão de âncora que aceita as palavras-chave usadas pelas marcas de
// rastreador que recebemos, mais variações comuns de OCR (U→O, I perdido):
// - MEI:        cauda de "IMEI" (Getrak); o "I" inicial é ambíguo no OCR.
// - UIN / OIN:  "UIN" da Iter (DO); U costuma virar O.
// - UID / OID:  "UID" da Billions Brasil; mesma confusão U/O.
// - UN / UD:    "UIN"/"UID" com I perdido. Lookahead exige não-letra após,
//               pra evitar falso positivo dentro de TELECOMUNICAÇÕES etc.
const ANCHOR_REGEX = /(MEI|UIN|UID|OIN|OID|UN(?=[^A-ZÀ-Ÿ])|UD(?=[^A-ZÀ-Ÿ]))/;

export function isImeiValid(s: string | null | undefined): boolean {
  if (!s || !/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = parseInt(s[14 - i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function extractFromAnchor(text: string): Extraction | null {
  const upper = text.toUpperCase();
  const match = upper.match(ANCHOR_REGEX);
  if (!match || match.index === undefined) return null;

  let pos = match.index + match[1].length;

  // Pula ':', '.', espaços até o primeiro dígito. Se encontrar letra antes, aborta.
  while (pos < text.length) {
    const ch = text[pos];
    if (/\d/.test(ch)) break;
    if (/[A-Za-zÀ-ÿ]/.test(ch)) return null;
    pos++;
  }

  if (pos >= text.length) return null;

  let collected = '';
  let i = pos;
  while (i < text.length && collected.length < 15) {
    const ch = text[i];
    if (/\d/.test(ch)) {
      collected += ch;
    } else if (/[\s.\-]/.test(ch)) {
      // separador entre dígitos — ignora
    } else {
      break;
    }
    i++;
  }

  if (collected.length === 15) {
    return {
      value: collected,
      warning: isImeiValid(collected) ? undefined : 'Luhn não bateu — confira o número.',
    };
  }

  if (collected.length >= 8) {
    const missing = 15 - collected.length;
    return {
      value: collected,
      warning: `Leitura incompleta: ${collected.length} dígitos visíveis. Complete os ${missing} faltantes.`,
    };
  }

  return null;
}

/**
 * Fallback: procura uma LINHA contendo 14+ dígitos (IMEI tem 15; aceitamos 14
 * porque OCR às vezes perde 1). Seguro porque outras infos da etiqueta têm no
 * máximo 11 dígitos (ANATEL=10, telefone=11).
 */
function extractFromLine(text: string): Extraction | null {
  for (const line of text.split(/[\r\n]+/)) {
    const digits = line.replace(/\D/g, '');
    if (digits.length >= 15) {
      const candidate = digits.slice(0, 15);
      return {
        value: candidate,
        warning: isImeiValid(candidate)
          ? 'Não encontrei "IMEI"/"UIN"/"UID" — confira o número.'
          : 'Não encontrei "IMEI"/"UIN"/"UID" e Luhn falhou — confira com atenção.',
      };
    }
    if (digits.length === 14) {
      return {
        value: digits,
        warning:
          'Leitura provavelmente incompleta: 14 dígitos detectados. Compare com a foto e adicione o que falta.',
      };
    }
  }
  return null;
}

function extractImei(text: string): Extraction | null {
  return extractFromAnchor(text) ?? extractFromLine(text);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não consegui carregar a imagem.'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Falha ao codificar JPEG.'))),
      'image/jpeg',
      quality,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Falha ao converter base64.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Reduz a imagem (long side ≤ 1200px) e codifica em base64 JPEG.
 * Otimizado pra celulares com pouca RAM:
 *  - HTMLImageElement (decodificação preguiçosa, melhor que createImageBitmap)
 *  - canvas.toBlob (streaming, não cria string gigante)
 *  - FileReader pra base64 (assíncrono, eficiente)
 */
async function resizeAndEncode(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const maxSide = 1200;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D não disponível.');
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await canvasToBlob(canvas, 0.85);
    return await blobToBase64(blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ocrViaVision(base64: string): Promise<string> {
  const resp = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64 }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json.error || `Erro ${resp.status} no /api/ocr`);
  }
  return typeof json.text === 'string' ? json.text : '';
}

export async function readImei(file: File): Promise<ImeiReadResult> {
  log('iniciando leitura', { name: file.name, size: file.size, type: file.type });

  let base64: string;
  try {
    base64 = await resizeAndEncode(file);
  } catch (err) {
    log('falha ao codificar imagem:', err);
    return { ok: false, error: 'Não consegui processar a imagem.' };
  }
  log('imagem codificada, chamando /api/ocr…');

  let text: string;
  try {
    text = await ocrViaVision(base64);
  } catch (err) {
    log('OCR (Google Vision) falhou:', err);
    return {
      ok: false,
      error: `OCR falhou: ${(err as Error).message ?? 'erro desconhecido'}`,
    };
  }
  console.warn('[imei] RAW OCR TEXT:', JSON.stringify(text));

  if (!text.trim()) {
    return {
      ok: false,
      error: 'Nenhum texto detectado na imagem. Tente uma foto mais nítida da etiqueta.',
    };
  }

  const extraction = extractImei(text);
  if (extraction) {
    return { ok: true, value: extraction.value, warning: extraction.warning };
  }

  return {
    ok: false,
    error:
      'Texto detectado mas não encontrei um IMEI válido. Verifique se a etiqueta com "IMEI", "UIN" ou "UID" está visível.',
  };
}
