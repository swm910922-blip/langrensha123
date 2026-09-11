// ============================================================
// 狼人殺後端 v3.4（同夥顯示 + 投票明細 + AI 順從真人）
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
  DAY_ANNOUNCE: 12, DAY_DISCUSS: 60, DAY_VOTE: 30,
};

// ============================================================
// 工具函式
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
function shortId(id) {
  if (!id) return '?';
  if (id.startsWith('ai_')) return 'AI' + id.slice(3);
  return id.slice(0,4);
}

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
// 🎭 AI 性格系統
// ============================================================
const AI_NAMES = ['小狼','阿智','阿呆','小紅','阿明','阿豪','小玉','大頭','阿芬','老張','小陳','阿傑','阿宏','小如','阿文','小婷','阿伯','小胖'];
function genAiId(room) { let i=1; while(room.players.find(p=>p.id==='ai_'+i)) i++; return 'ai_'+i; }
const AI_PERSONALITIES = ['FOLLOWER', 'INTUITIVE', 'THOUGHTFUL', 'CHAOTIC', 'CONSERVATIVE'];
const PERSONALITY_WEIGHTS = {
  FOLLOWER:     { FOLLOW: 65, RANDOM: 20, CONTRARIAN: 5,  FACTION: 10 },
  INTUITIVE:    { FOLLOW: 15, RANDOM: 55, CONTRARIAN: 20, FACTION: 10 },
  THOUGHTFUL:   { FOLLOW: 25, RANDOM: 20, CONTRARIAN: 10, FACTION: 45 },
  CHAOTIC:      { FOLLOW: 10, RANDOM: 30, CONTRARIAN: 50, FACTION: 10 },
  CONSERVATIVE: { FOLLOW: 20, RANDOM: 50, CONTRARIAN: 5,  FACTION: 25 },
};

// ============================================================
// 💬 發言池
// ============================================================
const SPEECH = {
  ACCUSE: [
    '我覺得 {name} 很怪，大家注意一下。',
    '{name} 的發言有點刻意，我懷疑他。',
    '我投 {name}，感覺他在藏。',
    '{name} 你解釋一下？剛剛那句話很可疑。',
    '我懷疑 {name}，他一直在轉移話題。',
    '{name} 一直不說話，很可疑。',
    '我覺得 {name} 有問題。',
    '{name} 是狼吧？我的直覺告訴我。',
    '我總覺得 {name} 的眼神怪怪的。',
    '{name} 剛剛那句發言很緊張，我懷疑他。',
    '我一直在觀察 {name}，他太安靜了。',
    '我認為 {name} 應該被放逐。',
    '{name} 你就是狼，別裝了！',
    '{name} 邏輯不通，一定是壞人。',
    '我嗅到 {name} 身上有問題。',
    '{name} 你這樣講話很不自然。',
    '我覺得 {name} 一直在帶風向。',
    '{name} 的行為太反常了，投他。',
    '我建議大家注意 {name}。',
    '{name} 從頭到尾都怪怪的。',
  ],
  FOLLOW: [
    '我同意，{name} 確實可疑。',
    '既然大家都這麼說，那我也投 {name}。',
    '好，我跟票投 {name}。',
    '聽起來有道理，我也懷疑 {name}。',
    '說得對，{name} 有問題。',
    '我跟。{name} 看起來真的有鬼。',
    '我也這麼覺得，{name} 有鬼。',
    '跟票 {name}，這波穩。',
    '好，我信你們，投 {name}。',
    '大家說 {name} 那我就投 {name} 了。',
    '{name} 是吧？我跟。',
    '既然大家都說 {name}，那就 {name} 吧。',
    '我支持，投 {name}。',
    '照這樣看，{name} 應該出局。',
    '我信大家的判斷，投 {name}。',
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
  ],
  CHAOS: [
    '我什麼都不知道，我只是個平民。',
    '我覺得我們應該全部投自己。',
    '你們說句話啊！',
    '我看到有人在偷笑。',
    '我的直覺告訴我，有人在說謊。',
    '既然不能證明，那我們就投票吧！',
    '我投給最沉默的那個人。',
    '我感覺今天會有大事發生。',
    '這個遊戲太難了，我選擇放棄思考。',
    '我已經不知道該相信誰了。',
    '大家一起投票，總會投中一個吧。',
    '我覺得這局很混亂。',
    '我提議全部重新洗牌。',
    '我已經放棄推理了，隨便投。',
    '我要把票投給今天最活躍的人。',
  ],
  SEER_CLAIM: [
    '我是預言家，我查過人了。',
    '我是警察，請相信我。',
    '我查驗過人，請大家聽我說話。',
    '我是預言家，我昨晚看到了一些東西。',
    '我真的是警察，請投我信任票。',
    '我是警察，我昨晚查驗了一個關鍵人物。',
    '我是預言家，請大家跟我的票。',
    '我是警察，我可以提供驗人資訊。',
  ],
  POLICE: [
    '警察頻道：{name} 很可疑，建議查他。',
    '我建議今晚查 {name}。',
    '{name} 我懷疑他，警察們注意。',
    '我覺得 {name} 有問題，我們統一戰線。',
    '警察頻道：建議大家把查驗集中在 {name}。',
    '今晚我會查 {name}。',
    '{name} 你先別急，我再觀察一輪。',
    '警察頻道：我直覺 {name} 是狼。',
    '我建議把 {name} 列入觀察名單。',
    '警察頻道：{name} 我建議優先處理。',
  ],
  SILENT: [
    '{name} 也太安靜了吧，可疑。',
    '{name} 都不說話，是不是在裝？',
    '{name} 一整晚沒出聲，我懷疑他。',
    '怎麼 {name} 都不講話？有鬼。',
    '{name} 為什麼一直沉默？心虛嗎？',
    '我建議先關注沉默的 {name}。',
    '{name} 你倒是說句話啊。',
  ],
};

function fillTemplate(tmpl, name) { return tmpl.replace(/\{name\}/g, name); }
function pickSpeech(category, name) {
  const pool = SPEECH[category] || SPEECH.CHAOS;
  const tmpl = randomPick(pool);
  return fillTemplate(tmpl, name);
}

// ============================================================
// 🧠 人類意圖解析
// ============================================================
function getRecentHumanHints(room) {
  const humans = room.players.filter(p => !p.isAI && p.alive);
  const recent = room.recentPublicChat || [];
  const hints = [];
  for (const msg of recent.slice(-20)) {
    const speaker = humans.find(h => h.name === msg.from);
    if (!speaker) continue;
    room.players.forEach(target => {
      if (!target.alive || target.id === speaker.id) return;
      if (msg.text.includes(target.name)) {
        hints.push({ targetId: target.id, targetName: target.name, from: speaker.name });
      }
    });
  }
  return hints;
}

// ============================================================
// 🎯 AI 決策核心
// ============================================================
function decideTarget(room, ai, context) {
  const personality = ai.personality || 'INTUITIVE';
  const weights = { ...PERSONALITY_WEIGHTS[personality] };

  let candidates = room.players.filter(p => p.alive && p.id !== ai.id);

  if (context === 'WOLF_KILL') {
    candidates = candidates.filter(p => p.role !== 'WEREWOLF' && p.role !== 'SNIPER');
  }
  if (context === 'SEER_CHECK') {
    const checked = room.seerChecks[ai.id] || {};
    candidates = candidates.filter(p => !checked[p.id]);
  }
  if (context === 'DOCTOR_HEAL') {
    candidates = room.players.filter(p => p.alive);
  }
  if (!candidates.length) return null;

  const hints = getRecentHumanHints(room);
  const validHints = hints.filter(h => candidates.find(c => c.id === h.targetId));

  if (!validHints.length) {
    weights.RANDOM += weights.FOLLOW;
    weights.FOLLOW = 0;
  }

  const roll = Math.random() * 100;
  let cum = 0;
  let strategy = 'RANDOM';
  for (const key of ['FOLLOW', 'RANDOM', 'CONTRARIAN', 'FACTION']) {
    cum += weights[key];
    if (roll < cum) { strategy = key; break; }
  }

  switch (strategy) {
    case 'FOLLOW': return randomPick(validHints).targetId;
    case 'CONTRARIAN': {
      const tally = tallyVotes(room);
      const sorted = candidates.slice().sort((a,b) => (tally[a.id]||0) - (tally[b.id]||0));
      return sorted[0]?.id || randomPick(candidates).id;
    }
    case 'FACTION': {
      if (context === 'SEER_CHECK') return randomPick(candidates).id;
      if (context === 'DOCTOR_HEAL') {
        if (Math.random() < 0.6) return ai.id;
        return randomPick(candidates).id;
      }
      return randomPick(candidates).id;
    }
    default: {
      if (personality === 'CONSERVATIVE') {
        const speakCount = room.speakCount || {};
        const sorted = candidates.slice().sort((a,b) => (speakCount[a.id]||0) - (speakCount[b.id]||0));
        if (Math.random() < 0.5) return sorted[0]?.id || randomPick(candidates).id;
      }
      return randomPick(candidates).id;
    }
  }
}

// ============================================================
// 🗣 AI 發言
// ============================================================
function aiSpeak(room, ai) {
  const personality = ai.personality || 'INTUITIVE';
  const alive = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!alive.length) return;

  const hints = getRecentHumanHints(room);
  const roll = Math.random() * 100;
  let category = 'ACCUSE';

  if (ai.role === 'SEER' && Math.random() < 0.15) category = 'SEER_CLAIM';
  else if (roll < 15 && ai.suspectedCount > 0) category = 'DEFEND';
  else if (hints.length && (personality === 'FOLLOWER' || Math.random() < 0.3)) {
    const hint = randomPick(hints);
    io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text: pickSpeech('FOLLOW', hint.targetName) });
    return;
  }
  else if (personality === 'CHAOTIC') {
    io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text: pickSpeech('CHAOS', '') });
    return;
  }
  else if (personality === 'CONSERVATIVE') {
    const speakCount = room.speakCount || {};
    const quiet = alive.slice().sort((a,b) => (speakCount[a.id]||0) - (speakCount[b.id]||0))[0];
    if (quiet) {
      io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text: pickSpeech('SILENT', quiet.name) });
      return;
    }
  }

  const target = randomPick(alive);
  io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text: pickSpeech(category, target.name) });
}

// AI 在警察頻道發言
function aiPoliceSpeak(room, ai, context, targetName) {
  let text = '';
  if (context === 'FOLLOW') {
    text = `[${ai.name}] 決定跟隨你的選擇，查驗 ${targetName}`;
  } else if (context === 'SUGGEST') {
    text = pickSpeech('POLICE', targetName);
  }
  if (!text) return;
  room.players.filter(p => p.role === 'SEER' && !p.isAI)
    .forEach(p => io.to(p.id).emit('chat_message', { channel:'POLICE', system:true, text }));
}

// AI 在狼人頻道發言
function aiWolfSpeak(room, ai, context, targetName, followerName) {
  let text = '';
  if (context === 'FOLLOW') {
    text = `[${ai.name}] 決定跟隨 ${followerName} 的選擇，刺殺 ${targetName}`;
  } else if (context === 'SUGGEST') {
    text = `[${ai.name}] 建議今晚刺殺 ${targetName}`;
  }
  if (!text) return;
  room.players.filter(p => p.role === 'WEREWOLF' && !p.isAI)
    .forEach(p => io.to(p.id).emit('chat_message', { channel:'WOLF', system:true, text }));
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
// 🔮 警察共同查驗 + 內部投票明細
// ============================================================
function checkSeerUnified(room) {
  const seers = room.players.filter(p => p.role === 'SEER' && p.alive);
  if (!seers.length) return;

  // 通知所有警察彼此的投票
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

  const votedCount = seers.filter(s => room.seerVotes[s.id]).length;
  if (votedCount === seers.length) {
    resolveSeerCheck(room);
  }
}

function resolveSeerCheck(room) {
  if (room.seerResolved) return;
  room.seerResolved = true;

  const tally = {};
  Object.values(room.seerVotes).forEach(v => { if(v) tally[v] = (tally[v]||0)+1; });
  const targetId = topVoted(tally);

  // 🔑 警察內部投票明細（只在警察頻道顯示）
  const seerVoteLines = [];
  room.players.filter(p => p.role === 'SEER').forEach(s => {
    if (room.seerVotes[s.id]) {
      seerVoteLines.push(`　${s.name} → ${nameOf(room, room.seerVotes[s.id])}`);
    }
  });

  room.players.filter(p => p.role === 'SEER' && !p.isAI).forEach(seer => {
    if (seerVoteLines.length > 1) {
      io.to(seer.id).emit('chat_message', {
        channel: 'POLICE', system: true,
        text: '📊 本次警察投票：\n' + seerVoteLines.join('\n')
      });
    }
  });

  if (!targetId) {
    systemMsg(room, '🔮 警察未達成共識，今晚沒有查驗結果。');
    return setTimeout(() => nextAfterSeer(room), 1200);
  }

  const target = room.players.find(p => p.id === targetId);
  const camp = (target.role === 'WEREWOLF' || target.role === 'SNIPER') ? 'WOLF' : 'GOOD';

  // 所有警察記錄結果
  room.players.filter(p => p.role === 'SEER').forEach(seer => {
    if (!room.seerChecks[seer.id]) room.seerChecks[seer.id] = {};
    room.seerChecks[seer.id][targetId] = camp;
  });

  // 廣播結果給所有警察
  room.players.filter(p => p.role === 'SEER' && !p.isAI).forEach(seer => {
    io.to(seer.id).emit('seer_result', {
      targetId: targetId,
      targetName: target.name,
      camp: camp,
      shared: true
    });
  });

  // AI 警察在頻道回應
  room.players.filter(p => p.role === 'SEER' && p.isAI).forEach(ai => {
    if (Math.random() < 0.5) {
      const text = camp === 'WOLF'
        ? `[${ai.name}] ${target.name} 是狼！`
        : `[${ai.name}] ${target.name} 是好人。`;
      room.players.filter(p => p.role === 'SEER' && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', { channel:'POLICE', system:true, text }));
    }
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
  return decideTarget(room, ai, 'WOLF_KILL');
}
function aiSeerPick(room, ai) { return decideTarget(room, ai, 'SEER_CHECK'); }
function aiDoctorPick(room, ai) { return decideTarget(room, ai, 'DOCTOR_HEAL'); }
function aiSniperPick(room, ai) { return decideTarget(room, ai, 'SNIPER_SHOOT'); }
function aiVotePick(room, ai) { return decideTarget(room, ai, 'VOTE'); }

// ============================================================
// 狼人統一邏輯 + 內部投票明細
// ============================================================
function checkWolfUnified(room) {
  const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
  if (!wolves.length) return;
  const votes = wolves.map(w => room.wolfVotes[w.id]);
  const votedCount = votes.filter(v => v).length;

  // 通知所有狼人彼此的投票（即時）
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

    // 🔑 狼人內部投票明細（只在狼人頻道顯示）
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
// AI 排程（含「AI 等待真人投票」機制）
// ============================================================
function scheduleAiActions(room, phase) {
  const ais = room.players.filter(p => p.isAI && p.alive);

  if (phase === 'DAY_DISCUSS') {
    ais.forEach((ai, idx) => {
      setTimeout(() => {
        if (room.phase !== 'DAY_DISCUSS' || !ai.alive) return;
        aiSpeak(room, ai);
      }, 3000 + idx*3000 + Math.random()*3000);
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

        // 🔑 如果有真人狼人隊友，AI 必須等待
        if (humanWolves.length > 0) {
          const humanVoted = humanWolves.filter(w => room.wolfVotes[w.id]);
          if (!humanVoted.length) {
            // 真人還沒投票 → 等待
            setTimeout(tryVote, 1500);
            return;
          }
          // 跟隨最早投票的真人
          const firstHuman = humanVoted[0];
          const targetId = room.wolfVotes[firstHuman.id];
          room.wolfVotes[ai.id] = targetId;
          aiWolfSpeak(room, ai, 'FOLLOW', nameOf(room, targetId), firstHuman.name);
          checkWolfUnified(room);
          return;
        }

        // 沒有真人狼人 → AI 自行決策
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

        // 🔑 如果有真人警察隊友，AI 必須等待
        if (humanSeers.length > 0) {
          const humanVoted = humanSeers.filter(s => room.seerVotes[s.id]);
          if (!humanVoted.length) {
            setTimeout(tryVote, 1500);
            return;
          }
          const firstHuman = humanVoted[0];
          const targetId = room.seerVotes[firstHuman.id];
          room.seerVotes[ai.id] = targetId;
          aiPoliceSpeak(room, ai, 'FOLLOW', nameOf(room, targetId));
          checkSeerUnified(room);
          return;
        }

        // 沒有真人警察 → AI 自行決策
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
    ais.forEach((ai, idx) => {
      setTimeout(() => {
        if (room.phase !== 'DAY_VOTE' || !ai.alive) return;
        if (room.votes[ai.id] !== undefined) return;
        const target = aiVotePick(room, ai);
        room.votes[ai.id] = target;
        io.to(room.roomId).emit('vote_updated', { votes: tallyVotes(room) });
        broadcastTeammateVotes(room);
        const aliveCount = room.players.filter(p => p.alive).length;
        if (Object.keys(room.votes).length >= aliveCount) {
          clearTimeout(room.timer);
          setTimeout(() => resolveVote(room), 800);
        }
      }, 3000 + idx*2500 + Math.random()*3000);
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
    data.wolfPartners = room.players
      .filter(p => p.role === 'WEREWOLF' && p.id !== player.id)
      .map(p => ({ id:p.id, name:p.name }));
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
    if (!room.seerResolved) {
      resolveSeerCheck(room);
      return;
    }
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

  room.players.forEach(p => {
    if (p.isAI) return;
    // 🔮 警察隊友
    let seerMates = [];
    if (p.role === 'SEER') {
      seerMates = room.players
        .filter(m => m.role === 'SEER' && m.id !== p.id)
        .map(m => ({ id:m.id, name:m.name, isAI:!!m.isAI }));
    }
    // 🐺 狼人同伴
    let wolfMates = [];
    if (p.role === 'WEREWOLF') {
      wolfMates = room.players
        .filter(m => m.role === 'WEREWOLF' && m.id !== p.id)
        .map(m => ({ id:m.id, name:m.name, isAI:!!m.isAI }));
    }
    io.to(p.id).emit('game_started', {
      myRole: p.role, players: publicPlayers(room), day: 0,
      doctorShots: room.doctorShotsLeft, sniperShots: room.sniperShotsLeft,
      seerMates: seerMates,
      wolfMates: wolfMates,
    });
  });
  setTimeout(() => beginNight(room), 3500);
}

function beginNight(room) {
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

  // 🔑 公開所有投票明細
  const lines = [];
  Object.keys(room.votes).forEach(voterId => {
    const targetId = room.votes[voterId];
    const voterName = nameOf(room, voterId);
    const targetName = targetId ? nameOf(room, targetId) : '（棄票）';
    lines.push(`　${voterName} → ${targetName}`);
  });
  if (lines.length) {
    systemMsg(room, '📊 投票明細：\n' + lines.join('\n'));
  }

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
    io.to(room.roomId).emit('game_over', {
      winner, reason,
      players: room.players.map(p => ({ id:p.id, name:p.name, alive:p.alive, isHost:p.isHost, isAI:!!p.isAI, role:p.role })),
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
      recentPublicChat:[], speakCount:{}, timer:null, endsAt:null,
    };
    room.players.push({ id:socket.id, name:nickname, alive:true, isHost:true, role:null, isAI:false, canSpeakInPublic:false });
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

    room.players.push({ id:socket.id, name:nickname, alive:true, isHost:false, role:null, isAI:false, canSpeakInPublic:false });
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
      canSpeakInPublic:false, personality
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
    room.recentPublicChat = []; room.speakCount = {};
    room.players.forEach(p => { p.alive = true; p.role = null; p.deathCause = null; p.canSpeakInPublic = false; });
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

    // 🔑 AI 狼人立即跟隨人類的決定，並在頻道通知
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

  // 🔮 警察投票查驗
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

    // 🔑 AI 警察立即跟隨人類的決定
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
    io.to(room.roomId).emit('vote_updated', { votes: tallyVotes(room) });
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
      return;
    }

    const msg = { channel, from:me.name, text };

    if (channel === 'PUBLIC') {
      recordPublicChat(room, me.name, text);
      trackSpeak(room, me.id);
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
