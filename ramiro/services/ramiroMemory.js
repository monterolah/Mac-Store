'use strict';
const { getRamiroMemory, setRamiroMemory } = require('../../db/sqlite');

const MAX_FACTS = 120;

async function getUserMemory(userId) {
  try {
    const row = getRamiroMemory(String(userId).toLowerCase());
    if (!row) return { preferences: {}, aliases: {}, notes: [] };
    return {
      preferences: row.preferences || {},
      aliases:     row.aliases     || {},
      notes:       row.notes       || [],
    };
  } catch { return { preferences: {}, aliases: {}, notes: [] }; }
}

async function rememberFacts(userId, facts = []) {
  if (!facts?.length) return;
  try {
    const current     = await getUserMemory(userId);
    const preferences = { ...(current.preferences || {}) };
    for (const fact of facts) {
      if (!fact?.key) continue;
      preferences[fact.key] = { value: fact.value, reason: fact.reason || '', updatedAt: new Date().toISOString() };
      const keys = Object.keys(preferences);
      if (keys.length > MAX_FACTS) {
        const oldest = keys.sort((a,b) => new Date(preferences[a].updatedAt||0) - new Date(preferences[b].updatedAt||0))[0];
        delete preferences[oldest];
      }
    }
    setRamiroMemory(String(userId).toLowerCase(), { ...current, preferences });
  } catch(e) { console.error('[RamiroMemory] Error guardando hechos:', e.message); }
}

function formatMemoryForPrompt(memory = {}) {
  const prefs = memory.preferences || {};
  const keys  = Object.keys(prefs);
  if (!keys.length) return null;
  return keys.map(k => `• [${k}] ${prefs[k].value}${prefs[k].reason ? ` (${prefs[k].reason})` : ''}`).join('\n');
}

async function learnPattern(userId, trigger, meaning) {
  if (!trigger || !meaning) return;
  const key = `pattern_${trigger.trim().toLowerCase().slice(0,40).replace(/\s+/g,'_')}`;
  await rememberFacts(userId, [{ key, value: meaning, reason: `Aprendido del contexto: "${trigger.slice(0,60)}"` }]);
}

module.exports = { getUserMemory, rememberFacts, formatMemoryForPrompt, learnPattern };
