// ============================================================
// 狼人殺後端 v7.2（智慧限速 + 10 種個性 + 遊戲凍結）
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = 'gpt-4o-mini';
const USE_GPT = !!OPENAI_API_KEY;

// 🔑 每分鐘最多請求次數（依你的帳號限制調整）
const OPENAI_RPM = 3;

if (USE_GPT) {
  console.log(`🤖 GPT 模式已啟用，使用模型：${OPENAI_MODEL}，限制 ${OPENAI_RPM} RPM`);
} else {
  console.log('📊 貝氏推斷模式（未設定 OPENAI_API_KEY）');
}

// ============================================================
// 🚦 智慧限速（滑動窗口 + 重試）
// ============================================================
const requestTimestamps = []; // 記錄最近 60 秒的請求時間

function getWaitTime() {
  const now = Date.now();
  // 清除超過 60 秒的紀錄
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > 60000) {
    requestTimestamps.shift();
  }
  // 如果還沒滿 → 立刻執行
  if (requestTimestamps.length < OPENAI_RPM) return 0;
  // 否則要等到最舊的請求過 60 秒
  return 60000 - (now - requestTimestamps[0]) + 100;
}

const requestQueue = [];
let queueRunning = false;

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (requestQueue.length > 0) {
    const job = requestQueue.shift();
    const wait = getWaitTime();
    if (wait > 0) {
      console.log(`[GPT] 等待 ${Math.round(wait/1000)} 秒（限速中）…`);
      await new Promise(r => setTimeout(r, wait));
    }
    requestTimestamps.push(Date.now());
    try {
      const result = await job.fn();
      job.resolve(result);
    } catch (e) {
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
// 🤖 OpenAI 呼叫（含 429 智慧重試）
// ============================================================
async function askGPT(messages, maxTokens = 120) {
  if (!USE_GPT) return null;
  return enqueue(async () => {
    const tryOnce = async (attempt) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages,
            max_tokens: maxTokens,
            temperature: 0.9,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 429) {
          // 讀取 Retry-After 標頭（如果有）
          const retryAfter = res.headers.get('retry-after');
          const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 20000;

          if (attempt < 2) {
            console.warn(`[GPT] 429 限速，等 ${Math.round(waitMs/1000)} 秒重試（第 ${attempt+1} 次）…`);
            // 清空並等待窗口重置
            requestTimestamps.length = 0;
            await new Promise(r => setTimeout(r, waitMs));
            requestTimestamps.push(Date.now());
            return tryOnce(attempt + 1);
          }
          console.warn('[GPT] 429 放棄（改用模板）');
          return null;
        }

        if (!res.ok) {
          const errText = await res.text();
          console.warn('[GPT]', res.status, errText.slice(0, 150));
          return null;
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
      } catch (e) {
        console.warn('[GPT error]', e.message);
        return null;
      }
    };
    return await tryOnce(0);
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
function publicPlayers(room) {
  return room.players.map(p => ({ id:p.id, name:p.name, alive:p.alive, isHost:p.isHost, isAI:!!p.isAI }));
}
function roomPayload(room) { return { roomId:room.roomId, players:publicPlayers(room), phase:room.phase }; }
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
  candidates.sort((a, b) => (beliefs[b.id]?.wolfProb || 0) - (beliefs[a.id]?.wolfProb || 0));
  return candidates[0].id;
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
  ANALYTICAL: '你是【冷靜分析型】。發言條理分明、客觀，喜歡引用過往的投票軌跡與邏輯進行推斷。',
  IMPULSIVE:  '你是【衝動跟風型】。說話直率、容易緊張，常用驚嘆號，容易被別人帶風向。',
  LAZY:       '你是【划水佛系型】。話少、句子短（如「我覺得都行」「先觀望」），盡量不引人注目。',
  PARANOID:   '你是【傲嬌疑心病型】。容易懷疑別人，講話帶有防禦性，誰指責你你就反嗆回去。',
  INTUITIVE:  '你是【直覺神棍型】。不靠邏輯全憑第六感，會說「我昨晚夢到 XX 身上有狼味」這類的話。',
  CHAOTIC:    '你是【混亂邪惡型】。唯恐天下不亂，喜歡拱火、故意搞亂局勢。',
  LOYAL:      '你是【盲從忠犬型】。你心中認定場上某一位玩家是好人，會強烈維護對方。',
  HONEST:     '你是【老實人型】。講話非常禮貌、規矩、稍微有點冗長。',
  TALKATIVE:  '你是【話癆廢話王型】。字數很多但完全沒有重點，喜歡打太極、講廢話。',
  VENGEFUL:   '你是【死磕復仇型】。只要有人懷疑過你一次，你就會死咬著對方不放。',
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

// ============================================================
// 💬 發言模板
// ============================================================
const SPEECH = {
  ACCUSE: [
    '我覺得 {name} 很怪，大家注意一下。',
    '{name} 的發言有點刻意，我懷疑他。',
    '我投 {name}，感覺他在藏。',
    '{name} 你解釋一下？剛剛那句話很可疑。',
    '我懷疑 {name}，他一直在轉移話題。',
    '{name} 一直不說話，很可疑。',
    '我認為 {name} 應該被放逐。',
    '{name} 邏輯不通，一定是壞人。',
    '我建議大家注意 {name}。',
    '{name} 從頭到尾都怪怪的。',
    '我觀察 {name} 很久了，有問題。',
    '{name} 你這樣講話很不自然。',
    '我覺得 {name} 一直在帶風向。',
    '{name} 的行為太反常了，投他。',
    '我不太相信 {name}。',
  ],
  FOLLOW: [
    '我同意，{name} 確實可疑。',
    '好，我跟票投 {name}。',
    '聽起來有道理，我也懷疑 {name}。',
    '說得對，{name} 有問題。',
    '我跟。{name} 看起來真的有鬼。',
    '跟票 {name}，這波穩。',
    '大家說 {name} 那我就投 {name} 了。',
    '{name} 是吧？我跟。',
    '我信大家的判斷，投 {name}。',
    '我也覺得 {name} 有問題。',
    '既然你們都這麼說，我就跟 {name}。',
    '{name} 這波我也跟。',
    '我相信大家的判斷，{name}。',
    '好，就 {name} 吧。',
    '大家一起投 {name}，穩了。',
  ],
  DEFEND: [
    '我是好人，不要投我！',
    '我真的是平民，相信我。',
    '你們投我是浪費票，聽我說。',
    '我是好人陣營，別亂投。',
    '投我等於幫狼人，你們冷靜點。',
    '我是清白的，請聽我解釋。',
    '我不知道為什麼你們懷疑我，我是好人。',
    '我是正義陣營，這我可以發誓。',
    '我沒說謊，我只是話少。',
    '我發誓我是好人，請不要投我。',
    '我是無辜的，你們搞錯了。',
    '給我一個機會解釋，我真的是好人。',
    '你們這樣懷疑我，我很難過。',
    '我不是狼，請相信我。',
    '要投我可以，但我保證你們會後悔。',
  ],
  CHAOS: [
    '我什麼都不知道，我只是個平民。',
    '我覺得我們應該全部投自己。',
    '這個遊戲太難了，我選擇放棄思考。',
    '我懷疑椅子。',
    '我提議全部重新洗牌。',
    '我已經放棄推理了，隨便投。',
    '我感覺今天會有大事發生。',
    '反正都要死，不如拉一個墊背的。',
    '我覺得應該投給最活躍的人。',
    '要不我們全部投給 GM？',
    '我覺得我們應該先冷靜一下。',
    '我什麼都不知道，我是無辜的。',
    '誰投我我就投誰，大家一起死。',
    '我在想如果我是狼人，我會不會告訴你們？',
    '安安，我只是路過的。',
  ],
  SEER_CLAIM: [
    '我是警察！請相信我。',
    '我是預言家，我查過人了。',
    '我是警察，我可以提供驗人資訊。',
    '我是預言家，請大家跟我的票。',
    '我真的是警察，請投我信任票。',
  ],
  SILENT: [
    '{name} 也太安靜了吧，可疑。',
    '{name} 都不說話，是不是在裝？',
    '怎麼 {name} 都不講話？有鬼。',
    '我建議先關注沉默的 {name}。',
    '{name} 你倒是說句話啊。',
    '{name} 一直不說話，我心很慌。',
    '沉默的 {name} 最可疑。',
    '{name} 你為什麼不說話？',
  ],
};

function fillTemplate(tmpl, name) { return tmpl.replace(/\{name\}/g, name || ''); }
function pickSpeech(category, name) {
  const pool = SPEECH[category] || SPEECH.CHAOS;
  return fillTemplate(randomPick(pool), name);
}

// ============================================================
// 🧠 AI 上下文
// ============================================================
function buildAiContext(room, ai) {
  const alive = room.players.filter(p => p.alive);
  const others = alive.filter(p => p.id !== ai.id);

  let campDesc = '';
  if (ai.role === 'WEREWOLF') {
    const mates = alive.filter(p => p.role === 'WEREWOLF' && p.id !== ai.id).map(p => p.name);
    campDesc = mates.length ? `你是邪惡陣營的狼人。你的狼人同伴是：${mates.join('、')}。` : '你是邪惡陣營的狼人，目前沒有同伴。';
  } else if (ai.role === 'SNIPER') {
    campDesc = '你是邪惡陣營的狙擊手，但你無法辨識誰是狼人同伴，可能誤殺他們。';
  } else if (ai.role === 'SEER') {
    const mates = alive.filter(p => p.role === 'SEER' && p.id !== ai.id).map(p => p.name);
    campDesc = mates.length ? `你是正義陣營的警察（預言家）。你的警察同伴是：${mates.join('、')}。` : '你是正義陣營的警察（預言家）。';
  } else if (ai.role === 'DOCTOR') {
    campDesc = '你是正義陣營的醫生。';
  } else {
    campDesc = '你是正義陣營的平民。';
  }

  let checkInfo = '';
  if (ai.role === 'SEER') {
    const checks = room.seerChecks[ai.id] || {};
    const lines = Object.entries(checks).map(([id, camp]) => `  ${nameOf(room, id)} = ${camp === 'WOLF' ? '壞人' : '好人'}`);
    if (lines.length) checkInfo = `\n【你已知的查驗結果】\n${lines.join('\n')}`;
  }

  const recent = (room.recentPublicChat || []).slice(-15);
  const chatLog = recent.length ? recent.map(m => `${m.from}：${m.text}`).join('\n') : '（目前還沒有人發言）';

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

  let voteHistory = '';
  if (room.voteHistory && room.voteHistory.length) {
    voteHistory = room.voteHistory.slice(-3).map(h =>
      `第 ${h.day} 天投票：${Object.entries(h.votes).map(([voterId, targetId]) =>
        `${nameOf(room, voterId)}→${targetId ? nameOf(room, targetId) : '棄票'}`
      ).join('、')}`
    ).join('\n');
  } else {
    voteHistory = '（還沒有投票紀錄）';
  }

  const beliefs = room.aiBeliefs[ai.id] || {};
  const suspLines = others
    .map(p => ({ name: p.name, prob: beliefs[p.id]?.wolfProb || 0 }))
    .filter(x => x.prob > 0.25)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 4)
    .map(x => `  ${x.name}：${Math.round(x.prob * 100)}% 是狼`)
    .join('\n');

  const accusers = [];
  (room.recentPublicChat || []).forEach(m => {
    if (m.from === ai.name) return;
    if (m.text.includes(ai.name)) {
      if (/是狼|是壞人|懷疑|投他|投她/.test(m.text)) accusers.push(m.from);
    }
  });

  const lastSpeaker = recent.length > 0 ? recent[recent.length - 1].from : null;

  return {
    campDesc, checkInfo, chatLog, playerList, suspLines, alive, others,
    deathLog, voteHistory,
    accusers: [...new Set(accusers)],
    lastSpeaker,
  };
}

// ============================================================
// 🗣 GPT 發言
// ============================================================
async function aiSpeakWithGPT(room, ai) {
  const ctx = buildAiContext(room, ai);
  const tone = PERSONALITY_TONE[ai.personality] || '';

  let defendHint = '';
  if (ctx.accusers.length > 0) {
    defendHint = `\n⚠️ ${ctx.accusers.join('、')} 曾經懷疑過你，請用你的個性風格回應。`;
  }

  let lengthHint = '25~40 字';
  if (ai.personality === 'LAZY') lengthHint = '10~15 字（話少）';
  if (ai.personality === 'TALKATIVE') lengthHint = '50~80 字（話多但沒重點）';
  if (ai.personality === 'HONEST') lengthHint = '40~60 字（禮貌又囉嗦）';
  if (ai.personality === 'IMPULSIVE') lengthHint = '15~30 字（帶驚嘆號）';

  let interactionHint = '';
  if (ctx.lastSpeaker && ctx.lastSpeaker !== ai.name) {
    interactionHint = `\n⚠️ 【強制要求】你必須在發言中直接回應 ${ctx.lastSpeaker} 剛剛說的話，或引用某位玩家的名字與發言。`;
  } else {
    interactionHint = `\n⚠️ 【強制要求】你必須在發言中提到至少一位玩家的名字。`;
  }

  const prompt = `你正在玩一場狼人殺遊戲，扮演一位玩家。

【你的角色】${ai.name}
${ctx.campDesc}
【你的個性】${tone}
【當前階段】第 ${room.day} 天 · 白天討論

【存活玩家】
${ctx.playerList}${ctx.checkInfo}

【已死亡的玩家】
${ctx.deathLog}

【前幾輪的投票紀錄】
${ctx.voteHistory}

【最近對話紀錄】
${ctx.chatLog}
${defendHint}

【你的推理參考】
${ctx.suspLines || '（暫無明顯懷疑對象）'}

【你的任務】
請用「${ai.personality}」的個性，發言 ${lengthHint}。
${interactionHint}
⚠️ 不要說空泛的話（例如「我覺得XX很怪」），要引用具體的發言內容或投票紀錄。
⚠️ 用繁體中文。直接輸出你的發言，不要加引號、玩家名字前綴、或任何說明。`;

  return await askGPT([
    {
      role: 'system',
      content: '你是狼人殺遊戲的高手玩家，擅長邏輯推理和話術。請完全依照指定的個性風格發言，並確實引用其他玩家的發言。'
    },
    { role: 'user', content: prompt }
  ], 150);
}

// ============================================================
// 🗳 GPT 投票
// ============================================================
async function aiVoteWithGPT(room, ai) {
  const ctx = buildAiContext(room, ai);

  const prompt = `你正在玩狼人殺遊戲，現在要投票放逐一位玩家。

【你的角色】${ai.name}
${ctx.campDesc}
【你的個性】${PERSONALITY_TONE[ai.personality] || ''}
【當前階段】第 ${room.day} 天 · 投票放逐

【存活的玩家】
${ctx.playerList}${ctx.checkInfo}

【已死亡的玩家】
${ctx.deathLog}

【前幾輪的投票紀錄】
${ctx.voteHistory}

【最近對話紀錄】
${ctx.chatLog}

【你的推理參考】
${ctx.suspLines || '（暫無明顯懷疑對象）'}

請依照你的個性選擇投票對象：
${ctx.others.map(p => `- ${p.name}`).join('\n')}

用 JSON 格式回傳：{"target": "玩家名字", "reason": "簡短理由（10字內）"}
只回傳 JSON，不要有其他文字。`;

  const text = await askGPT([
    { role: 'system', content: '你是狼人殺遊戲玩家，用 JSON 回傳投票決定。' },
    { role: 'user', content: prompt }
  ], 80);

  if (!text) return null;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const json = JSON.parse(clean);
    const target = ctx.others.find(p => p.name === json.target);
    return target ? target.id : null;
  } catch (e) {
    console.warn('[GPT vote parse error]', text.slice(0, 100));
    return null;
  }
}

// ============================================================
// 🧠 人類意圖解析
// ============================================================
function processChatForAI(room, speakerId, text) {
  const speaker = room.players.find(p => p.id === speakerId);
  if (!speaker) return;
  const ais = room.players.filter(p => p.isAI && p.alive);

  if (/我是預言家|我是警察|我查過|查驗過|我是預言/.test(text)) {
    ais.forEach(ai => {
      if (ai.id === speakerId) return;
      if (!room.aiIntel[ai.id]) room.aiIntel[ai.id] = {};
      room.aiIntel[ai.id].claimedSeer = speakerId;
    });
  }

  if (/是狼|是壞人|是邪惡|他在騙|他在說謊|懷疑/.test(text)) {
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
function recordPublicChat(room, fromName, text) {
  if (!room.recentPublicChat) room.recentPublicChat = [];
  room.recentPublicChat.push({ from: fromName, text, ts: Date.now() });
  if (room.recentPublicChat.length > 100) room.recentPublicChat.shift();
}

// ============================================================
// 🎯 AI 決策核心
// ============================================================
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
    if (personality === 'LAZY' && Math.random() < 0.3) {
      return null;
    }
  }

  const roll = Math.random() * 100;
  let cum = 0, strategy = 'BELIEF';
  for (const key of ['FOLLOW', 'BELIEF', 'RANDOM', 'CONTRARIAN']) {
    cum += weights[key];
    if (roll < cum) { strategy = key; break; }
  }

  switch (strategy) {
    case 'FOLLOW': {
      const humans = room.players.filter(p => !p.isAI && p.alive);
      if (!humans.length) return pickTargetByBelief(room, ai, p => candidates.find(c => c.id === p.id));
      const t = randomPick(humans);
      return candidates.find(c => c.id === t.id)?.id || pickTargetByBelief(room, ai, p => candidates.find(c => c.id === p.id));
    }
    case 'CONTRARIAN': {
      const beliefs = room.aiBeliefs[ai.id] || {};
      const sorted = candidates.slice().sort((a,b) => (beliefs[a.id]?.wolfProb||0) - (beliefs[b.id]?.wolfProb||0));
      return sorted[0]?.id || randomPick(candidates).id;
    }
    case 'RANDOM':
      return randomPick(candidates).id;
    default:
      return pickTargetByBelief(room, ai, p => candidates.find(c => c.id === p.id));
  }
}

// ============================================================
// 🗣 AI 發言
// ============================================================
async function aiSpeak(room, ai) {
  if (room.phase !== 'DAY_DISCUSS' || !ai.alive) return;
  if (room.phase === 'GAME_OVER') return;

  if (ai.role === 'SEER' && !ai.hasClaimedSeer) {
    const humanSeers = room.players.filter(p => p.role === 'SEER' && p.alive && !p.isAI);
    if (humanSeers.length === 0) {
      const otherAiClaimed = room.players.some(p =>
        p.role === 'SEER' && p.isAI && p.id !== ai.id && p.hasClaimedSeer
      );
      if (!otherAiClaimed) {
        const checks = room.seerChecks[ai.id] || {};
        const knownWolfId = Object.keys(checks).find(id => {
          if (checks[id] !== 'WOLF') return false;
          const target = room.players.find(p => p.id === id);
          return target && target.alive;
        });
        if (knownWolfId) {
          const wolfName = nameOf(room, knownWolfId);
          const speech = `我是警察！我查驗了 ${wolfName}，他是狼人！請大家跟我一起投他！`;
          io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text: speech });
          ai.hasClaimedSeer = true;
          Object.keys(room.aiBeliefs || {}).forEach(otherAiId => {
            if (otherAiId === ai.id) return;
            updateBelief(room, otherAiId, knownWolfId, +0.55, `${ai.name} 跳警指認`);
          });
          return;
        }
      }
    }
  }

  if (USE_GPT) {
    const text = await aiSpeakWithGPT(room, ai);
    if (text && room.phase === 'DAY_DISCUSS' && ai.alive) {
      io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text });
      return;
    }
  }

  const alive = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!alive.length) return;

  const target = randomPick(alive);
  let category = 'ACCUSE';

  switch (ai.personality) {
    case 'LAZY': category = 'CHAOS'; break;
    case 'IMPULSIVE':
    case 'LOYAL': category = Math.random() < 0.6 ? 'FOLLOW' : 'ACCUSE'; break;
    case 'TALKATIVE':
    case 'CHAOTIC': category = 'CHAOS'; break;
    case 'HONEST': category = Math.random() < 0.5 ? 'ACCUSE' : 'SILENT'; break;
    default: category = 'ACCUSE';
  }

  if (ai.role === 'SEER' && Math.random() < 0.15) category = 'SEER_CLAIM';

  io.to(room.roomId).emit('chat_message', {
    channel:'PUBLIC', from:ai.name, text: pickSpeech(category, target.name)
  });
}

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
// 🔮 警察共同查驗
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
  const camp = (target.role === 'WEREWOLF' || target.role === 'SNIPER') ? 'WOLF' : 'GOOD';

  Object.keys(room.aiBeliefs || {}).forEach(aiId => {
    if (aiId === targetId) return;
    updateBelief(room, aiId, targetId, camp === 'WOLF' ? +0.7 : -0.4, '查驗結果');
  });

  room.players.filter(p => p.role === 'SEER').forEach(seer => {
    if (!room.seerChecks[seer.id]) room.seerChecks[seer.id] = {};
    room.seerChecks[seer.id][targetId] = camp;
  });

  room.players.filter(p => p.role === 'SEER' && !p.isAI).forEach(seer => {
    io.to(seer.id).emit('seer_result', { targetId, targetName: target.name, camp, shared: true });
  });

  setTimeout(() => nextAfterSeer(room), 2500);
}

// ============================================================
// AI 夜晚行動
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

// ============================================================
// 狼人統一
// ============================================================
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
// AI 排程（🔑 調慢間隔以配合限速）
// ============================================================
function scheduleAiActions(room, phase) {
  const ais = room.players.filter(p => p.isAI && p.alive);

  if (phase === 'DAY_DISCUSS') {
    // 🔑 每個 AI 間隔 22 秒（3 RPM 下 60/3=20 秒 + buffer）
    ais.forEach((ai, idx) => {
      setTimeout(async () => {
        if (room.phase !== 'DAY_DISCUSS' || !ai.alive) return;
        if (room.phase === 'GAME_OVER') return;
        await aiSpeak(room, ai);
      }, 2000 + idx * 22000);
    });
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
  }

  if (phase === 'NIGHT_SNIPER') {
    ais.filter(p => p.role === 'SNIPER').forEach(ai => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_SNIPER' || !ai.alive) return;
        const target = aiSniperPick(room, ai);
        if (!target) return;
        room.sniperTarget = target;
        setTimeout(() => { if (room.phase === 'NIGHT_SNIPER') resolveNight(room); }, 1500);
      }, 2500 + Math.random()*3000);
    });
  }

  if (phase === 'DAY_VOTE') {
    // 🔑 投票間隔也調慢
    ais.forEach((ai, idx) => {
      setTimeout(async () => {
        if (room.phase !== 'DAY_VOTE' || !ai.alive) return;
        if (room.votes[ai.id] !== undefined) return;

        let target = null;
        if (USE_GPT) target = await aiVoteWithGPT(room, ai);
        if (!target) target = decideTargetByBelief(room, ai, 'VOTE');

        if (room.phase !== 'DAY_VOTE' || room.votes[ai.id] !== undefined) return;
        room.votes[ai.id] = target;
        io.to(room.roomId).emit('vote_updated', {
          votes: tallyVotes(room),
          voteDetail: { ...room.votes }
        });
        broadcastTeammateVotes(room);

        const aliveCount = room.players.filter(p => p.alive).length;
        if (Object.keys(room.votes).length >= aliveCount) {
          clearTimeout(room.timer);
          setTimeout(() => resolveVote(room), 800);
        }
      }, 2000 + idx * 22000);
    });
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
// 法官台詞
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

// ============================================================
// 階段切換
// ============================================================
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
  const sec = PHASE_SECONDS[phase] || 20;
  room.endsAt = Date.now() + sec*1000;
  if (phase === 'DAY_VOTE') room.votes = {};
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
// 遊戲流程
// ============================================================
function startGame(room) {
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
  });

  const loyalAis = room.players.filter(p => p.isAI && p.personality === 'LOYAL');
  loyalAis.forEach(ai => {
    const candidates = room.players.filter(p => p.id !== ai.id);
    if (candidates.length) {
      ai.loyalTarget = randomPick(candidates).id;
    }
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
  room.recentPublicChat = [];
  room.speakCount = {};
  room.voteHistory = [];

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

function resolveVote(room) {
  if (room.phase !== 'DAY_VOTE') return;

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

function handleLeave(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.phase === 'GAME_OVER') return;

  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx === -1) return;
  const removed = room.players[idx];
  room.players.splice(idx, 1);
  socket.leave(roomId);
  socket.data.roomId = null;

  const inGame = room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER';
  if (inGame) {
    removed.alive = false;
    broadcastPlayers(room);
    announceDeath(room, removed, 'DISCONNECT');
    if (checkWin(room)) return;
    if (room.phase === 'NIGHT_SEER') checkSeerUnified(room);
  }
  if (room.players.length === 0) { clearTimeout(room.timer); rooms.delete(roomId); return; }
  if (room.hostId === removed.id) {
    const nextHost = room.players.find(p => !p.isAI);
    if (nextHost) { room.hostId = nextHost.id; room.players.forEach(p => p.isHost=false); nextHost.isHost = true; }
    else { room.hostId = room.players[0].id; room.players[0].isHost = true; }
  }
  emitRoomState(room);
}

// ============================================================
// Socket 連線
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
      wolfVotes:{}, wolfTarget:null, seerChecks:{}, seerVotes:{}, seerResolved:false,
      votes:{}, pendingDeaths:[], doctorTarget:null, sniperTarget:null,
      doctorShotsLeft:0, sniperShotsLeft:0, emptyShotCount:{},
      aiIntel:{}, aiBeliefs:{}, recentPublicChat:[], speakCount:{}, voteHistory:[], timer:null, endsAt:null,
    };
    room.players.push({ id:socket.id, name:nickname, alive:true, isHost:true, role:null, isAI:false, canSpeakInPublic:false, hasClaimedSeer:false, revengeTarget:null, loyalTarget:null });
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

    room.players.push({ id:socket.id, name:nickname, alive:true, isHost:false, role:null, isAI:false, canSpeakInPublic:false, hasClaimedSeer:false, revengeTarget:null, loyalTarget:null });
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
      revengeTarget:null, loyalTarget:null,
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
    room.players.forEach(p => { p.alive = true; p.role = null; p.deathCause = null; p.canSpeakInPublic = false; p.hasClaimedSeer = false; p.revengeTarget = null; p.loyalTarget = null; });
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
    if (room.votes[me.id] !== undefined) return;
    room.votes[me.id] = (payload && payload.targetId) || null;

    io.to(room.roomId).emit('vote_updated', {
      votes: tallyVotes(room),
      voteDetail: { ...room.votes }
    });
    broadcastTeammateVotes(room);
    const aliveCount = room.players.filter(p => p.alive).length;
    if (Object.keys(room.votes).length >= aliveCount) {
      clearTimeout(room.timer);
      setTimeout(() => resolveVote(room), 800);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🐺 狼人殺伺服器已啟動，port = ' + PORT));
