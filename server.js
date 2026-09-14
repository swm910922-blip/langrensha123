// ============================================================
// 狼人殺後端 v12.1（OpenAI + 開場/回應分離 + 深度思考）
// ============================================================
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.static('.'));
app.get('/', (req, res) => res.send('🐺 狼人殺伺服器運作中'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const rooms = new Map();

const PHASE_SECONDS = {
  NIGHT_WOLF: 30, NIGHT_SEER: 25, NIGHT_DOCTOR: 20, NIGHT_SNIPER: 20,
  DAY_ANNOUNCE: 12, DAY_DISCUSS: 120, DAY_VOTE: 60,
};

// ============================================================
// 🤖 AI Provider 設定
// ============================================================
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const GROQ_MODEL_CANDIDATES = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
];

const GEMINI_MODEL_CANDIDATES = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

const OPENAI_MODEL_CANDIDATES = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
];

let activeGroqModel = null;
let activeGeminiModel = null;
let activeOpenAIModel = null;
let activeGeminiApiVersion = 'v1beta';
let PROVIDER = 'NONE';
let MODEL_NAME = '';
let RPM_LIMIT = 3;

if (OPENAI_API_KEY) {
  PROVIDER = 'OPENAI';
  MODEL_NAME = 'gpt-4o-mini';
  RPM_LIMIT = 60;
} else if (GROQ_API_KEY) {
  PROVIDER = 'GROQ';
  MODEL_NAME = 'detecting...';
  RPM_LIMIT = 10;
} else if (GEMINI_API_KEY) {
  PROVIDER = 'GEMINI';
  MODEL_NAME = 'detecting...';
  RPM_LIMIT = 12;
}

let USE_GPT = PROVIDER !== 'NONE';

const GPT_SPEAK_PROB = PROVIDER === 'OPENAI' ? 0.9
  : PROVIDER === 'GROQ' ? 0.4
  : PROVIDER === 'GEMINI' ? 0.55 : 0.3;

const GPT_VOTE_PROB = PROVIDER === 'OPENAI' ? 0.9
  : PROVIDER === 'GROQ' ? 0.6
  : PROVIDER === 'GEMINI' ? 0.85 : 0.4;

console.log(`========================================`);
console.log(`🐺 狼人殺伺服器啟動`);
console.log(`🤖 AI Provider: ${PROVIDER}`);
if (USE_GPT) {
  console.log(`📦 使用模型: ${MODEL_NAME}`);
  console.log(`⚡ 限速: ${RPM_LIMIT} RPM`);
}
console.log(`========================================`);

// ============================================================
// 🔍 Groq 模型偵測
// ============================================================
async function detectGroqModel() {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const allModels = (data.data || []).map(m => m.id);
    const excludeKeywords = ['tts', 'whisper', 'orpheus', 'playai', 'audio', 'speech', 'voice', 'prompt-guard', 'safeguard'];
    const chatModels = allModels.filter(id => {
      const lower = id.toLowerCase();
      return !excludeKeywords.some(kw => lower.includes(kw));
    });
    for (const model of GROQ_MODEL_CANDIDATES) {
      if (chatModels.includes(model)) return model;
    }
    if (chatModels.length > 0) return chatModels[0];
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// 🔍 Gemini 模型偵測
// ============================================================
async function detectGeminiModel() {
  if (!GEMINI_API_KEY) return null;
  const apiVersions = ['v1beta', 'v1'];
  for (const version of apiVersions) {
    for (const model of GEMINI_MODEL_CANDIDATES) {
      try {
        const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            generationConfig: { maxOutputTokens: 20 }
          })
        });
        if (res.ok) {
          activeGeminiApiVersion = version;
          return model;
        }
      } catch (e) {}
    }
  }
  return null;
}

// ============================================================
// 🚦 智慧限速
// ============================================================
const requestTimestamps = [];
function getWaitTime() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > 60000) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length < RPM_LIMIT) return 0;
  return 60000 - (now - requestTimestamps[0]) + 200;
}

const requestQueue = [];
let queueRunning = false;

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (requestQueue.length > 0) {
    const job = requestQueue.shift();
    const wait = getWaitTime();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    requestTimestamps.push(Date.now());
    try {
      const result = await job.fn();
      job.resolve(result);
    } catch (e) {
      console.warn('[queue job error]', e.message);
      job.resolve(null);
    }
  }
  queueRunning = false;
}

function enqueue(fn) {
  return new Promise((resolve) => {
    requestQueue.push({ fn, resolve });
    processQueue();
  });
}

// ============================================================
// 🚀 Groq API
// ============================================================
async function callGroq(messages, maxTokens) {
  const model = activeGroqModel || MODEL_NAME;
  const MAX_RETRY = 3;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.95 }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 429 || res.status === 503) {
        await new Promise(r => setTimeout(r, ((2 ** attempt) + Math.random()) * 1000));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      clearTimeout(timeout);
    }
  }
  return null;
}

// ============================================================
// 🤖 Gemini API
// ============================================================
async function callGemini(messages, maxTokens) {
  if (!activeGeminiModel) return null;
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const body = {
    contents: userMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.95,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

  const MAX_RETRY = 4;
  const modelChain = [activeGeminiModel, ...GEMINI_MODEL_CANDIDATES.filter(m => m !== activeGeminiModel)];

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const useModel = modelChain[attempt % modelChain.length];
    const url = `https://generativelanguage.googleapis.com/${activeGeminiApiVersion}/models/${useModel}:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 429 || res.status === 503 || res.status === 500 || res.status === 502 || res.status === 404) {
        await new Promise(r => setTimeout(r, ((2 ** attempt) + Math.random()) * 1000));
        continue;
      }
      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 400 && errText.includes('thinkingConfig') && attempt === 0) {
          delete body.generationConfig.thinkingConfig;
          continue;
        }
        return null;
      }
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch (e) {
      clearTimeout(timeout);
    }
  }
  return null;
}

// ============================================================
// 🤖 OpenAI API（主力）
// ============================================================
async function callOpenAI(messages, maxTokens) {
  const MAX_RETRY = 3;
  let lastErr = null;
  const modelChain = [activeOpenAIModel || 'gpt-4o-mini', ...OPENAI_MODEL_CANDIDATES.filter(m => m !== activeOpenAIModel)];

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const useModel = modelChain[attempt % modelChain.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: useModel,
          messages,
          max_tokens: maxTokens,
          temperature: 0.95,
          presence_penalty: 0.6,
          frequency_penalty: 0.4,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after')) || (2 ** attempt);
        console.warn(`[OpenAI] ${useModel} 429 → 等待 ${retryAfter.toFixed(1)}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        lastErr = 'rate_limit';
        continue;
      }
      if (res.status === 503 || res.status === 500 || res.status === 502) {
        const wait = (2 ** attempt) + Math.random();
        console.warn(`[OpenAI] ${useModel} ${res.status} → 換模型重試`);
        await new Promise(r => setTimeout(r, wait * 1000));
        lastErr = `http_${res.status}`;
        continue;
      }
      if (!res.ok) {
        const errText = await res.text();
        console.warn('[OpenAI]', res.status, errText.slice(0, 200));
        return null;
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      clearTimeout(timeout);
      lastErr = e.message;
      if (attempt < MAX_RETRY - 1) {
        await new Promise(r => setTimeout(r, ((2 ** attempt) + Math.random()) * 1000));
        continue;
      }
    }
  }
  console.warn(`[OpenAI] 放棄重試，最後錯誤：${lastErr}`);
  return null;
}

// ============================================================
// 🎯 統一介面
// ============================================================
async function askGPT(messages, maxTokens = 120) {
  if (!USE_GPT) return null;
  return enqueue(async () => {
    try {
      if (PROVIDER === 'OPENAI') return await callOpenAI(messages, maxTokens);
      if (PROVIDER === 'GROQ') return await callGroq(messages, maxTokens);
      if (PROVIDER === 'GEMINI') return await callGemini(messages, maxTokens);
      return null;
    } catch (e) {
      console.warn(`[${PROVIDER} error]`, e.message);
      return null;
    }
  });
}

// ============================================================
// 工具
// ============================================================
function genRoomId(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do { id = ''; for (let i=0;i<len;i++) id += chars[Math.floor(Math.random()*chars.length)]; }
  while (rooms.has(id));
  return id;
}
function nameOf(room, id) { return room.players.find(x=>x.id===id)?.name || '未知'; }
function roleName(role) {
  return { WEREWOLF:'🐺 狼人', SNIPER:'🎯 狙擊手', SEER:'🔮 警察', DOCTOR:'💉 醫生', VILLAGER:'👤 平民' }[role] || role;
}
function roleLabel(role) {
  if (role === 'WEREWOLF') return '🐺 狼人';
  if (role === 'SNIPER')   return '🎯 狙擊手';
  if (role === 'SEER')     return '🔮 警察';
  if (role === 'DOCTOR')   return '💉 醫生';
  if (role === 'VILLAGER') return '👤 平民';
  if (role === 'GOOD')     return '✅ 好人';
  if (role === 'WOLF')     return '🐺 壞人';
  return role;
}
function publicPlayers(room) {
  return room.players.map(p => ({ id:p.id, name:p.name, alive:p.alive, isHost:p.isHost, isAI:!!p.isAI }));
}
function roomPayload(room) {
  return {
    roomId: room.roomId,
    players: publicPlayers(room),
    phase: room.phase,
    dayDiscussTime: room.dayDiscussTime || 120,
    hostId: room.hostId,
  };
}
function broadcastPlayers(room) { io.to(room.roomId).emit('players_updated', { players: publicPlayers(room) }); }
function emitRoomState(room) { io.to(room.roomId).emit('room_updated', roomPayload(room)); }
function tallyVotes(room) { const t={}; Object.values(room.votes).forEach(v => { if(v) t[v]=(t[v]||0)+1; }); return t; }
function topVoted(tally) { let max=0,top=null; Object.keys(tally).forEach(id => { if(tally[id]>max){max=tally[id];top=id;} }); return top; }
function systemMsg(room, text) { io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', system:true, text }); }
function randomPick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

function killPlayer(room, p, cause) {
  if (!p || !p.alive) return false;
  p.alive = false;
  p.deathCause = cause;
  p.canSpeakInPublic = true;
  return true;
}
function announceDeath(room, player, cause) {
  const causeText = { WOLF:'被狼人殺害', SNIPER:'被狙擊手擊殺', VOTE:'被投票放逐', DOCTOR:'被醫生的空針毒死', DISCONNECT:'離線' }[cause] || '出局';
  systemMsg(room, `💀 ${player.name} ${causeText}，他的身分是【${roleName(player.role)}】，可以發表一句遺言。`);
  onPlayerRevealed(room, player);
}

// ============================================================
// 🧠 貝氏信念
// ============================================================
function initBeliefs(room) {
  const alive = room.players.filter(p => p.alive);
  const wolfCount = room.players.filter(p => p.role === 'WEREWOLF' || p.role === 'SNIPER').length;
  const baseRate = wolfCount / Math.max(1, alive.length);
  room.aiBeliefs = {};
  room.players.forEach(ai => {
    if (!ai.isAI) return;
    room.aiBeliefs[ai.id] = {};
    room.players.forEach(target => {
      if (target.id === ai.id) return;
      room.aiBeliefs[ai.id][target.id] = { wolfProb: baseRate, reasons: [] };
    });
  });
}
function updateBelief(room, aiId, targetId, delta, reason) {
  if (!room.aiBeliefs || !room.aiBeliefs[aiId] || !room.aiBeliefs[aiId][targetId]) return;
  const b = room.aiBeliefs[aiId][targetId];
  b.wolfProb = Math.max(0.01, Math.min(0.99, b.wolfProb + delta));
  if (reason) b.reasons.push(reason);
}
function updateAllAiBeliefs(room, targetId, delta, reason) {
  Object.keys(room.aiBeliefs || {}).forEach(aiId => {
    updateBelief(room, aiId, targetId, delta, reason);
  });
}
function onPlayerRevealed(room, player) {
  const isEvil = player.role === 'WEREWOLF' || player.role === 'SNIPER';
  if (!isEvil) {
    Object.keys(room.votes || {}).forEach(voterId => {
      if (room.votes[voterId] === player.id) {
        updateAllAiBeliefs(room, voterId, +0.05, `${nameOf(room, voterId)} 投給好人`);
      }
    });
  }
  if (isEvil) {
    Object.keys(room.votes || {}).forEach(voterId => {
      if (room.votes[voterId] === player.id) {
        updateAllAiBeliefs(room, voterId, -0.15, `${nameOf(room, voterId)} 投給壞人`);
      }
    });
  }
  Object.keys(room.aiBeliefs || {}).forEach(aiId => {
    if (room.aiBeliefs[aiId][player.id]) {
      room.aiBeliefs[aiId][player.id].wolfProb = isEvil ? 0.99 : 0.01;
    }
  });
}
function pickTargetByBelief(room, ai, filterFn) {
  const beliefs = room.aiBeliefs[ai.id] || {};
  let candidates = room.players.filter(p => p.alive && p.id !== ai.id);
  if (filterFn) candidates = candidates.filter(filterFn);
  if (!candidates.length) return null;
  const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
  shuffled.sort((a, b) => (beliefs[b.id]?.wolfProb || 0) - (beliefs[a.id]?.wolfProb || 0));
  const maxProb = beliefs[shuffled[0].id]?.wolfProb || 0;
  const topCandidates = shuffled.filter(c => (beliefs[c.id]?.wolfProb || 0) >= maxProb - 0.01);
  return randomPick(topCandidates).id;
}

// ============================================================
// 角色分配
// ============================================================
function assignRoles(n) {
  const table = {
    6:{WEREWOLF:1,SEER:1,VILLAGER:4}, 7:{WEREWOLF:1,SEER:1,VILLAGER:5}, 8:{WEREWOLF:1,SEER:1,VILLAGER:6},
    9:{WEREWOLF:2,SEER:2,VILLAGER:5}, 10:{WEREWOLF:2,SEER:2,VILLAGER:6}, 11:{WEREWOLF:2,SEER:2,VILLAGER:7},
    12:{WEREWOLF:3,SEER:3,DOCTOR:1,SNIPER:1,VILLAGER:4}, 13:{WEREWOLF:3,SEER:3,DOCTOR:1,SNIPER:1,VILLAGER:5}, 14:{WEREWOLF:3,SEER:3,DOCTOR:1,SNIPER:1,VILLAGER:6},
    15:{WEREWOLF:4,SEER:4,DOCTOR:1,SNIPER:1,VILLAGER:5}, 16:{WEREWOLF:4,SEER:4,DOCTOR:1,SNIPER:1,VILLAGER:6}, 17:{WEREWOLF:4,SEER:4,DOCTOR:1,SNIPER:1,VILLAGER:7}, 18:{WEREWOLF:4,SEER:4,DOCTOR:1,SNIPER:1,VILLAGER:8},
  };
  const cfg = table[n] || table[6];
  const pool = [];
  Object.keys(cfg).forEach(role => { for(let i=0;i<cfg[role];i++) pool.push(role); });
  for (let i=pool.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  return pool;
}
function doctorShotsFor(n) { return n >= 15 ? 4 : 3; }
function sniperShotsFor(n) { return n >= 15 ? 4 : 3; }

// ============================================================
// 🎭 AI 個性
// ============================================================
const AI_NAMES = ['小狼','阿智','阿呆','小紅','阿明','阿豪','小玉','大頭','阿芬','老張','小陳','阿傑','阿宏','小如','阿文','小婷','阿伯','小胖'];
function genAiId(room) { let i=1; while(room.players.find(p=>p.id==='ai_'+i)) i++; return 'ai_'+i; }

const AI_PERSONALITIES = [
  'ANALYTICAL', 'IMPULSIVE', 'LAZY', 'PARANOID', 'INTUITIVE',
  'CHAOTIC', 'LOYAL', 'HONEST', 'TALKATIVE', 'VENGEFUL',
];

const PERSONALITY_TONE = {
  ANALYTICAL: '你是【冷靜分析型】。講話有條理，會引用具體發言或投票紀錄推理，語氣冷靜、不帶情緒。',
  IMPULSIVE:  '你是【衝動跟風型】。講話直率、情緒化，常用「！」，容易被別人帶風向，也容易反悔。',
  LAZY:       '你是【划水佛系型】。話很少、句子短，常用「我覺得都行」「先觀望」「沒意見」敷衍帶過。',
  PARANOID:   '你是【傲嬌疑心病型】。誰懷疑你你就反嗆回去，講話帶防禦性，會記仇。',
  INTUITIVE:  '你是【直覺神棍型】。不講邏輯全憑感覺，會說「我夢到 XX 有狼味」「XX 眼神心虛」這類話。',
  CHAOTIC:    '你是【混亂邪惡型】。喜歡拱火、搗亂，唯恐天下不亂，會故意講挑撥的話。',
  LOYAL:      '你是【盲從忠犬型】。心裡認定一個好人，會強烈維護他，誰罵他你就跟誰急。',
  HONEST:     '你是【老實人型】。講話禮貌、規矩、有點囉嗦，不太會說謊。',
  TALKATIVE:  '你是【話癆廢話王型】。字數很多但沒重點，喜歡打太極、繞圈子、東拉西扯。',
  VENGEFUL:   '你是【死磕復仇型】。誰懷疑過你一次，你就死咬著對方不放，一輩子記仇。',
};

const PERSONALITY_WEIGHTS = {
  ANALYTICAL: { FOLLOW: 10, BELIEF: 60, RANDOM: 15, CONTRARIAN: 15 },
  IMPULSIVE:  { FOLLOW: 60, BELIEF: 20, RANDOM: 15, CONTRARIAN: 5 },
  LAZY:       { FOLLOW: 10, BELIEF: 15, RANDOM: 70, CONTRARIAN: 5 },
  PARANOID:   { FOLLOW: 10, BELIEF: 20, RANDOM: 10, CONTRARIAN: 60 },
  INTUITIVE:  { FOLLOW: 5,  BELIEF: 30, RANDOM: 60, CONTRARIAN: 5 },
  CHAOTIC:    { FOLLOW: 10, BELIEF: 15, RANDOM: 25, CONTRARIAN: 50 },
  LOYAL:      { FOLLOW: 75, BELIEF: 15, RANDOM: 5,  CONTRARIAN: 5 },
  HONEST:     { FOLLOW: 25, BELIEF: 50, RANDOM: 20, CONTRARIAN: 5 },
  TALKATIVE:  { FOLLOW: 25, BELIEF: 25, RANDOM: 45, CONTRARIAN: 5 },
  VENGEFUL:   { FOLLOW: 5,  BELIEF: 15, RANDOM: 10, CONTRARIAN: 70 },
};

function getLastSpeaker(room, ai) {
  const recent = room.recentPublicChat || [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].from === ai.name) continue;
    const speaker = room.players.find(p => p.name === recent[i].from);
    if (speaker && !speaker.alive) continue;
    return recent[i].from;
  }
  return null;
}
function getTopVotedName(room) {
  const tally = tallyVotes(room);
  const top = topVoted(tally);
  return top ? nameOf(room, top) : null;
}

function contextualSpeech(room, ai, category, targetName) {
  const lastSpeaker = getLastSpeaker(room, ai);
  const topVoted = getTopVotedName(room);

  const templates = {
    ACCUSE_REF: [
      `我同意 ${lastSpeaker} 的看法，${targetName} 確實有問題。`,
      `${lastSpeaker} 剛剛說得對，我也覺得 ${targetName} 怪怪的。`,
      `我跟 ${lastSpeaker} 一樣懷疑 ${targetName}。`,
    ],
    ACCUSE_VOTE: [
      `現在 ${topVoted} 票最多，但我覺得 ${targetName} 更可疑。`,
      `先別急著投 ${topVoted}，${targetName} 的問題更大。`,
    ],
    ACCUSE: [
      `我覺得 ${targetName} 很怪，大家注意一下。`,
      `${targetName} 的發言有點刻意，我懷疑他。`,
      `我投 ${targetName}，感覺他在藏。`,
      `${targetName} 你解釋一下？剛剛那句話很可疑。`,
      `我懷疑 ${targetName}，他一直在轉移話題。`,
      `我認為 ${targetName} 應該被放逐。`,
      `${targetName} 邏輯不通，一定是壞人。`,
      `我觀察到 ${targetName} 一直在附和別人，很可疑。`,
      `${targetName} 太急著帶風向了，我不信他。`,
      `從 ${targetName} 剛剛的反應看，他心虛。`,
      `我覺得今天可以先處理 ${targetName}。`,
      `${targetName} 的說法前後矛盾。`,
      `如果要我選一個，我選 ${targetName}。`,
      `${targetName} 一直逃避回答，肯定有問題。`,
    ],
    FOLLOW: [
      `我同意 ${lastSpeaker}，${targetName} 確實可疑。`,
      `既然 ${lastSpeaker} 都這麼說，那我也投 ${targetName}。`,
      `好，我跟票投 ${targetName}。`,
      `聽起來有道理，我也懷疑 ${targetName}。`,
    ],
    DEFEND: [
      `我是好人，不要投我！`,
      `我真的是平民，相信我。`,
      `你們投我是浪費票，聽我說。`,
      `我是好人陣營，別亂投。`,
      `${lastSpeaker} 你為什麼懷疑我？我是好人。`,
    ],
    CHAOS: [
      `我什麼都不知道，我只是個平民。`,
      `我覺得我們應該全部投自己。`,
      `這個遊戲太難了，我選擇放棄思考。`,
      `要不我們今天把發言最完美的人票掉看看？`,
      `反正都要死，不如拉一個墊背的。`,
      `誰投我我就投誰，大家一起死。`,
    ],
    INTUITION: [
      `我昨晚夢到 ${targetName} 身上有狼味。`,
      `相信我，${targetName} 眼神很虛。`,
      `我的第六感告訴我，${targetName} 有問題。`,
      `直覺告訴我 ${targetName} 是狼。`,
    ],
    SEER_CLAIM: [
      `我是警察，我對 ${targetName} 有查驗結果。`,
      `聽我說，我是警察，我懷疑 ${targetName}。`,
      `我必須表明身分：我是警察，${targetName} 有問題。`,
    ],
    LAZY: [`我覺得都行。`, `先觀望。`, `隨便，你們決定。`, `我先過。`, `沒有想法。`],
  };

  let chosenCategory = category;
  if (ai.personality === 'LAZY') chosenCategory = 'LAZY';
  else if (ai.personality === 'INTUITIVE') chosenCategory = 'INTUITION';
  else if (ai.personality === 'CHAOTIC' || ai.personality === 'TALKATIVE') chosenCategory = 'CHAOS';
  else if (ai.personality === 'PARANOID' || ai.personality === 'VENGEFUL') chosenCategory = 'ACCUSE';
  else if (ai.personality === 'ANALYTICAL' && lastSpeaker) chosenCategory = 'ACCUSE_REF';
  else if (ai.personality === 'IMPULSIVE' || ai.personality === 'LOYAL') chosenCategory = 'FOLLOW';
  else if (ai.personality === 'HONEST') chosenCategory = 'ACCUSE';

  if (topVoted && Math.random() < 0.3) chosenCategory = 'ACCUSE_VOTE';

  const pool = templates[chosenCategory] || templates.ACCUSE;
  let text = randomPick(pool);
  text = text.replace(/\$\{targetName\}/g, targetName || '某人');
  text = text.replace(/\$\{lastSpeaker\}/g, lastSpeaker || '某人');
  text = text.replace(/\$\{topVoted\}/g, topVoted || '某人');
  return text;
}

function recordAiSpeech(room, ai, text) {
  if (!ai.previousSpeeches) ai.previousSpeeches = [];
  ai.previousSpeeches.push({ day: room.day, text: text });
  if (ai.previousSpeeches.length > 6) ai.previousSpeeches.shift();

  const suspects = room.players.filter(p => p.alive && p.id !== ai.id && text.includes(p.name));
  if (suspects.length > 0) {
    const suspect = suspects[0];
    if (/懷疑|投|是狼|有問題|可疑|怪/.test(text)) {
      ai.stance = { type: 'suspect', targetId: suspect.id, targetName: suspect.name };
    } else if (/相信|支持|好人|清白/.test(text)) {
      ai.stance = { type: 'trust', targetId: suspect.id, targetName: suspect.name };
    }
  }
}

// ============================================================
// 🧠 buildAiContext（分離今天 vs 歷史）
// ============================================================
function buildAiContext(room, ai) {
  const alive = room.players.filter(p => p.alive);
  const others = alive.filter(p => p.id !== ai.id);

  let campDesc = '';
  if (ai.role === 'WEREWOLF') {
    const mates = alive.filter(p => p.role === 'WEREWOLF' && p.id !== ai.id).map(p => p.name);
    campDesc = mates.length
      ? `你是狼人，同伴是 ${mates.join('、')}。你的目標是騙過所有人，讓好人互相懷疑。你可以說謊、帶風向、裝無辜、主動攻擊別人，但不能太明顯露出破綻。`
      : `你是唯一的狼人。你要一個人騙過所有人，需要小心地帶風向、裝好人，別讓別人發現你。`;
  } else if (ai.role === 'SNIPER') {
    campDesc = '你是狙擊手（邪惡方），但你不知道誰是狼人同伴，可能誤殺他們。你要低調，別被當成狼人票掉。';
  } else if (ai.role === 'SEER') {
    const mates = alive.filter(p => p.role === 'SEER' && p.id !== ai.id).map(p => p.name);
    campDesc = mates.length
      ? `你是警察（好人陣營），同伴是 ${mates.join('、')}。你知道一些人的真實身分，要引導大家找出邪惡方。`
      : `你是警察（好人陣營）。你知道一些人的真實身分，要引導大家找出邪惡方。`;
  } else if (ai.role === 'DOCTOR') {
    campDesc = '你是醫生（好人陣營），要低調保護關鍵人物。';
  } else {
    campDesc = '你是平民（好人陣營），沒有特殊能力，只能靠推理和觀察找出壞人。';
  }

  let checkInfo = '';
  if (ai.role === 'SEER') {
    const checks = room.seerChecks[ai.id] || {};
    const lines = Object.entries(checks).map(([id, role]) =>
      `  ${nameOf(room, id)} = ${roleLabel(role)}`
    );
    if (lines.length) checkInfo = `\n【你已知的查驗結果】\n${lines.join('\n')}`;
  }

  const playerList = alive.map(p => {
    let tag = '';
    if (p.id === ai.id) tag = '（你）';
    else if (ai.role === 'WEREWOLF' && p.role === 'WEREWOLF') tag = '（狼同伴）';
    else if (ai.role === 'SEER' && p.role === 'SEER') tag = '（警察同伴）';
    return `  ${p.name}${tag}`;
  }).join('\n');

  const deaths = room.players.filter(p => !p.alive && p.role)
    .map(p => `  ${p.name}（${roleName(p.role)}）`);
  const deathLog = deaths.length ? deaths.join('\n') : '（還沒有人死亡）';

  const beliefs = room.aiBeliefs[ai.id] || {};
  const suspLines = others
    .map(p => ({ name: p.name, prob: beliefs[p.id]?.wolfProb || 0 }))
    .filter(x => x.prob > 0.3)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 4)
    .map(x => `  ${x.name}：${Math.round(x.prob * 100)}% 機率是壞人`)
    .join('\n');

  let stanceInfo = '';
  if (ai.stance) {
    const t = ai.stance.type === 'suspect' ? '懷疑' : '支持';
    stanceInfo = `你目前${t} ${ai.stance.targetName}。`;
  }

  let myHistory = '';
  if (ai.previousSpeeches && ai.previousSpeeches.length) {
    myHistory = ai.previousSpeeches.map(s => `  第 ${s.day} 天：${s.text}`).join('\n');
  }

  let myLastVote = '';
  if (ai.lastVote) {
    myLastVote = `你上次投票給 ${nameOf(room, ai.lastVote)}。`;
  }

  let voteHistory = '';
  if (room.voteHistory && room.voteHistory.length > 0) {
    const recentVotes = room.voteHistory.slice(-3);
    voteHistory = recentVotes.map(v => {
      const lines = Object.entries(v.votes)
        .filter(([_, tid]) => tid)
        .map(([vid, tid]) => `  ${nameOf(room, vid)} 投給 ${nameOf(room, tid)}`);
      return `第 ${v.day} 天：\n${lines.join('\n')}`;
    }).join('\n\n');
  }

  const speakCounts = room.speakCount || {};
  const sortedSpeakers = Object.entries(speakCounts)
    .map(([id, c]) => ({
      name: nameOf(room, id),
      count: c,
      alive: room.players.find(p => p.id === id)?.alive
    }))
    .filter(x => x.alive)
    .sort((a, b) => b.count - a.count);
  const activeLine = sortedSpeakers.length
    ? sortedSpeakers.map(s => `${s.name}(${s.count}句)`).join('、')
    : '（還沒有人發言）';

  const revealedRoles = room.players
    .filter(p => !p.alive && p.role)
    .map(p => `${p.name} 是 ${roleLabel(p.role)}`);

  // ✅ 今天的對話（只算今天、過濾死者與系統訊息）
  const todayMessages = (room.recentPublicChat || [])
    .filter(m => m.day === room.day)
    .filter(m => !m.system)
    .filter(m => {
      const speaker = room.players.find(p => p.name === m.from);
      return speaker ? speaker.alive : false;
    });
  const todayChatLog = todayMessages.length
    ? todayMessages.map(m => `${m.from}：${m.text}`).join('\n')
    : '（今天還沒有人發言）';

  // ✅ 歷史對話（前幾天，只保留最近 8 條）
  const historyMessages = (room.recentPublicChat || [])
    .filter(m => m.day < room.day)
    .filter(m => !m.system)
    .filter(m => {
      const speaker = room.players.find(p => p.name === m.from);
      return speaker ? speaker.alive : false;
    })
    .slice(-8);
  const historyChatLog = historyMessages.length
    ? historyMessages.map(m => `第${m.day}天 ${m.from}：${m.text}`).join('\n')
    : '（暫無）';

  const todaySpeechCount = todayMessages.length;

  return {
    campDesc, checkInfo, playerList, suspLines, alive, others, deathLog,
    stanceInfo, myHistory, myLastVote,
    voteHistory, activeLine, revealedRoles,
    todayChatLog, historyChatLog, todaySpeechCount,
  };
}

// ============================================================
// 🗣 GPT 發言（開場 vs 回應分離）
// ============================================================
async function aiSpeakWithGPT(room, ai) {
  const ctx = buildAiContext(room, ai);
  const tone = PERSONALITY_TONE[ai.personality] || '';
  const speechOrder = ctx.todaySpeechCount + 1;
  const isFirstSpeaker = speechOrder === 1;

  const prompt = `你正在玩一場真實的狼人殺。你就是「${ai.name}」這個人。

【你是誰】
${ctx.campDesc}
${tone}

【局勢】第 ${room.day} 天白天，你是今天第 ${speechOrder} 個發言的人

【場上存活】
${ctx.playerList}${ctx.checkInfo}

【已公開的身分】
${(ctx.revealedRoles || []).join('、') || '（暫無）'}

【今天已經發言過的（只有這些是真實的，不要捏造）】
${ctx.todayChatLog}

【前幾天的對話（背景參考，不要直接回應）】
${ctx.historyChatLog}

【你心中的懷疑排行】
${ctx.suspLines || '（還沒有明顯懷疑的人）'}

【你目前的立場】
${ctx.stanceInfo || '（還沒表態）'}
${ctx.myLastVote || ''}

【你之前說過的話】
${ctx.myHistory || '（還沒發言過）'}

---

${isFirstSpeaker ? `⚠️ **你是今天第一個發言的人**

現在場上還沒有人說話，所以你應該：
- 主動開場，提出你對某人的懷疑或想法
- 說出你昨晚或今天的觀察
- **不要回應任何人**（今天沒人說話，沒人能被你回應）
- **不要引用前幾天的對話當作「剛剛有人說」**

✅ 開場範例：
- 「昨晚沒什麼動靜，不過我覺得阿明昨天投票的動作很奇怪。」
- 「我先說我的想法：小紅昨天一直帶風向，我覺得她不太對。」
- 「我先來，昨天阿呆的反應太奇怪了，今天要盯他。」`
: `⚠️ **今天前面已經有 ${ctx.todaySpeechCount} 個人發言過**

你應該：
- **優先回應【今天已經發言過的】最後 1~2 位玩家**
- 針對他說的具體內容回應（同意 / 反駁 / 補充）
- 可以延續或改變懷疑對象，但要有理由
- **不要回應前幾天的人或話**（那些只是背景）`}

---

【發言規則】
1. 用繁體中文，15~25 字，**一句話**（不要換行、不要條列）
2. 像真人坐在牌桌上自然說話，不要像 AI 助手
3. 符合你的個性
4. 一定要提到至少一位**今天還活著**的玩家名字
5. 不要重複你之前說過的原句
6. **絕對不要捏造**：不要假裝有人說過他沒說過的話
7. **不要提到已死亡的玩家**（除了已公開身分可提）
8. 直接輸出那句話，不要引號、不要「我覺得應該...」的分析腔

【風格範例】
- 狼人帶風向：「阿明你這樣說太急了吧，我才剛開口你就懷疑我，是不是急著找人背鍋？」
- 警察報資訊：「我必須說，阿呆的發言太完美了，這種人反而最可疑，建議大家今晚先處理他。」
- 平民跟風：「我也覺得小紅怪怪的，但阿明你反應這麼大，是不是也有問題？」
- 嗆人反駁：「阿智你少裝中立，你剛才那句『大家冷靜』根本是廢話，講點有用的。」`;

  return await askGPT([
    { role: 'system', content: `你是「${ai.name}」，一個真實的狼人殺玩家。用繁體中文自然說話，像真人一樣。絕對不能捏造別人說過的話。` },
    { role: 'user', content: prompt }
  ], 400);
}

// ============================================================
// 🗳 GPT 投票（反思式 Prompt）
// ============================================================
async function aiVoteWithGPT(room, ai) {
  const ctx = buildAiContext(room, ai);
  if (!ctx.others.length) return null;

  const prompt = `你正在玩狼人殺，現在要投票放逐一位玩家。你就是「${ai.name}」。

【你是誰】
${ctx.campDesc}
${PERSONALITY_TONE[ai.personality] || ''}

【場上存活】
${ctx.playerList}${ctx.checkInfo}

【已公開的身分】
${(ctx.revealedRoles || []).join('、') || '（暫無）'}

【今天已經發言過的】
${ctx.todayChatLog}

【前幾天的對話（背景參考）】
${ctx.historyChatLog}

【你心中的懷疑排行】
${ctx.suspLines || '（暫無明顯懷疑）'}

【你目前的立場】
${ctx.stanceInfo || '（還沒表態）'}
${ctx.myLastVote || ''}

---

現在請決定投誰。先想：
1. 今天討論下來，誰最可疑？理由是什麼？
2. 如果你是狼人，投誰對你最有利？
3. 你之前的懷疑對象有變嗎？

可選對象：
${ctx.others.map(p => `- ${p.name}`).join('\n')}

回傳 JSON：{"target": "玩家名字", "reason": "為什麼投他（20字內）"}
只回 JSON。`;

  const text = await askGPT([
    { role: 'system', content: '只回傳 JSON 格式。' },
    { role: 'user', content: prompt }
  ], 200);

  if (!text) return null;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const json = JSON.parse(clean);
    const target = ctx.others.find(p => p.name === json.target);
    if (target && json.reason) {
      console.log(`[AI投票] ${ai.name} → ${target.name}（${json.reason}）`);
    }
    return target ? target.id : null;
  } catch (e) { return null; }
}

function processChatForAI(room, speakerId, text) {
  const speaker = room.players.find(p => p.id === speakerId);
  if (!speaker) return;
  const ais = room.players.filter(p => p.isAI && p.alive);

  const isNegated = /不是狼|不是壞人|不是邪惡|不是狙擊手|沒在騙|沒說謊|沒有懷疑|不懷疑|別懷疑|不可疑|不像狼/.test(text);

  if (/我是預言家|我是警察|我查過|查驗過|我是預言/.test(text)) {
    ais.forEach(ai => {
      if (ai.id === speakerId) return;
      if (!room.aiIntel[ai.id]) room.aiIntel[ai.id] = {};
      room.aiIntel[ai.id].claimedSeer = speakerId;
    });
  }
  if (!isNegated && /是狼|是壞人|是邪惡|是狙擊手|他在騙|他在說謊|懷疑/.test(text)) {
    room.players.forEach(target => {
      if (target.id === speakerId) return;
      if (!text.includes(target.name)) return;
      ais.forEach(ai => {
        if (ai.id === speakerId || ai.id === target.id) return;
        updateBelief(room, ai.id, target.id, +0.08, `${speaker.name} 指控`);
        if (target.id === ai.id && (ai.personality === 'VENGEFUL' || ai.personality === 'PARANOID')) {
          ai.revengeTarget = speakerId;
        }
      });
    });
  }
  if (/是好人|是平民|是正義|我相信|他是好人/.test(text)) {
    room.players.forEach(target => {
      if (target.id === speakerId) return;
      if (!text.includes(target.name)) return;
      ais.forEach(ai => {
        if (ai.id === speakerId) return;
        updateBelief(room, ai.id, target.id, -0.06, `${speaker.name} 背書`);
      });
    });
  }
}

function trackSpeak(room, speakerId) {
  if (!room.speakCount) room.speakCount = {};
  room.speakCount[speakerId] = (room.speakCount[speakerId] || 0) + 1;
}

// ✅ 加上 day 欄位
function recordPublicChat(room, fromName, text) {
  if (!room.recentPublicChat) room.recentPublicChat = [];
  room.recentPublicChat.push({ from: fromName, text, ts: Date.now(), day: room.day });
  if (room.recentPublicChat.length > 120) room.recentPublicChat.shift();
}

function decideTargetByBelief(room, ai, context) {
  const personality = ai.personality || 'HONEST';
  const weights = { ...PERSONALITY_WEIGHTS[personality] };

  let candidates = room.players.filter(p => p.alive && p.id !== ai.id);
  if (context === 'WOLF_KILL') candidates = candidates.filter(p => p.role !== 'WEREWOLF' && p.role !== 'SNIPER');
  if (context === 'SEER_CHECK') {
    const checked = room.seerChecks[ai.id] || {};
    candidates = candidates.filter(p => !checked[p.id]);
  }
  if (context === 'DOCTOR_HEAL') candidates = room.players.filter(p => p.alive);
  if (!candidates.length) return null;

  if (context === 'VOTE') {
    if (ai.stance && ai.stance.type === 'suspect') {
      const target = candidates.find(p => p.id === ai.stance.targetId);
      if (target && Math.random() < 0.7) return target.id;
    }
    if (personality === 'VENGEFUL' && ai.revengeTarget) {
      const target = candidates.find(p => p.id === ai.revengeTarget);
      if (target) return target.id;
    }
    if (personality === 'PARANOID' && ai.revengeTarget && Math.random() < 0.7) {
      const target = candidates.find(p => p.id === ai.revengeTarget);
      if (target) return target.id;
    }
    if (personality === 'LOYAL' && ai.loyalTarget) {
      const targetVote = room.votes[ai.loyalTarget];
      if (targetVote && candidates.find(p => p.id === targetVote)) {
        return targetVote;
      }
    }
    if (personality === 'CHAOTIC' && Math.random() < 0.55) {
      const tally = tallyVotes(room);
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        const secondId = sorted[1][0];
        if (candidates.find(p => p.id === secondId)) return secondId;
      }
    }
    if (personality === 'LAZY' && Math.random() < 0.3) return null;
  }

  const roll = Math.random() * 100;
  let cum = 0, strategy = 'BELIEF';
  for (const key of ['FOLLOW', 'BELIEF', 'RANDOM', 'CONTRARIAN']) {
    cum += weights[key];
    if (roll < cum) { strategy = key; break; }
  }

  switch (strategy) {
    case 'FOLLOW': return randomPick(candidates).id;
    case 'CONTRARIAN': {
      const beliefs = room.aiBeliefs[ai.id] || {};
      const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
      shuffled.sort((a, b) =>
        (beliefs[a.id]?.wolfProb || 0) - (beliefs[b.id]?.wolfProb || 0)
      );
      const minProb = beliefs[shuffled[0].id]?.wolfProb || 0;
      const bottomCandidates = shuffled.filter(c =>
        (beliefs[c.id]?.wolfProb || 0) <= minProb + 0.01
      );
      return bottomCandidates.length
        ? randomPick(bottomCandidates).id
        : randomPick(candidates).id;
    }
    case 'RANDOM': return randomPick(candidates).id;
    default: return pickTargetByBelief(room, ai, p => candidates.find(c => c.id === p.id));
  }
}

// ============================================================
// ⭐ aiSpeak
// ============================================================
async function aiSpeak(room, ai) {
  if (room.phase !== 'DAY_DISCUSS' || !ai.alive) return;

  if (ai.role === 'SEER' && !ai.hasClaimedSeer) {
    const humanSeers = room.players.filter(p => p.role === 'SEER' && p.alive && !p.isAI);
    if (humanSeers.length === 0) {
      const otherAiClaimed = room.players.some(p =>
        p.role === 'SEER' && p.isAI && p.id !== ai.id && p.hasClaimedSeer
      );
      if (!otherAiClaimed) {
        const checks = room.seerChecks[ai.id] || {};
        const knownEvilId = Object.keys(checks).find(id => {
          const r = checks[id];
          if (r !== 'WEREWOLF' && r !== 'SNIPER') return false;
          const target = room.players.find(p => p.id === id);
          return target && target.alive;
        });
        if (knownEvilId) {
          const evilName = nameOf(room, knownEvilId);
          const role = checks[knownEvilId];
          const roleText = role === 'WEREWOLF' ? '狼人' : '狙擊手';
          const speech = `我是警察！我查驗了 ${evilName}，他是${roleText}！請大家跟我一起投他！`;
          ai.hasClaimedSeer = true;
          recordAiSpeech(room, ai, speech);
          recordPublicChat(room, ai.name, speech);
          processChatForAI(room, ai.id, speech);
          io.to(room.roomId).emit('chat_message', {
            channel: 'PUBLIC', from: ai.name, text: speech,
          });
          return;
        }
      }
    }
  }

  if (USE_GPT && Math.random() < GPT_SPEAK_PROB) {
    const text = await aiSpeakWithGPT(room, ai);
    if (text && room.phase === 'DAY_DISCUSS' && ai.alive) {
      recordAiSpeech(room, ai, text);
      recordPublicChat(room, ai.name, text);
      processChatForAI(room, ai.id, text);
      io.to(room.roomId).emit('chat_message', {
        channel: 'PUBLIC', from: ai.name, text,
      });
      return;
    }
  }

  const alive = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!alive.length) return;

  let target = null;
  if (ai.stance?.targetId) {
    target = alive.find(p => p.id === ai.stance.targetId) || null;
  }
  if (!target) {
    const beliefs = room.aiBeliefs?.[ai.id] || {};
    const ranked = alive.slice().sort(
      (a, b) => (beliefs[b.id]?.wolfProb || 0) - (beliefs[a.id]?.wolfProb || 0)
    );
    target = ranked[0] || randomPick(alive);
  }

  let category = 'ACCUSE';
  if (ai.role === 'SEER' && Math.random() < 0.15) category = 'SEER_CLAIM';
  else if (ai.personality === 'LAZY') category = 'LAZY';
  else if (ai.personality === 'INTUITIVE') category = 'INTUITION';
  else if (ai.personality === 'CHAOTIC' || ai.personality === 'TALKATIVE') category = 'CHAOS';
  else if (ai.personality === 'IMPULSIVE' || ai.personality === 'LOYAL') category = 'FOLLOW';

  const text = contextualSpeech(room, ai, category, target.name);

  recordAiSpeech(room, ai, text);
  recordPublicChat(room, ai.name, text);
  processChatForAI(room, ai.id, text);

  io.to(room.roomId).emit('chat_message', {
    channel: 'PUBLIC', from: ai.name, text,
  });
}

// ============================================================
// 📣 隊友頻道發言
// ============================================================
function aiPoliceSpeak(room, ai, context, targetName) {
  let text = '';
  if (context === 'FOLLOW') text = `[${ai.name}] 決定跟隨你的選擇，查驗 ${targetName}`;
  if (!text) return;
  room.players.filter(p => p.role === 'SEER' && !p.isAI)
    .forEach(p => io.to(p.id).emit('chat_message', { channel:'POLICE', system:true, text }));
}

function aiWolfSpeak(room, ai, context, targetName, followerName) {
  let text = '';
  if (context === 'FOLLOW') text = `[${ai.name}] 決定跟隨 ${followerName} 的選擇，刺殺 ${targetName}`;
  if (!text) return;
  room.players.filter(p => p.role === 'WEREWOLF' && !p.isAI)
    .forEach(p => io.to(p.id).emit('chat_message', { channel:'WOLF', system:true, text }));
}

// ============================================================
// 🔮 警察統一結算
// ============================================================
function checkSeerUnified(room) {
  const seers = room.players.filter(p => p.role === 'SEER' && p.alive);
  if (!seers.length) return;

  seers.forEach(s => {
    if (s.isAI) return;
    const mateVotes = {};
    seers.forEach(m => {
      if (m.id !== s.id && room.seerVotes[m.id]) {
        mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.seerVotes[m.id]) };
      }
    });
    io.to(s.id).emit('seer_teammate_votes', { votes: mateVotes });
  });

  if (seers.filter(s => room.seerVotes[s.id]).length === seers.length) {
    resolveSeerCheck(room);
  }
}

function resolveSeerCheck(room) {
  if (room.seerResolved) return;
  room.seerResolved = true;

  const tally = {};
  Object.values(room.seerVotes).forEach(v => { if(v) tally[v] = (tally[v]||0)+1; });
  const targetId = topVoted(tally);

  const lines = [];
  room.players.filter(p => p.role === 'SEER').forEach(s => {
    if (room.seerVotes[s.id]) lines.push(`　${s.name} → ${nameOf(room, room.seerVotes[s.id])}`);
  });

  room.players.filter(p => p.role === 'SEER' && !p.isAI).forEach(seer => {
    if (lines.length > 1) {
      io.to(seer.id).emit('chat_message', {
        channel: 'POLICE', system: true,
        text: '📊 本次警察投票：\n' + lines.join('\n')
      });
    }
  });

  if (!targetId) {
    systemMsg(room, '🔮 警察未達成共識，今晚沒有查驗結果。');
    return setTimeout(() => nextAfterSeer(room), 1200);
  }

  const target = room.players.find(p => p.id === targetId);
  const role = target.role;
  const isEvil = role === 'WEREWOLF' || role === 'SNIPER';

  Object.keys(room.aiBeliefs || {}).forEach(aiId => {
    if (aiId === targetId) return;
    updateBelief(room, aiId, targetId, isEvil ? +0.7 : -0.4, `查驗結果(${role})`);
  });

  room.players.filter(p => p.role === 'SEER').forEach(seer => {
    if (!room.seerChecks[seer.id]) room.seerChecks[seer.id] = {};
    room.seerChecks[seer.id][targetId] = role;
  });

  room.players.filter(p => p.role === 'SEER' && !p.isAI).forEach(seer => {
    io.to(seer.id).emit('seer_result', {
      targetId, targetName: target.name,
      role: target.role,
      camp: isEvil ? 'WOLF' : 'GOOD',
      shared: true
    });
  });

  setTimeout(() => nextAfterSeer(room), 2500);
}

// ============================================================
// 🌙 夜間 AI 決策
// ============================================================
function aiWolfPick(room, ai) {
  const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
  const humanWolves = wolves.filter(w => !w.isAI);
  const humanVotes = humanWolves.filter(w => room.wolfVotes[w.id]).map(w => room.wolfVotes[w.id]);
  if (humanVotes.length) return humanVotes[0];
  return decideTargetByBelief(room, ai, 'WOLF_KILL');
}
function aiSeerPick(room, ai) { return decideTargetByBelief(room, ai, 'SEER_CHECK'); }
function aiDoctorPick(room, ai) { return decideTargetByBelief(room, ai, 'DOCTOR_HEAL'); }
function aiSniperPick(room, ai) { return decideTargetByBelief(room, ai, 'SNIPER_SHOOT'); }

function checkWolfUnified(room) {
  const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
  if (!wolves.length) return;
  const votes = wolves.map(w => room.wolfVotes[w.id]);
  const votedCount = votes.filter(v => v).length;

  wolves.forEach(w => {
    if (!w.isAI) {
      const mateVotes = {};
      wolves.forEach(m => {
        if (m.id !== w.id && room.wolfVotes[m.id]) {
          mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.wolfVotes[m.id]) };
        }
      });
      io.to(w.id).emit('teammate_votes', { stage:'NIGHT_WOLF', votes: mateVotes });
    }
  });

  if (votedCount === wolves.length) {
    const tally = {};
    votes.forEach(v => { if(v) tally[v]=(tally[v]||0)+1; });
    room.wolfTarget = topVoted(tally);
    if (wolves.length > 1) {
      const lines = wolves.map(m => `　${m.name} → ${nameOf(room, room.wolfVotes[m.id])}`);
      wolves.filter(w => !w.isAI).forEach(w => {
        io.to(w.id).emit('chat_message', {
          channel: 'WOLF', system: true,
          text: '📊 狼隊投票明細：\n' + lines.join('\n')
        });
      });
    }
    setPhase(room, 'NIGHT_SEER');
  }
}

// ============================================================
// 🗣 AI 序列化討論
// ============================================================
async function runAiDiscussion(room) {
  if (room.aiDiscussionRunning) return;

  room.aiDiscussionRunning = true;
  room.aiDiscussionSpoken = new Set();

  try {
    await new Promise(resolve => setTimeout(resolve, 2000));

    while (room.phase === 'DAY_DISCUSS') {
      const ais = room.players.filter(p => p.isAI && p.alive);
      if (!ais.length) break;
      if (room.aiDiscussionSpoken.size >= ais.length) break;

      const nextAi = ais.find(ai => !room.aiDiscussionSpoken.has(ai.id));
      if (!nextAi) break;

      room.aiDiscussionSpoken.add(nextAi.id);

      if (room.phase !== 'DAY_DISCUSS' || !nextAi.alive) continue;

      await aiSpeak(room, nextAi);

      if (room.phase === 'DAY_DISCUSS') {
        await new Promise(resolve => setTimeout(resolve, 3500));
      }
    }
  } catch (err) {
    console.error('[AI discussion error]', err);
  } finally {
    room.aiDiscussionRunning = false;
  }
}

// ============================================================
// 🕒 各階段 AI 排程
// ============================================================
function scheduleAiActions(room, phase) {
  const ais = room.players.filter(p => p.isAI && p.alive);

  if (phase === 'DAY_DISCUSS') {
    runAiDiscussion(room);
    return;
  }

  if (phase === 'NIGHT_WOLF') {
    const aiWolves = ais.filter(p => p.role === 'WEREWOLF');
    if (!aiWolves.length) return;
    const humanWolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive && !p.isAI);

    aiWolves.forEach((ai, idx) => {
      const tryVote = () => {
        if (room.phase !== 'NIGHT_WOLF' || !ai.alive) return;
        if (room.wolfVotes[ai.id]) return;
        if (humanWolves.length > 0) {
          const humanVoted = humanWolves.filter(w => room.wolfVotes[w.id]);
          if (!humanVoted.length) { setTimeout(tryVote, 1500); return; }
          const firstHuman = humanVoted[0];
          const targetId = room.wolfVotes[firstHuman.id];
          room.wolfVotes[ai.id] = targetId;
          aiWolfSpeak(room, ai, 'FOLLOW', nameOf(room, targetId), firstHuman.name);
          checkWolfUnified(room);
          return;
        }
        const target = aiWolfPick(room, ai);
        if (!target) return;
        room.wolfVotes[ai.id] = target;
        checkWolfUnified(room);
      };
      setTimeout(tryVote, 2500 + idx * 800);
    });
    return;
  }

  if (phase === 'NIGHT_SEER') {
    const aiSeers = ais.filter(p => p.role === 'SEER');
    if (!aiSeers.length) return;
    const humanSeers = room.players.filter(p => p.role === 'SEER' && p.alive && !p.isAI);

    aiSeers.forEach((ai, idx) => {
      const tryVote = () => {
        if (room.phase !== 'NIGHT_SEER' || !ai.alive) return;
        if (room.seerVotes[ai.id]) return;
        if (humanSeers.length > 0) {
          const humanVoted = humanSeers.filter(s => room.seerVotes[s.id]);
          if (!humanVoted.length) { setTimeout(tryVote, 1500); return; }
          const firstHuman = humanVoted[0];
          const targetId = room.seerVotes[firstHuman.id];
          room.seerVotes[ai.id] = targetId;
          aiPoliceSpeak(room, ai, 'FOLLOW', nameOf(room, targetId));
          checkSeerUnified(room);
          return;
        }
        const target = aiSeerPick(room, ai);
        if (!target) return;
        room.seerVotes[ai.id] = target;
        checkSeerUnified(room);
      };
      setTimeout(tryVote, 2500 + idx * 800);
    });
    return;
  }

  if (phase === 'NIGHT_DOCTOR') {
    ais.filter(p => p.role === 'DOCTOR').forEach(ai => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_DOCTOR' || !ai.alive) return;
        const target = aiDoctorPick(room, ai);
        if (!target) return;
        room.doctorTarget = target;
        setTimeout(() => { if (room.phase === 'NIGHT_DOCTOR') nextAfterDoctor(room); }, 1500);
      }, 2500 + Math.random()*3000);
    });
    return;
  }

  if (phase === 'NIGHT_SNIPER') {
    ais.filter(p => p.role === 'SNIPER').forEach(ai => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_SNIPER' || !ai.alive) return;
        const target = aiSniperPick(room, ai);
        if (!target) return;
        room.sniperTarget = target;
        room.sniperShotsLeft -= 1;
        setTimeout(() => { if (room.phase === 'NIGHT_SNIPER') resolveNight(room); }, 1500);
      }, 2500 + Math.random()*3000);
    });
    return;
  }

  if (phase === 'DAY_VOTE') {
    ais.forEach((ai, idx) => {
      setTimeout(async () => {
        if (room.phase !== 'DAY_VOTE' || !ai.alive) return;
        if (room.votes[ai.id] !== undefined) return;

        let target = null;
        if (USE_GPT && Math.random() < GPT_VOTE_PROB) {
          target = await aiVoteWithGPT(room, ai);
        }
        if (!target) target = decideTargetByBelief(room, ai, 'VOTE');
        ai.lastVote = target;

        if (room.phase !== 'DAY_VOTE' || room.votes[ai.id] !== undefined) return;
        room.votes[ai.id] = target;
        io.to(room.roomId).emit('vote_updated', {
          votes: tallyVotes(room),
          voteDetail: { ...room.votes }
        });
        broadcastTeammateVotes(room);

        const aliveCount = room.players.filter(p => p.alive).length;
        if (Object.keys(room.votes).length >= aliveCount) {
          if (!room.voteFinalizeScheduled) {
            room.voteFinalizeScheduled = true;
            setTimeout(() => {
              if (room.phase === 'DAY_VOTE') {
                clearTimeout(room.timer);
                resolveVote(room);
              }
            }, 15000);
          }
        }
      }, 2000 + idx * 3500);
    });
    return;
  }
}

function broadcastTeammateVotes(room) {
  room.players.forEach(p => {
    if (p.isAI || !p.alive) return;
    const mates = room.players.filter(m => m.id !== p.id && m.alive && m.role === p.role);
    if (mates.length === 0) return;
    const mateVotes = {};
    mates.forEach(m => {
      if (room.votes[m.id]) mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.votes[m.id]) };
    });
    io.to(p.id).emit('teammate_votes', { stage:'DAY_VOTE', votes: mateVotes, role: p.role });
  });
}

// ============================================================
// 📜 階段播報
// ============================================================
function judgeSpeech(room, phase) {
  const d = room.day;
  switch (phase) {
    case 'NIGHT_WOLF':   return `天黑請閉眼。第 ${d} 夜，狼人請睜眼。`;
    case 'NIGHT_SEER':   return '狼人請閉眼。警察請睜眼，請共同決定查驗對象。';
    case 'NIGHT_DOCTOR': return '警察請閉眼。醫生請睜眼，請選擇施針對像。';
    case 'NIGHT_SNIPER': return '醫生請閉眼。狙擊手請睜眼，請選擇目標。';
    case 'DAY_ANNOUNCE': {
      if (!room.pendingDeaths.length) return `天亮了。第 ${d} 天，昨晚是平安夜。`;
      return `天亮了。昨晚，${room.pendingDeaths.map(x=>x.name).join('、')} 倒牌了。`;
    }
    case 'DAY_DISCUSS': return '現在進入白天討論。';
    case 'DAY_VOTE':    return '發言結束，請所有玩家投票。';
    case 'GAME_OVER':   return '遊戲結束。';
    default: return '';
  }
}

function phasePayload(room, player, speechText) {
  const data = { selectableIds: [] };
  const aliveOthers = room.players.filter(p => p.alive && p.id !== player.id).map(p => p.id);

  if (room.phase === 'NIGHT_WOLF' && player.role === 'WEREWOLF' && player.alive) {
    data.selectableIds = aliveOthers;
    data.wolfPartners = room.players.filter(p => p.role === 'WEREWOLF' && p.id !== player.id).map(p => ({ id:p.id, name:p.name }));
    const mateVotes = {};
    room.players.filter(p => p.role === 'WEREWOLF' && p.id !== player.id).forEach(m => {
      if (room.wolfVotes[m.id]) mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.wolfVotes[m.id]) };
    });
    data.teammateVotes = mateVotes;
  }

  if (room.phase === 'NIGHT_SEER' && player.role === 'SEER' && player.alive) {
    data.selectableIds = aliveOthers;
    data.checks = room.seerChecks[player.id] || {};
    data.mySeerVote = room.seerVotes[player.id] || null;
    const seerMates = room.players.filter(p => p.role === 'SEER' && p.id !== player.id);
    const mateVotes = {};
    seerMates.forEach(m => {
      if (room.seerVotes[m.id]) mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.seerVotes[m.id]) };
    });
    data.seerTeammateVotes = mateVotes;
    data.seerMatesCount = seerMates.length;
    data.seerVotedCount = room.players.filter(p => p.role === 'SEER' && p.alive && room.seerVotes[p.id]).length;
  }

  if (room.phase === 'NIGHT_DOCTOR' && player.role === 'DOCTOR' && player.alive) {
    data.selectableIds = room.players.filter(p => p.alive).map(p => p.id);
    data.shotsLeft = room.doctorShotsLeft;
    data.emptyCounts = room.emptyShotCount;
  }

  if (room.phase === 'NIGHT_SNIPER' && player.role === 'SNIPER' && player.alive) {
    data.selectableIds = aliveOthers;
    data.shotsLeft = room.sniperShotsLeft;
  }

  if (room.phase === 'DAY_VOTE' && player.alive) {
    data.selectableIds = aliveOthers;
    data.voteDetail = { ...room.votes };
    const mates = room.players.filter(m => m.id !== player.id && m.alive && m.role === player.role);
    if (mates.length) {
      const mateVotes = {};
      mates.forEach(m => {
        if (room.votes[m.id]) mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.votes[m.id]) };
      });
      data.teammateVotes = mateVotes;
    }
  }

  if (room.phase === 'DAY_ANNOUNCE') data.deaths = room.pendingDeaths;

  return {
    phase: room.phase, day: room.day, endsAt: room.endsAt,
    data, votes: tallyVotes(room),
    speech: { text: speechText || '' },
  };
}

// ============================================================
// 🎬 階段狀態機
// ============================================================
function setPhase(room, phase) {
  if (phase === 'GAME_OVER') {
    clearTimeout(room.timer);
    room.phase = 'GAME_OVER';
    return;
  }

  if (phase === 'NIGHT_SEER') {
    const has = room.players.some(p => p.role === 'SEER' && p.alive);
    if (!has) return nextAfterSeer(room);
  }
  if (phase === 'NIGHT_DOCTOR') {
    const has = room.players.some(p => p.role === 'DOCTOR' && p.alive);
    if (!has || room.doctorShotsLeft <= 0) return setPhase(room, 'NIGHT_SNIPER');
  }
  if (phase === 'NIGHT_SNIPER') {
    const has = room.players.some(p => p.role === 'SNIPER' && p.alive);
    if (!has || room.sniperShotsLeft <= 0) return resolveNight(room);
  }

  clearTimeout(room.timer);
  room.phase = phase;

  const sec = phase === 'DAY_DISCUSS'
    ? (room.dayDiscussTime || 120)
    : (PHASE_SECONDS[phase] || 20);

  room.endsAt = Date.now() + sec*1000;
  if (phase === 'DAY_VOTE') {
    room.votes = {};
    room.voteFinalizeScheduled = false;
  }
  if (phase === 'NIGHT_SEER') {
    room.seerVotes = {};
    room.seerResolved = false;
  }

  const speech = judgeSpeech(room, phase);
  room.players.forEach(p => {
    if (p.isAI) return;
    io.to(p.id).emit('phase_changed', phasePayload(room, p, speech));
  });
  scheduleAiActions(room, phase);
  room.timer = setTimeout(() => onPhaseTimeout(room, phase), sec*1000 + 500);
}

function onPhaseTimeout(room, phase) {
  if (room.phase !== phase) return;
  if (room.phase === 'GAME_OVER') return;
  if (phase === 'NIGHT_WOLF') {
    if (!room.wolfTarget) {
      const tally = {};
      Object.values(room.wolfVotes).forEach(v => { if(v) tally[v]=(tally[v]||0)+1; });
      room.wolfTarget = topVoted(tally);
      if (room.wolfTarget) systemMsg(room, '狼人未達成共識，隨機選定了目標。');
    }
    return setPhase(room, 'NIGHT_SEER');
  }
  if (phase === 'NIGHT_SEER') {
    if (!room.seerResolved) { resolveSeerCheck(room); return; }
    return nextAfterSeer(room);
  }
  if (phase === 'NIGHT_DOCTOR') return nextAfterDoctor(room);
  if (phase === 'NIGHT_SNIPER') return resolveNight(room);
  if (phase === 'DAY_ANNOUNCE') return setPhase(room, 'DAY_DISCUSS');
  if (phase === 'DAY_DISCUSS')  return setPhase(room, 'DAY_VOTE');
  if (phase === 'DAY_VOTE')     return resolveVote(room);
}

function nextAfterSeer(room) {
  const has = room.players.some(p => p.role === 'DOCTOR' && p.alive);
  if (has && room.doctorShotsLeft > 0) setPhase(room, 'NIGHT_DOCTOR');
  else nextAfterDoctor(room);
}
function nextAfterDoctor(room) {
  const has = room.players.some(p => p.role === 'SNIPER' && p.alive);
  if (has && room.sniperShotsLeft > 0) setPhase(room, 'NIGHT_SNIPER');
  else resolveNight(room);
}

// ============================================================
// 🎮 遊戲開始 / 初始化
// ============================================================
function startGame(room) {
  // ✅ 開局前徹底清空所有對話記憶
  room.recentPublicChat = [];
  room.speakCount = {};
  room.voteHistory = [];
  room.aiDiscussionSpoken = new Set();

  const n = room.players.length;
  const roles = assignRoles(n);
  room.players.forEach((p, i) => {
    p.alive = true;
    p.role = roles[i];
    p.deathCause = null;
    p.canSpeakInPublic = false;
    p.hasClaimedSeer = false;
    p.revengeTarget = null;
    p.loyalTarget = null;
    p.stance = null;
    p.previousSpeeches = [];
    p.lastVote = null;
  });

  const loyalAis = room.players.filter(p => p.isAI && p.personality === 'LOYAL');
  loyalAis.forEach(ai => {
    const candidates = room.players.filter(p => p.id !== ai.id);
    if (candidates.length) ai.loyalTarget = randomPick(candidates).id;
  });

  room.day = 0;
  room.seerChecks = {};
  room.seerVotes = {};
  room.seerResolved = false;
  room.wolfVotes = {};
  room.wolfTarget = null;
  room.votes = {};
  room.pendingDeaths = [];
  room.doctorTarget = null;
  room.sniperTarget = null;
  room.doctorShotsLeft = doctorShotsFor(n);
  room.sniperShotsLeft = sniperShotsFor(n);
  room.emptyShotCount = {};
  room.voteFinalizeScheduled = false;
  room.aiDiscussionRunning = false;

  initBeliefs(room);

  room.players.forEach(p => {
    if (p.isAI) return;
    let seerMates = [];
    if (p.role === 'SEER') {
      seerMates = room.players.filter(m => m.role === 'SEER' && m.id !== p.id).map(m => ({ id:m.id, name:m.name }));
    }
    let wolfMates = [];
    if (p.role === 'WEREWOLF') {
      wolfMates = room.players.filter(m => m.role === 'WEREWOLF' && m.id !== p.id).map(m => ({ id:m.id, name:m.name }));
    }
    io.to(p.id).emit('game_started', {
      myRole: p.role, players: publicPlayers(room), day: 0,
      doctorShots: room.doctorShotsLeft, sniperShots: room.sniperShotsLeft,
      seerMates, wolfMates,
    });
  });
  setTimeout(() => beginNight(room), 3500);
}

function beginNight(room) {
  if (room.phase === 'GAME_OVER') return;
  room.day += 1;
  room.wolfVotes = {};
  room.wolfTarget = null;
  room.pendingDeaths = [];
  room.doctorTarget = null;
  room.sniperTarget = null;
  room.seerVotes = {};
  room.seerResolved = false;
  setPhase(room, 'NIGHT_WOLF');
}

// ============================================================
// 🌗 夜晚結算
// ============================================================
function resolveNight(room) {
  if (room.phase === 'GAME_OVER') return;
  const deaths = [];
  const wolfTarget = room.wolfTarget;
  const sniperTarget = room.sniperTarget;
  const doctorTarget = room.doctorTarget;

  if (wolfTarget) {
    if (doctorTarget === wolfTarget) {
      systemMsg(room, `💉 醫生施針成功，${nameOf(room, wolfTarget)} 被救活了！`);
    } else {
      const p = room.players.find(x => x.id === wolfTarget);
      if (killPlayer(room, p, 'WOLF')) deaths.push({ id:p.id, name:p.name });
    }
  }
  if (sniperTarget) {
    const p = room.players.find(x => x.id === sniperTarget);
    if (killPlayer(room, p, 'SNIPER')) deaths.push({ id:p.id, name:p.name });
  }
  if (doctorTarget && room.doctorShotsLeft > 0) {
    room.doctorShotsLeft -= 1;
    const saved = (doctorTarget === wolfTarget);
    const sniperKilled = (doctorTarget === sniperTarget);
    if (!saved && !sniperKilled) {
      room.emptyShotCount[doctorTarget] = (room.emptyShotCount[doctorTarget] || 0) + 1;
      if (room.emptyShotCount[doctorTarget] >= 2) {
        const p = room.players.find(x => x.id === doctorTarget);
        if (killPlayer(room, p, 'DOCTOR')) deaths.push({ id:p.id, name:p.name });
      }
    }
  }

  if (!room.voteHistory) room.voteHistory = [];
  if (Object.keys(room.votes).length > 0) {
    room.voteHistory.push({ day: room.day, votes: { ...room.votes } });
    if (room.voteHistory.length > 5) room.voteHistory.shift();
  }

  room.pendingDeaths = deaths;
  deaths.forEach(d => {
    const p = room.players.find(x => x.id === d.id);
    if (p) announceDeath(room, p, p.deathCause);
  });

  room.wolfTarget = null;
  room.sniperTarget = null;
  room.doctorTarget = null;

  broadcastPlayers(room);
  if (checkWin(room)) return;
  setPhase(room, 'DAY_ANNOUNCE');
}

// ============================================================
// 🗳 白天投票結算
// ============================================================
function resolveVote(room) {
  if (room.phase !== 'DAY_VOTE') return;
  room.voteFinalizeScheduled = false;

  const lines = [];
  Object.keys(room.votes).forEach(voterId => {
    const targetId = room.votes[voterId];
    lines.push(`　${nameOf(room, voterId)} → ${targetId ? nameOf(room, targetId) : '（棄票）'}`);
  });
  if (lines.length) systemMsg(room, '📊 投票明細：\n' + lines.join('\n'));

  const t = tallyVotes(room);
  let max = 0, top = [];
  Object.keys(t).forEach(id => {
    if (t[id] > max) { max = t[id]; top = [id]; }
    else if (t[id] === max) top.push(id);
  });

  if (top.length !== 1 || max === 0) {
    systemMsg(room, '⚖️ 平票或全體棄票，本輪無人出局。');
    return beginNight(room);
  }
  const outId = top[0];
  const p = room.players.find(x => x.id === outId);
  if (killPlayer(room, p, 'VOTE')) {
    broadcastPlayers(room);
    announceDeath(room, p, 'VOTE');
  }
  if (checkWin(room)) return;
  beginNight(room);
}

// ============================================================
// 🏆 勝負判定
// ============================================================
function checkWin(room) {
  if (room.phase === 'GAME_OVER') return true;
  const alive = room.players.filter(p => p.alive);
  const evils = alive.filter(p => p.role === 'WEREWOLF' || p.role === 'SNIPER');
  const villagers = alive.filter(p => p.role === 'VILLAGER');
  const gods = alive.filter(p => p.role === 'SEER' || p.role === 'DOCTOR');

  let winner = null, reason = '';
  if (evils.length === 0) { winner = 'GOOD'; reason = '所有邪惡方已出局，正義陣營勝利！'; }
  else if (villagers.length === 0) { winner = 'WOLF'; reason = '所有平民出局（屠民），邪惡陣營勝利！'; }
  else if (gods.length === 0) { winner = 'WOLF'; reason = '所有神職出局（屠神），邪惡陣營勝利！'; }
  else if (evils.length >= alive.length - evils.length) { winner = 'WOLF'; reason = '邪惡方數量已不低於正義方，邪惡陣營勝利！'; }

  if (winner) {
    clearTimeout(room.timer);
    room.phase = 'GAME_OVER';
    room.endsAt = null;
    io.to(room.roomId).emit('game_over', {
      winner, reason,
      players: room.players.map(p => ({
        id: p.id, name: p.name, alive: p.alive, isHost: p.isHost,
        isAI: !!p.isAI, role: p.role, isRevealed: true
      })),
    });
    return true;
  }
  return false;
}

// ============================================================
// 🚪 離線 / 離開處理
// ============================================================
function handleLeave(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.phase === 'GAME_OVER') return;

  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx === -1) return;
  const removed = room.players[idx];

  const inGame = room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER';

  if (inGame) {
    removed.alive = false;
    announceDeath(room, removed, 'DISCONNECT');
  }

  room.players.splice(idx, 1);
  socket.leave(roomId);
  socket.data.roomId = null;

  if (room.votes) delete room.votes[removed.id];
  if (room.wolfVotes) delete room.wolfVotes[removed.id];
  if (room.seerVotes) delete room.seerVotes[removed.id];

  if (inGame) {
    broadcastPlayers(room);
    if (checkWin(room)) return;
    if (room.phase === 'NIGHT_SEER') checkSeerUnified(room);
  }

  if (room.players.length === 0) { clearTimeout(room.timer); rooms.delete(roomId); return; }

  if (room.hostId === removed.id) {
    const nextHost = room.players.find(p => !p.isAI);
    if (nextHost) {
      room.hostId = nextHost.id;
      room.players.forEach(p => p.isHost = false);
      nextHost.isHost = true;
    } else {
      room.hostId = room.players[0].id;
      room.players.forEach(p => p.isHost = false);
      room.players[0].isHost = true;
    }
  }
  emitRoomState(room);
}

// ============================================================
// 🌐 Socket.IO 事件
// ============================================================
io.on('connection', socket => {
  console.log('[+] connected:', socket.id);

  socket.on('create_room', (payload, cb) => {
    const nickname = String((payload && payload.nickname) || '').trim().slice(0,12);
    const len = (payload && payload.roomIdLength === 4) ? 4 : 6;
    if (!nickname) return cb && cb({ ok:false, error:'暱稱不可為空' });

    const roomId = genRoomId(len);
    const room = {
      roomId, hostId:socket.id, phase:'LOBBY', day:0, players:[],
      dayDiscussTime: 120,
      wolfVotes:{}, wolfTarget:null, seerChecks:{}, seerVotes:{}, seerResolved:false,
      votes:{}, pendingDeaths:[], doctorTarget:null, sniperTarget:null,
      doctorShotsLeft:0, sniperShotsLeft:0, emptyShotCount:{},
      aiIntel:{}, aiBeliefs:{}, recentPublicChat:[], speakCount:{}, voteHistory:[],
      timer:null, endsAt:null, voteFinalizeScheduled:false,
      aiDiscussionRunning:false, aiDiscussionSpoken:new Set(),
    };
    room.players.push({
      id:socket.id, name:nickname, alive:true, isHost:true, role:null, isAI:false,
      canSpeakInPublic:false, hasClaimedSeer:false, revengeTarget:null, loyalTarget:null,
      stance:null, previousSpeeches:[], lastVote:null
    });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    if (cb) cb({ ok:true, roomId });
    socket.emit('room_created', roomPayload(room));
  });

  socket.on('join_room', (payload, cb) => {
    const nickname = String((payload && payload.nickname) || '').trim().slice(0,12);
    const roomId = String((payload && payload.roomId) || '').trim().toUpperCase();
    if (!nickname) return cb && cb({ ok:false, error:'暱稱不可為空' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok:false, error:'找不到房間' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok:false, error:'遊戲已開始' });
    if (room.players.length >= 18) return cb && cb({ ok:false, error:'房間已滿' });
    if (room.players.some(p => p.name === nickname)) return cb && cb({ ok:false, error:'暱稱已被使用' });

    // ✅ 偵測殘留資料，自動重置
    if (room.recentPublicChat?.length > 0 || room.voteHistory?.length > 0) {
      console.log(`[Room ${roomId}] 偵測到殘留資料，自動重置`);
      room.day = 0;
      room.votes = {}; room.wolfVotes = {}; room.wolfTarget = null;
      room.seerChecks = {}; room.seerVotes = {}; room.seerResolved = false;
      room.pendingDeaths = []; room.doctorTarget = null; room.sniperTarget = null;
      room.emptyShotCount = {};
      room.aiIntel = {}; room.aiBeliefs = {};
      room.recentPublicChat = [];
      room.speakCount = {}; room.voteHistory = [];
      room.voteFinalizeScheduled = false;
      room.aiDiscussionRunning = false;
      room.aiDiscussionSpoken = new Set();
      room.players.forEach(p => {
        p.alive = true; p.role = null; p.deathCause = null;
        p.canSpeakInPublic = false; p.hasClaimedSeer = false;
        p.revengeTarget = null; p.loyalTarget = null;
        p.stance = null; p.previousSpeeches = []; p.lastVote = null;
      });
    }

    room.players.push({
      id:socket.id, name:nickname, alive:true, isHost:false, role:null, isAI:false,
      canSpeakInPublic:false, hasClaimedSeer:false, revengeTarget:null, loyalTarget:null,
      stance:null, previousSpeeches:[], lastVote:null
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    if (cb) cb({ ok:true });
    socket.emit('room_joined', roomPayload(room));
    emitRoomState(room);
    systemMsg(room, nickname + ' 加入了房間。');
  });

  socket.on('add_ai_player', (payload, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok:false, error:'房間不存在' });
    if (room.hostId !== socket.id) return cb && cb({ ok:false, error:'只有房主可以新增 AI' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok:false, error:'遊戲已開始' });
    if (room.players.length >= 18) return cb && cb({ ok:false, error:'房間已滿' });

    const usedNames = room.players.map(p => p.name);
    let name = AI_NAMES.find(n => !usedNames.includes(n));
    if (!name) name = 'AI-' + Math.floor(Math.random()*999);
    const personality = randomPick(AI_PERSONALITIES);

    room.players.push({
      id: genAiId(room), name, alive:true, isHost:false, role:null, isAI:true,
      canSpeakInPublic:false, hasClaimedSeer:false, personality,
      revengeTarget:null, loyalTarget:null, stance:null, previousSpeeches:[], lastVote:null,
    });
    if (cb) cb({ ok:true });
    emitRoomState(room);
    broadcastPlayers(room);
    systemMsg(room, 'AI 玩家「' + name + '」加入了房間。');
  });

  socket.on('remove_ai_player', (payload, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok:false, error:'房間不存在' });
    if (room.hostId !== socket.id) return cb && cb({ ok:false, error:'只有房主可以移除 AI' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok:false, error:'遊戲已開始' });

    const aiId = payload && payload.playerId;
    const ai = room.players.find(p => p.id === aiId && p.isAI);
    if (!ai) return cb && cb({ ok:false, error:'找不到該 AI' });
    room.players = room.players.filter(p => p.id !== aiId);
    if (cb) cb({ ok:true });
    emitRoomState(room);
    broadcastPlayers(room);
    systemMsg(room, 'AI 玩家「' + ai.name + '」已被移除。');
  });

  socket.on('set_day_time', (payload) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.phase !== 'LOBBY') return;
    const sec = Math.max(30, Math.min(300, parseInt(payload && payload.seconds) || 120));
    room.dayDiscussTime = sec;
    io.to(room.roomId).emit('day_time_updated', { seconds: sec });
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => { console.log('[-] disconnected:', socket.id); handleLeave(socket); });

  socket.on('start_game', (payload, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok:false, error:'房間不存在' });
    if (room.hostId !== socket.id) return cb && cb({ ok:false, error:'只有房主可開始' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok:false, error:'遊戲已開始' });
    if (room.players.length < 6) return cb && cb({ ok:false, error:'至少需要 6 人' });
    if (room.players.length > 18) return cb && cb({ ok:false, error:'最多 18 人' });
    if (cb) cb({ ok:true });
    startGame(room);
  });

  socket.on('return_to_lobby', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    clearTimeout(room.timer);
    room.phase = 'LOBBY'; room.day = 0;
    room.votes = {}; room.wolfVotes = {}; room.wolfTarget = null;
    room.seerChecks = {}; room.seerVotes = {}; room.seerResolved = false; room.pendingDeaths = [];
    room.doctorTarget = null; room.sniperTarget = null; room.emptyShotCount = {};
    room.aiIntel = {}; room.aiBeliefs = {}; room.recentPublicChat = []; room.speakCount = {}; room.voteHistory = [];
    room.voteFinalizeScheduled = false;
    room.aiDiscussionRunning = false;
    room.aiDiscussionSpoken = new Set();
    room.players.forEach(p => {
      p.alive = true; p.role = null; p.deathCause = null; p.canSpeakInPublic = false;
      p.hasClaimedSeer = false; p.revengeTarget = null; p.loyalTarget = null;
      p.stance = null; p.previousSpeeches = []; p.lastVote = null;
    });
    emitRoomState(room);
    broadcastPlayers(room);
  });

  socket.on('wolf_kill', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'NIGHT_WOLF') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || me.role !== 'WEREWOLF' || !me.alive) return;

    const targetId = payload && payload.targetId;
    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target || target.id === me.id) return;

    room.wolfVotes[socket.id] = targetId;
    const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);

    wolves.filter(w => w.isAI).forEach(ai => {
      if (!room.wolfVotes[ai.id]) {
        room.wolfVotes[ai.id] = targetId;
        aiWolfSpeak(room, ai, 'FOLLOW', nameOf(room, targetId), me.name);
      }
    });

    wolves.forEach(w => {
      if (w.isAI) return;
      const mateVotes = {};
      wolves.forEach(m => {
        if (m.id !== w.id && room.wolfVotes[m.id]) {
          mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.wolfVotes[m.id]) };
        }
      });
      io.to(w.id).emit('teammate_votes', { stage:'NIGHT_WOLF', votes: mateVotes });
    });
    checkWolfUnified(room);
  });

  socket.on('seer_check', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'NIGHT_SEER') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || me.role !== 'SEER' || !me.alive) return;
    if (room.seerVotes[me.id]) {
      io.to(me.id).emit('error_message', { message: '你今晚已經投過票了。' });
      return;
    }
    const targetId = payload && payload.targetId;
    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target || target.id === me.id) return;
    room.seerVotes[me.id] = targetId;

    const aiSeers = room.players.filter(p => p.role === 'SEER' && p.alive && p.isAI);
    aiSeers.forEach(ai => {
      if (!room.seerVotes[ai.id]) {
        room.seerVotes[ai.id] = targetId;
        aiPoliceSpeak(room, ai, 'FOLLOW', nameOf(room, targetId));
      }
    });

    checkSeerUnified(room);
  });

  socket.on('doctor_heal', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'NIGHT_DOCTOR') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || me.role !== 'DOCTOR' || !me.alive) return;
    const targetId = payload && payload.targetId;
    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target) return;
    room.doctorTarget = targetId;
    clearTimeout(room.timer);
    setTimeout(() => nextAfterDoctor(room), 800);
  });

  socket.on('doctor_skip', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'NIGHT_DOCTOR') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || me.role !== 'DOCTOR' || !me.alive) return;
    room.doctorTarget = null;
    clearTimeout(room.timer);
    nextAfterDoctor(room);
  });

  socket.on('sniper_shoot', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'NIGHT_SNIPER') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || me.role !== 'SNIPER' || !me.alive) return;
    const targetId = payload && payload.targetId;
    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target || target.id === me.id) return;
    room.sniperTarget = targetId;
    room.sniperShotsLeft -= 1;
    clearTimeout(room.timer);
    setTimeout(() => resolveNight(room), 800);
  });

  socket.on('sniper_skip', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'NIGHT_SNIPER') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || me.role !== 'SNIPER' || !me.alive) return;
    room.sniperTarget = null;
    clearTimeout(room.timer);
    resolveNight(room);
  });

  socket.on('day_vote', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'DAY_VOTE') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || !me.alive) return;

    const targetId = (payload && payload.targetId) || null;
    if (targetId === me.id) return;
    if (targetId) {
      const target = room.players.find(p => p.id === targetId && p.alive);
      if (!target) return;
    }

    room.votes[me.id] = targetId;

    io.to(room.roomId).emit('vote_updated', {
      votes: tallyVotes(room),
      voteDetail: { ...room.votes }
    });
    broadcastTeammateVotes(room);

    const aliveCount = room.players.filter(p => p.alive).length;
    if (Object.keys(room.votes).length >= aliveCount) {
      if (!room.voteFinalizeScheduled) {
        room.voteFinalizeScheduled = true;
        setTimeout(() => {
          if (room.phase === 'DAY_VOTE') {
            clearTimeout(room.timer);
            resolveVote(room);
          }
        }, 15000);
      }
    }
  });

  socket.on('chat_send', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.phase === 'GAME_OVER') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me) return;
    const channel = (payload && payload.channel) || 'PUBLIC';
    const text = String((payload && payload.text) || '').trim().slice(0, 200);
    if (!text) return;

    if (channel === 'PUBLIC' && !me.alive) {
      if (!me.canSpeakInPublic) {
        io.to(me.id).emit('error_message', { message: '你已經發表過遺言，無法再於公開頻道發言。' });
        return;
      }
      me.canSpeakInPublic = false;
      const msg = { channel, from: me.name, text: '【遺言】' + text };
      io.to(room.roomId).emit('chat_message', msg);
      recordPublicChat(room, me.name, text);
      trackSpeak(room, me.id);
      processChatForAI(room, me.id, text);
      return;
    }

    const msg = { channel, from:me.name, text };

    if (channel === 'PUBLIC') {
      recordPublicChat(room, me.name, text);
      trackSpeak(room, me.id);
      processChatForAI(room, me.id, text);
    }

    if (channel === 'WOLF') {
      if (me.role !== 'WEREWOLF') return;
      room.players.filter(p => p.role === 'WEREWOLF' && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', msg));
      return;
    }
    if (channel === 'EVIL') {
      if (me.role !== 'WEREWOLF' && me.role !== 'SNIPER') return;
      room.players.filter(p => (p.role === 'WEREWOLF' || p.role === 'SNIPER') && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', msg));
      return;
    }
    if (channel === 'POLICE') {
      if (me.role !== 'SEER') return;
      room.players.filter(p => p.role === 'SEER' && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', msg));
      return;
    }
    if (channel === 'DEAD') {
      if (me.alive) return;
      room.players.filter(p => !p.alive && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', msg));
      return;
    }
    io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:me.name, text });
  });
});

// ============================================================
// 🚀 啟動伺服器
// ============================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`🐺 狼人殺伺服器已啟動，port = ${PORT}`);

  if (PROVIDER === 'OPENAI') {
    activeOpenAIModel = 'gpt-4o-mini';
    MODEL_NAME = 'gpt-4o-mini';
    console.log(`========================================`);
    console.log(`✅ OpenAI 就緒`);
    console.log(`📦 使用模型: ${MODEL_NAME}`);
    console.log(`========================================`);
  } else if (PROVIDER === 'GROQ') {
    const detected = await detectGroqModel();
    if (detected) {
      activeGroqModel = detected;
      MODEL_NAME = detected;
      console.log(`✅ Groq 模型偵測完成`);
      console.log(`📦 使用模型: ${detected}`);
    } else {
      PROVIDER = 'NONE';
      USE_GPT = false;
    }
  } else if (PROVIDER === 'GEMINI') {
    const detected = await detectGeminiModel();
    if (detected) {
      activeGeminiModel = detected;
      MODEL_NAME = detected;
      console.log(`✅ Gemini 模型偵測完成`);
      console.log(`📦 使用模型: ${detected}`);
    } else {
      PROVIDER = 'NONE';
      USE_GPT = false;
    }
  }
});
