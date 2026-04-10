'use strict';

const https = require('https');
const { buildRamiroSystemPrompt } = require('../config/ramiroSystemPrompt');
const { safeJsonParse, translateBrainToLegacy } = require('../utils/ramiroHelpers');
const { getUserMemory, rememberFacts, formatMemoryForPrompt } = require('./ramiroMemory');

const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-pro',
];

function getGeminiApiKeys() {
  const candidates = [
    process.env.GOOGLE_AI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.CLAVE_API_IA_GOOGLE,
    process.env.CLAVE_API_GEMINIS,
    process.env['CLAVE_API_GÉMINIS'],
  ]
    .map(v => String(v || '').trim())
    .filter(Boolean);

  return [...new Set(candidates)];
}

/**
 * Llama a la API de Gemini con el prompt dado y devuelve el texto bruto.
 * @param {string} prompt
 * @param {number} [temperature=0.25] - 0.25 para JSON estructurado, 0.8 para conversación libre
 */
async function callGeminiBrain(prompt, temperature = 0.25) {
  const geminiApiKeys = getGeminiApiKeys();
  if (!geminiApiKeys.length) {
    throw new Error('Faltan GOOGLE_AI_API_KEY y GEMINI_API_KEY en variables de entorno');
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 4096 },
  });

  let lastError = null;
  for (const apiKey of geminiApiKeys) {
    for (const model of CANDIDATE_MODELS) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const text = await new Promise((resolve, reject) => {
          const u = new URL(geminiUrl);
          const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.error?.message) return reject(new Error(parsed.error.message));
                const out = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                resolve(out);
              } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });

        if (text) return text;
        lastError = new Error(`Respuesta vacía del modelo ${model}`);
      } catch (e) {
        lastError = e;
        const msg = String(e?.message || '').toLowerCase();
        if (!msg.includes('not found') && !msg.includes('not supported') && !msg.includes('model')) break;
      }
    }
  }
  throw lastError || new Error('No fue posible obtener respuesta de Gemini');
}

/**
 * Fallback seguro cuando Gemini no retorna JSON válido o la confianza es muy baja.
 */
function buildFallbackDecision(userMessage, question = null, rawResponse = null) {
  const cleanRaw = String(rawResponse || '').trim();
  const hasUsefulRaw = cleanRaw.length >= 12;
  let fallbackText;
  if (hasUsefulRaw) {
    fallbackText = cleanRaw.slice(0, 2200);
  } else if (question) {
    fallbackText = question;
  } else {
    const msgLower = String(userMessage || '').toLowerCase();
    const isOperational = isLikelyOperationalMessage(userMessage);
    const hasPriceSignal = msgLower.includes('precio')
      || /\$\s*[0-9]{2,6}/.test(msgLower)
      || /[0-9]{2,6}\s*(usd|dolares|dólares)/.test(msgLower);
    if (isOperational && hasPriceSignal) {
      fallbackText = 'Disculpa, no pude cerrar bien el cambio de precio. Dime el producto y el monto, por ejemplo: cambiar precio de iPhone 15 a $899.';
    } else if (isOperational && (msgLower.includes('imagen') || msgLower.includes('foto') || msgLower.match(/https?:\/\//))) {
      fallbackText = 'Disculpa, el cambio de imagen quedó incompleto. Dime primero el producto y luego me mandas el URL.';
    } else if (isOperational && (msgLower.includes('crear') || msgLower.includes('nuevo'))) {
      fallbackText = 'Para crear el producto necesito al menos nombre, categoría y precio. Si quieres, te lo voy pidiendo paso a paso.';
    } else if (!isOperational || isLikelyGeneralConversation(userMessage)) {
      fallbackText = buildOfflineGeneralConversationText(userMessage)
        || 'Te entendí. Si quieres, seguimos conversando normal; también puedo ayudarte con productos cuando me lo pidas.';
    } else {
      fallbackText = 'Entendí que quieres hacer un cambio, pero me faltó contexto para ejecutarlo. Dime qué producto quieres tocar y qué campo quieres cambiar.';
    }
  }

  return {
    mode: hasUsefulRaw ? 'general' : 'clarification',
    intent: 'fallback_no_parse',
    confidence: 0,
    requiresConfirmation: false,
    needsClarification: !hasUsefulRaw,
    understood: hasUsefulRaw
      ? 'Respuesta conversacional recuperada de salida no estructurada.'
      : 'No pude interpretar la intención con seguridad.',
    entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
    action: hasUsefulRaw ? { type: 'answer', payload: {} } : { type: 'ask', payload: {} },
    question: hasUsefulRaw ? null : fallbackText,
    response: fallbackText,
    memory: { shouldRemember: false, facts: [] },
  };
}

function isGenericClarificationText(text = '') {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  return t.includes('en que te puedo ayudar')
    || t.includes('que quieres hacer exactamente')
    || t.includes('no pude procesar bien ese mensaje')
    || t.includes('no entendi bien tu solicitud');
}

function normalizeForIntent(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyGeneralConversation(text = '') {
  const n = normalizeForIntent(text);
  if (!n) return false;

  const signals = [
    'hola', 'hey', 'buenas', 'que tal', 'como estas', 'como te va', 'que opinas',
    'a que equipo le vas', 'mundial', 'futbol', 'paises', 'selecciones', 'quien gana', 'argentina', 'argentino',
    'guerra fria', 'historia', 'inteligencia artificial', 'ia', 'explicame', 'cuentame',
    'que sabes', 'por que', 'porque', 'como funciona', 'que significa', 'cual es', 'cuales son'
  ];

  return signals.some(signal => n.includes(signal))
    || /^(que|como|cual|cuales|quien|quienes|donde|cuando|por que|porque|me puedes|puedes|opinas|si|simon)/.test(n);
}

function isLikelyOperationalMessage(text = '') {
  const n = normalizeForIntent(text);
  if (!n) return false;
  if (isLikelyGeneralConversation(text)) return false;
  return [
    'precio', 'producto', 'catalogo', 'categoria', 'imagen', 'color', 'stock', 'variante',
    'crear', 'agregar', 'anadir', 'editar', 'actualizar', 'eliminar', 'borrar',
    'activar', 'desactivar', 'ocultar', 'mostrar', 'importar', 'url', 'link', 'cotizacion'
  ].some(k => n.includes(k));
}

function buildOfflineGeneralConversationText(userMessage = '') {
  const n = normalizeForIntent(userMessage);
  if (!n) return '';

  if (n.includes('guerra fria')) {
    return 'Claro. La Guerra Fria fue una rivalidad geopolitica (1947-1991) entre Estados Unidos y la URSS. No fue una guerra directa entre ambas potencias, sino un conflicto de influencia global con carrera armamentista nuclear, espionaje, propaganda y guerras indirectas (Corea, Vietnam, Afganistan). En Europa simbolizo la division entre bloques (OTAN y Pacto de Varsovia), con episodios criticos como Berlin y la Crisis de los Misiles en Cuba (1962). Termino con la crisis del bloque sovietico y la disolucion de la URSS en 1991.';
  }

  if (n.includes('que es la ia') || n.includes('inteligencia artificial')) {
    return 'La inteligencia artificial es el campo que desarrolla sistemas capaces de realizar tareas cognitivas, como comprender lenguaje, reconocer patrones, predecir resultados y apoyar decisiones, usando modelos entrenados con datos.';
  }

  if (n.includes('a que equipo le vas') || (n.includes('equipo') && n.includes('mundial'))) {
    return 'No tengo camiseta propia, pero si me preguntas por nivel de juego y consistencia, Argentina suele aparecer fuerte. Si quieres, también te puedo responder más neutral y comparar favoritos al Mundial.';
  }

  if ((n.includes('paises') || n.includes('selecciones')) && n.includes('mundial')) {
    return 'Depende de cuál Mundial hablas, porque los clasificados cambian por edición. Si me dices si te refieres a 2022, 2026 u otro, te digo los países exactos; si quieres, también te explico cómo se reparten los cupos por confederación.';
  }

  if (n.includes('argentina') || n.includes('argentino')) {
    return 'Si hablas de Argentina para el Mundial, suele estar entre favoritos por plantilla y funcionamiento. Si quieres, te comparo contra 2 o 3 selecciones fuertes y te digo puntos clave.';
  }

  if (n.includes('futbol') || n.includes('mundial')) {
    return 'Sí puedo conversar de fútbol. Si quieres, te hablo de favoritos, clasificados, formato del Mundial o historia del torneo. Si me dices el año exacto, te respondo mejor.';
  }

  return '';
}

function buildOfflineGeneralDecision(userMessage = '') {
  const text = buildOfflineGeneralConversationText(userMessage);
  if (!text) return null;
  return {
    mode: 'general',
    intent: 'offline_general_fallback',
    confidence: 0.35,
    requiresConfirmation: false,
    needsClarification: false,
    understood: 'Pregunta general atendida con fallback local por indisponibilidad temporal del modelo.',
    entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
    action: { type: 'answer', payload: {} },
    question: null,
    response: text,
    memory: { shouldRemember: false, facts: [] },
  };
}

async function buildGeneralConversationText({ storeName = 'MacStore', userMessage = '' }) {
  const msg = String(userMessage || '').trim();
  if (!msg) return '';

  const prompt = `Eres Ramiro, asistente conversacional de ${storeName}.
Responde en español, de forma natural, útil y directa a este mensaje del usuario.
No uses JSON, no menciones reglas internas, no pidas formato especial.

Usuario: ${msg}`;

  try {
    const text = await callGeminiBrain(prompt);
    return String(text || '').trim();
  } catch {
    return '';
  }
}

/**
 * Función principal del brain. Recibe contexto completo y devuelve decisión estructurada.
 *
 * @param {object} opts
 * @param {string} opts.userMessage - Mensaje del usuario
 * @param {string} opts.userId - Email del admin (para memoria por usuario)
 * @param {string} opts.storeName
 * @param {string} opts.personality
 * @param {string} opts.notes
 * @param {boolean} opts.autonomousMode
 * @param {Array}  opts.allProducts - Array de todos los productos [{id, name, category, price, active, ...}]
 * @param {object|null} opts.implicitProduct - Producto en contexto actual
 * @param {string} opts.persistentHistory - Historial de conversación como texto
 * @param {string} opts.quoteSummary - Resumen de cotizaciones
 * @param {string} opts.recentHistory - Historial de la sesión actual
 */
async function thinkRamiro(opts) {
  const {
    userMessage = '',
    userId = 'admin',
    storeName = 'MacStore',
    personality = '',
    notes = '',
    autonomousMode = true,
    allProducts = [],
    implicitProduct = null,
    persistentHistory = '',
    quoteSummary = '',
    recentHistory = '',
    projectContext = '',
  } = opts;

  // Cargar memoria del usuario
  let userMemory;
  try { userMemory = await getUserMemory(userId); } catch { userMemory = {}; }
  const memorySummary = formatMemoryForPrompt(userMemory) || '';

  // Catálogo resumido
  const catalogSummary = allProducts.map(p =>
    `ID=${p.id} | ${p.name} (${p.category}): $${p.price} | activo:${p.active ? 'si' : 'no'} | imagen:${p.image_url ? 'si' : 'no'}`
  ).join('\n');

  // Atajo conversacional por defecto: cualquier mensaje no operacional va por respuesta natural.
  if (!isLikelyOperationalMessage(userMessage)) {
    const conversationalPrompt = `Eres Ramiro, asistente de ${storeName || 'MacStore'}.
Responde en español, de forma natural, directa y coherente con lo que el usuario dice.
No uses JSON. No menciones reglas internas. Responde exactamente sobre el tema del mensaje.
${recentHistory ? `\nContexto reciente de la conversación:\n${recentHistory}\n` : ''}
Usuario: ${userMessage}`;

    try {
      const convText = await callGeminiBrain(conversationalPrompt, 0.8);
      const text = String(convText || '').trim();
      if (text && !isGenericClarificationText(text)) {
        const fb = buildFallbackDecision(userMessage, null, text);
        fb.mode = 'general';
        fb.intent = 'general_chat';
        return { decision: fb, legacy: translateBrainToLegacy(fb) };
      }
    } catch {
      // Si falla, continua con el brain completo
    }
  }

  const systemPrompt = buildRamiroSystemPrompt({
    storeName, personality, notes, memorySummary,
    catalogSummary, quoteSummary, persistentHistory,
    implicitProduct, autonomousMode, projectContext,
  });

  const fullPrompt = `${systemPrompt}

CONVERSACIÓN RECIENTE EN ESTA SESIÓN:
${recentHistory || '(ninguna)'}

Admin: ${userMessage}

Responde SOLO en JSON válido según el esquema indicado.`;

  let rawText;
  try {
    rawText = await callGeminiBrain(fullPrompt);
  } catch (e) {
    console.error('[RamiroBrain] Error llamando a Gemini:', e.message);
    if (!isLikelyOperationalMessage(userMessage)) {
      const offlineDecision = buildOfflineGeneralDecision(userMessage);
      if (offlineDecision) {
        return {
          decision: offlineDecision,
          legacy: translateBrainToLegacy(offlineDecision),
        };
      }
    }
    return {
      decision: buildFallbackDecision(userMessage),
      legacy: translateBrainToLegacy(buildFallbackDecision(userMessage)),
    };
  }

  const parsed = safeJsonParse(rawText);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
    console.warn('[RamiroBrain] JSON inválido de Gemini:', String(rawText).slice(0, 300));
    let generalText = String(rawText || '').trim();
    if (!generalText || isGenericClarificationText(generalText)) {
      generalText = await buildGeneralConversationText({ storeName, userMessage });
      if ((!generalText || isGenericClarificationText(generalText)) && !isLikelyOperationalMessage(userMessage)) {
        generalText = buildOfflineGeneralConversationText(userMessage);
      }
    }
    const fb = buildFallbackDecision(userMessage, null, generalText || rawText);
    return { decision: fb, legacy: translateBrainToLegacy(fb) };
  }

  const decision = parsed.data;

  // Si el modelo devolvió una aclaración genérica en temas abiertos, pedir una respuesta conversacional real.
  const actionType = String(decision?.action?.type || '').toLowerCase();
  const isNonOperationalAsk = !actionType || actionType === 'ask' || actionType === 'none';
  if ((decision?.needsClarification || decision?.mode === 'clarification')
    && isNonOperationalAsk
    && (isGenericClarificationText(decision?.question || decision?.response) || isLikelyGeneralConversation(userMessage))) {
    let generalText = await buildGeneralConversationText({ storeName, userMessage });
    if (!generalText || isGenericClarificationText(generalText)) {
      generalText = buildOfflineGeneralConversationText(userMessage);
    }
    if (generalText) {
      decision.mode = 'general';
      decision.intent = decision.intent || 'general_chat';
      decision.needsClarification = false;
      decision.requiresConfirmation = false;
      decision.action = { type: 'answer', payload: {} };
      decision.question = null;
      decision.response = generalText;
    }
  }

  // Guardar memoria en background si aplica
  if (decision?.memory?.shouldRemember && Array.isArray(decision?.memory?.facts) && decision.memory.facts.length) {
    rememberFacts(userId, decision.memory.facts).catch(e =>
      console.error('[RamiroBrain] Error guardando memoria:', e.message)
    );
  }

  const legacy = translateBrainToLegacy(decision);

  return { decision, legacy };
}

module.exports = { thinkRamiro, callGeminiBrain };
