# Revisor de circuitos

Aplicación web *mobile-first* para estudiantes de ingeniería que revisan circuitos en protoboard, PCB o esquemas usando la cámara del celular y Google Gemini.

## Pasos para publicar en Vercel

1. Crea tu API key gratuita en Google AI Studio (`aistudio.google.com`).
2. Sube este proyecto a un repositorio de GitHub conservando la estructura:
   - `index.html`
   - `vercel.json`
   - `LEEME.md`
   - `api/analyze.js`
3. Importa el repositorio en Vercel (`vercel.com`).
4. Configura las variables de entorno en Vercel:
   - `GEMINI_API_KEY`: tu API key de Google AI Studio.
   - `ACCESS_CODE` *(opcional)*: contraseña corta exigida en el encabezado `x-code`.
   - `GEMINI_MODEL` *(opcional)*: por defecto `gemini-2.5-flash`.
5. Haz clic en **Deploy** y abre el enlace generado desde tu celular.
