const rateMap = new Map();
const MAX_PER_MIN = 12;
const MAX_IMAGES = 3;
const MAX_BASE64_BYTES = 4 * 1024 * 1024;

const SYSTEM_INSTRUCTION =
  'Actúa como tutor de electrónica para estudiantes de ingeniería. Recibe la imagen del circuito armado (y el diagrama como primera imagen, si existe) y el título. Compara lo armado con lo que debería ser. Revisa: alimentación y tierra común, polaridad (diodos, capacitores electrolíticos, LEDs), pines de los chips, valores y posición de resistencias, cables sueltos o en filas equivocadas de la protoboard, cortocircuitos y componentes faltantes. Responde SOLO con un JSON válido, sin texto extra: {"estado":"ok"|"fallas"|"dudoso","resumen":"máx 12 palabras","fallas":[{"que":"máx 10 palabras","donde":"ubicación corta","arreglo":"máx 15 palabras"}],"bien":["máx 3 aciertos cortos"],"foto":"frase para mejorar la imagen o cadena vacía"} Frases cortas y sin tecnicismos innecesarios. Si no ve algo con claridad debe usar estado "dudoso" y nunca inventar ni afirmar que algo está bien conectado si no lo ve claramente. Todo en español.';

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  rateMap.set(ip, entry);
  return entry.count <= MAX_PER_MIN;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  const accessCode = process.env.ACCESS_CODE;
  if (accessCode && accessCode.trim() !== '') {
    const provided = String(req.headers['x-code'] || '').trim();
    if (provided !== accessCode.trim()) {
      return res.status(401).json({ error: 'Código de acceso inválido.' });
    }
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Límite de 12 solicitudes por minuto alcanzado. Espera un momento.'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Falta configurar GEMINI_API_KEY en el servidor.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'JSON de solicitud inválido.' });
    }
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const images = Array.isArray(body?.images) ? body.images : [];

  if (!prompt && images.length === 0) {
    return res.status(400).json({ error: 'Envía al menos una imagen o una pregunta.' });
  }

  if (images.length > MAX_IMAGES) {
    return res.status(400).json({
      error: `Máximo ${MAX_IMAGES} imágenes por solicitud.`
    });
  }

  const parts = [];
  for (const img of images) {
    const base64Data = typeof img === 'string' ? img : img?.data;
    const mimeType =
      (typeof img === 'object' && img?.mime_type) || 'image/jpeg';

    if (!base64Data || typeof base64Data !== 'string') {
      return res.status(400).json({ error: 'Formato de imagen inválido.' });
    }

    const cleanBase64 = base64Data.includes(',')
      ? base64Data.split(',')[1]
      : base64Data;

    if (cleanBase64.length > MAX_BASE64_BYTES) {
      return res.status(413).json({
        error: 'Una de las imágenes supera el tamaño máximo (~3 MB).'
      });
    }

    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: cleanBase64
      }
    });
  }

  parts.push({
    text: prompt || 'Revisa este circuito armado.'
  });

  const model = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const payload = {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }]
    },
    contents: [
      {
        role: 'user',
        parts
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 900
    }
  };

  try {
    const geminiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const data = await geminiRes.json().catch(() => ({}));

    if (!geminiRes.ok) {
      const status = geminiRes.status;
      const msg =
        data?.error?.message ||
        (status === 429
          ? 'Límite de cuota de Gemini alcanzado (HTTP 429).'
          : 'Error al consultar la API de Gemini.');
      return res.status(status).json({ error: msg });
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return res.status(502).json({
        error: 'Gemini no devolvió contenido de análisis.'
      });
    }

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({
      error: `Fallo de red hacia Gemini: ${err.message || 'error desconocido'}`
    });
  }
}
