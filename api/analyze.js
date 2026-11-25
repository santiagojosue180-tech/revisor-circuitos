

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isHighDemandError(status, message = "") {
  const text = String(message).toLowerCase();
  return (
    status === 503 ||
    status === 429 ||
    text.includes("high demand") ||
    text.includes("overloaded") ||
    text.includes("unavailable") ||
    text.includes("try again later")
  );
}

function findImageString(input, depth = 0) {
  if (!input || depth > 5) {
    return null;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("data:image/") || trimmed.length > 200) {
      return trimmed;
    }
    return null;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findImageString(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof input === "object") {
    const preferredKeys = [
      "image",
      "imageBase64",
      "base64",
      "photo",
      "frame",
      "dataUrl",
      "img",
      "src",
      "capture",
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        const found = findImageString(input[key], depth + 1);
        if (found) {
          return found;
        }
      }
    }

    for (const value of Object.values(input)) {
      const found = findImageString(value, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function extractBase64Image(body) {
  const rawImage = findImageString(body);
  if (!rawImage) {
    return null;
  }

  const dataUrlMatch = rawImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      data: dataUrlMatch[2].replace(/\s+/g, ""),
    };
  }

  return {
    mimeType: "image/jpeg",
    data: rawImage.replace(/\s+/g, ""),
  };
}

function parseCleanJson(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("El modelo devolvió una respuesta vacía.");
  }

  let cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

function buildGeminiUrl(model, apiKey) {
  const cleanModel = encodeURIComponent(String(model || DEFAULT_MODEL).trim());
  const cleanKey = encodeURIComponent(String(apiKey || "").trim());
  return (
    "[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/)" +
    cleanModel +
    ":generateContent?key=" +
    cleanKey
  );
}

async function callGeminiWithRetry({ apiKey, model, payload }) {
  const endpoint = buildGeminiUrl(model, apiKey);
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const apiMessage =
          data && data.error && data.error.message
            ? data.error.message
            : "Error HTTP " + response.status + " al consultar Gemini.";

        if (attempt < MAX_RETRIES && isHighDemandError(response.status, apiMessage)) {
          await sleep(1200 * (attempt + 1));
          continue;
        }

        const err = new Error(apiMessage);
        err.statusCode = response.status === 503 || response.status === 429 ? 503 : response.status;
        throw err;
      }

      const candidate = data && data.candidates ? data.candidates[0] : null;
      const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
      const textPartObj = parts.find((part) => part && typeof part.text === "string");
      const textPart = textPartObj ? textPartObj.text : "";

      if (!textPart) {
        throw new Error("La respuesta de Gemini no incluyó contenido de texto.");
      }

      return {
        parsedJson: parseCleanJson(textPart),
        finishReason: (candidate && candidate.finishReason) || "STOP",
      };
    } catch (error) {
      lastError = error;

      if (error instanceof SyntaxError) {
        if (attempt < MAX_RETRIES) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        const parseErr = new Error("La respuesta JSON llegó incompleta o mal formada.");
        parseErr.statusCode = 502;
        throw parseErr;
      }

      if (attempt < MAX_RETRIES && isHighDemandError(error.statusCode, error.message)) {
        await sleep(1200 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("No se pudo completar el análisis del circuito.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usa POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel." });
  }

  const model = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const image = extractBase64Image(body);

    if (!image || !image.data) {
      return res.status(400).json({
        error: "No se recibió ninguna imagen válida del circuito.",
        receivedKeys: Object.keys(body || {}),
      });
    }

    const prompt = [
      "Analiza este circuito electrónico/eléctrico (protoboard, PCB, cableado o diagrama).",
      "Responde ÚNICAMENTE con un objeto JSON válido, breve y conciso, sin texto extra:",
      "{",
      '  "resumen": "descripción corta del montaje",',
      '  "componentes": ["lista de componentes visibles"],',
      '  "posibles_fallas": ["errores de conexión, cortos o riesgos detectados"],',
      '  "recomendaciones": ["pasos breves para corregir o validar"]',
      "}",
    ].join("\n");

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: image.mimeType,
                data: image.data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
    };

    const { parsedJson, finishReason } = await callGeminiWithRetry({
      apiKey,
      model,
      payload,
    });

    return res.status(200).json({
      ok: true,
      model,
      finishReason,
      analysis: parsedJson,
    });
  } catch (error) {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    return res.status(status).json({
      ok: false,
      model,
      error: error.message || "Error interno al analizar el circuito.",
    });
  }
}
