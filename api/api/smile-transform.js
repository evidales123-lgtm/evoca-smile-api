// ═══════════════════════════════════════════════════════════
// EVOCA — Smile Transform API (Vercel Serverless Function)
// ═══════════════════════════════════════════════════════════
// Archivo: /api/smile-transform.js
// Despliega en Vercel como serverless function.
// Tu OpenAI API key va en las variables de entorno de Vercel,
// NUNCA en el código.
// ═══════════════════════════════════════════════════════════

// Rate limiting simple por IP (en memoria — se reinicia con cada cold start)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 5;       // máximo 5 requests
const RATE_LIMIT_WINDOW = 3600; // por hora (en segundos)

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW * 1000;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false; // rate limited
  }

  timestamps.push(now);
  return true; // allowed
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*'); // En producción, cambia * por tu dominio real
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Rate limit
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Has alcanzado el límite de usos. Intenta más tarde.' });
  }

  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No se recibió imagen' });
    }

    // Validar tamaño (base64 ~= 1.37x del archivo original)
    const estimatedSizeBytes = (image.length * 3) / 4;
    if (estimatedSizeBytes > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'La imagen es demasiado grande. Máximo 10MB.' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY no configurada');
      return res.status(500).json({ error: 'Error de configuración del servidor' });
    }

    // ═══════════════════════════════════════════
    // OPCIÓN A: Usar gpt-image-1 (recomendado)
    // Genera una imagen editada a partir del input
    // ═══════════════════════════════════════════

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: await buildFormData(image),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('OpenAI API error:', errData);
      return res.status(502).json({
        error: 'No pudimos generar la vista previa. Intenta con otra foto.'
      });
    }

    const data = await response.json();

    // La respuesta contiene la imagen en base64 o URL
    let resultImage;
    if (data.data?.[0]?.b64_json) {
      resultImage = data.data[0].b64_json;
    } else if (data.data?.[0]?.url) {
      // Si viene como URL, descargar y convertir a base64
      const imgResponse = await fetch(data.data[0].url);
      const imgBuffer = await imgResponse.arrayBuffer();
      resultImage = Buffer.from(imgBuffer).toString('base64');
    } else {
      return res.status(502).json({ error: 'Respuesta inesperada de la API' });
    }

    return res.status(200).json({ result: resultImage });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ═══════════════════════════════════════════
// Construir FormData para OpenAI Images API
// ═══════════════════════════════════════════
async function buildFormData(base64Image) {
  const { FormData, Blob } = await import('formdata-node');

  // Convertir base64 a buffer
  const imageBuffer = Buffer.from(base64Image, 'base64');

  // Crear blob
  const imageBlob = new Blob([imageBuffer], { type: 'image/png' });

  const form = new FormData();
  form.set('image', imageBlob, 'selfie.png');
  form.set('model', 'dall-e-2');   // Cambiar a 'gpt-image-1' si tienes acceso
  form.set('size', '1024x1024');
  form.set('n', '1');
  form.set('response_format', 'b64_json');
  form.set('prompt', SMILE_PROMPT);

  return form;
}

// ═══════════════════════════════════════════
// PROMPT — Lo que le pedimos a la IA
// ═══════════════════════════════════════════
const SMILE_PROMPT = `Edit this photo of a person smiling to show an enhanced, beautiful version of their smile. 

Apply ONLY these changes:
1. Make the teeth look naturally whiter, well-aligned, and proportionally sized
2. Ensure the smile looks harmonious with the person's face shape
3. Subtly brighten and even out the skin tone around the mouth area
4. Keep every other facial feature EXACTLY the same — eyes, nose, hair, skin, ears, everything

CRITICAL RULES:
- The person must be clearly recognizable as themselves
- The result must look natural, NOT artificial or exaggerated
- Do NOT change the person's face shape, hair, or any feature other than the smile
- The teeth should look like high-quality dental veneers — natural, not "Hollywood white"
- Maintain the exact same lighting, angle, background, and clothing
- This is a dental smile preview, not a beauty filter`;
