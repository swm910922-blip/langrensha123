// ============================================================
// 狼人殺後端（AI 讀聊天 + 死亡公布身分 + 陣營投票可見 + AI 跟隨人類狼人）
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
  NIGHT_WOLF: 30, NIGHT_SEER: 20, NIGHT_DOCTOR: 20, NIGHT_SNIPER: 20,
  DAY_ANNOUNCE: 10, DAY_DISCUSS: 60, DAY_VOTE: 30,
};

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
function announceDeath(room, player, cause) {
  const causeText = { WOLF:'被狼人殺害', SNIPER:'被狙擊手擊殺', VOTE:'被投票放逐', DOCTOR:'被醫生的空針毒死', DISCONNECT:'離線' }[cause] || '出局';
  systemMsg(room, `💀 ${player.name} ${causeText}，他的身分是【${roleName(player.role)}】`);
}

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
// 🧠 AI 情報收集（讀聊天）
// ============================================================
function processChatForAI(room, speakerId, text) {
  const speaker = room.players.find(p => p.id === speakerId);
  if (!speaker) return;
  const ais = room.players.filter(p => p.isAI);

  const claimsSeer = /我是預言家|我是警察|我查過|查驗過|我是預言/.test(text);
  if (claimsSeer) {
    ais.forEach(ai => {
      if (ai.id === speakerId) return;
      if (!room.aiIntel[ai.id]) room.aiIntel[ai.id] = {};
      room.aiIntel[ai.id].claimedSeer = speakerId;
      if (ai.role === 'WEREWOLF') room.aiIntel[ai.id].priorityKill = speakerId;
    });
  }

  const isAccusing = /是狼|是壞人|是邪惡|是殺手|他在騙|他在說謊|懷疑/.test(text);
  if (isAccusing) {
    room.players.forEach(target => {
      if (target.id === speakerId) return;
      if (!text.includes(target.name)) return;
      ais.forEach(ai => {
        if (ai.id === speakerId || ai.id === target.id) return;
        if (!room.aiIntel[ai.id]) room.aiIntel[ai.id] = {};
        if (!room.aiIntel[ai.id].suspicion) room.aiIntel[ai.id].suspicion = {};
        room.aiIntel[ai.id].suspicion[target.id] = (room.aiIntel[ai.id].suspicion[target.id] || 0) + 1;
      });
    });
  }

  const isClearing = /是好人|是平民|是正義|我相信|他是好人/.test(text);
  if (isClearing) {
    room.players.forEach(target => {
      if (target.id === speakerId) return;
      if (!text.includes(target.name)) return;
      ais.forEach(ai => {
        if (ai.id === speakerId) return;
        if (!room.aiIntel[ai.id]) room.aiIntel[ai.id] = {};
        if (!room.aiIntel[ai.id].trusted) room.aiIntel[ai.id].trusted = {};
        room.aiIntel[ai.id].trusted[target.id] = true;
      });
    });
  }
}

// ============================================================
// AI 決策
// ============================================================
const AI_NAMES = ['小狼','阿智','阿呆','小紅','阿明','阿豪','小玉','大頭','阿芬','老張','小陳','阿傑','阿宏','小如','阿文','小婷','阿伯','小胖'];
function genAiId(room) { let i=1; while(room.players.find(p=>p.id==='ai_'+i)) i++; return 'ai_'+i; }

// 🔑 AI 狼人：優先跟隨人類狼人
function aiWolfPick(room, ai) {
  const intel = room.aiIntel[ai.id] || {};
  const targets = room.players.filter(p => p.alive && p.id !== ai.id && p.role !== 'WEREWOLF' && p.role !== 'SNIPER');
  if (!targets.length) {
    const fb = room.players.filter(p => p.alive && p.id !== ai.id);
    return fb.length ? fb[Math.floor(Math.random()*fb.length)].id : null;
  }

  const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
  const humanWolves = wolves.filter(w => !w.isAI);
  const humanVotes = humanWolves.filter(w => room.wolfVotes[w.id]).map(w => room.wolfVotes[w.id]);
  if (humanVotes.length) return humanVotes[0];

  if (intel.priorityKill) {
    const pk = targets.find(t => t.id === intel.priorityKill);
    if (pk && Math.random() < 0.85) return pk.id;
  }

  const otherAiVotes = wolves.filter(w => w.isAI && w.id !== ai.id && room.wolfVotes[w.id]).map(w => room.wolfVotes[w.id]);
  if (otherAiVotes.length) return otherAiVotes[0];

  const seer = targets.find(p => p.role === 'SEER');
  if (seer && Math.random() < 0.6) return seer.id;
  return targets[Math.floor(Math.random()*targets.length)].id;
}

function aiSeerPick(room, ai) {
  const checked = room.seerChecks[ai.id] || {};
  const intel = room.aiIntel[ai.id] || {};
  const targets = room.players.filter(p => p.alive && p.id !== ai.id && !checked[p.id]);
  if (!targets.length) return null;
  if (intel.suspicion) {
    const suspects = targets.filter(t => intel.suspicion[t.id]);
    if (suspects.length && Math.random() < 0.7) return suspects[Math.floor(Math.random()*suspects.length)].id;
  }
  return targets[Math.floor(Math.random()*targets.length)].id;
}

function aiDoctorPick(room, ai) {
  if (Math.random() < 0.5 && ai.alive) return ai.id;
  const targets = room.players.filter(p => p.alive);
  if (!targets.length) return null;
  return targets[Math.floor(Math.random()*targets.length)].id;
}

function aiSniperPick(room, ai) {
  const intel = room.aiIntel[ai.id] || {};
  const targets = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!targets.length) return null;
  if (intel.claimedSeer) {
    const t = targets.find(x => x.id === intel.claimedSeer);
    if (t && Math.random() < 0.5) return t.id;
  }
  return targets[Math.floor(Math.random()*targets.length)].id;
}

function aiVotePick(room, ai) {
  const intel = room.aiIntel[ai.id] || {};
  const targets = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!targets.length) return null;

  if (ai.role === 'SEER') {
    const checked = room.seerChecks[ai.id] || {};
    const knownWolf = targets.find(p => checked[p.id] === 'WOLF');
    if (knownWolf) return knownWolf.id;
  }

  if (ai.role !== 'WEREWOLF' && ai.role !== 'SNIPER' && intel.suspicion) {
    const suspects = targets.filter(t => intel.suspicion[t.id] && !intel.trusted?.[t.id]);
    if (suspects.length && Math.random() < 0.65) {
      suspects.sort((a,b) => (intel.suspicion[b.id]||0) - (intel.suspicion[a.id]||0));
      return suspects[0].id;
    }
  }

  if ((ai.role === 'WEREWOLF' || ai.role === 'SNIPER') && intel.claimedSeer) {
    const t = targets.find(x => x.id === intel.claimedSeer);
    if (t && Math.random() < 0.6) return t.id;
  }

  const current = tallyVotes(room);
  const top = topVoted(current);
  if (top && targets.find(t => t.id === top)) return top;

  return targets[Math.floor(Math.random()*targets.length)].id;
}

function aiSpeak(room, ai) {
  const intel = room.aiIntel[ai.id] || {};
  const templates = {
    WEREWOLF: ['我是平民，請相信我。', '昨晚我很安靜，因為我在觀察。', '我們先聽聽其他人的推理吧。'],
    SNIPER: ['我是平民。', '我懷疑昨晚發言最少的人。', '我們應該冷靜推理。'],
    SEER: ['我是預言家，我查過人了。', '請大家相信我。', '我昨晚看到了一些東西。'],
    DOCTOR: ['我是醫生，我救了人。', '請保護好預言家。'],
    VILLAGER: ['我是平民。', '我懷疑昨晚發言最少的人。', '誰一直沒說話？這很可疑。', '我覺得狼人現在應該很緊張。'],
  };
  let pool = templates[ai.role] || templates.VILLAGER;

  if (intel.suspicion && (ai.role === 'VILLAGER' || ai.role === 'SEER' || ai.role === 'DOCTOR')) {
    const suspects = Object.entries(intel.suspicion).sort((a,b) => b[1]-a[1]);
    if (suspects.length) {
      const suspectName = nameOf(room, suspects[0][0]);
      pool = [`我覺得 ${suspectName} 很可疑。`, `我懷疑 ${suspectName} 是狼人。`, `${suspectName} 的發言有點怪。`];
    }
  }
  if (ai.role === 'WEREWOLF' && intel.claimedSeer) {
    const seerName = nameOf(room, intel.claimedSeer);
    pool = [`我覺得 ${seerName} 在說謊。`, `${seerName} 可能是狼人假裝預言家。`, `別信 ${seerName}，他很可疑。`];
  }
  const text = pool[Math.floor(Math.random()*pool.length)];
  io.to(room.roomId).emit('chat_message', { channel:'PUBLIC', from:ai.name, text });
}

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
    votes.forEach(v => { if(v) tally[v] = (tally[v]||0)+1; });
    room.wolfTarget = topVoted(tally);
    setPhase(room, 'NIGHT_SEER');
  }
}

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
    ais.filter(p => p.role === 'WEREWOLF').forEach((ai, idx) => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_WOLF' || !ai.alive) return;
        const humanWolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive && !p.isAI);
        const humanVoted = humanWolves.some(w => room.wolfVotes[w.id]);
        if (humanVoted) {
          const firstHumanVote = humanWolves.find(w => room.wolfVotes[w.id]);
          if (firstHumanVote) room.wolfVotes[ai.id] = room.wolfVotes[firstHumanVote.id];
          checkWolfUnified(room);
          return;
        }
        const target = aiWolfPick(room, ai);
        if (!target) return;
        room.wolfVotes[ai.id] = target;
        checkWolfUnified(room);
      }, 2500 + idx*3000 + Math.random()*3000);
    });
  }
  if (phase === 'NIGHT_SEER') {
    ais.filter(p => p.role === 'SEER').forEach(ai => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_SEER' || !ai.alive) return;
        const target = aiSeerPick(room, ai);
        if (!target) return;
        if (!room.seerChecks[ai.id]) room.seerChecks[ai.id] = {};
        const t = room.players.find(p => p.id === target);
        room.seerChecks[ai.id][target] = (t.role === 'WEREWOLF' || t.role === 'SNIPER') ? 'WOLF' : 'GOOD';
      }, 2000 + Math.random()*4000);
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
      if (room.votes[m.id]) {
        mateVotes[m.id] = { name:m.name, targetName: nameOf(room, room.votes[m.id]) };
      }
    });
    io.to(p.id).emit('teammate_votes', { stage:'DAY_VOTE', votes: mateVotes, role: p.role });
  });
}

function judgeSpeech(room, phase) {
  const d = room.day;
  switch (phase) {
    case 'NIGHT_WOLF':   return `天黑請閉眼。第 ${d} 夜，狼人請睜眼。`;
    case 'NIGHT_SEER':   return '狼人請閉眼。警察請睜眼，請查驗一名玩家。';
    case 'NIGHT_DOCTOR': return '警察請閉眼。醫生請睜眼，請選擇施針對象。';
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
  if (phase === 'NIGHT_SEER')   return nextAfterSeer(room);
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

function startGame(room) {
  const n = room.players.length;
  const roles = assignRoles(n);
  room.players.forEach((p, i) => { p.alive = true; p.role = roles[i]; p.deathCause = null; });

  room.day = 0;
  room.seerChecks = {};
  room.wolfVotes = {};
  room.wolfTarget = null;
  room.votes = {};
  room.pendingDeaths = [];
  room.doctorTarget = null;
  room.sniperTarget = null;
  room.doctorShotsLeft = doctorShotsFor(n);
  room.sniperShotsLeft = sniperShotsFor(n);
  room.emptyShotCount = {};
  room.aiIntel = {};

  room.players.forEach(p => {
    if (p.isAI) return;
    io.to(p.id).emit('game_started', {
      myRole: p.role, players: publicPlayers(room), day: 0,
      doctorShots: room.doctorShotsLeft, sniperShots: room.sniperShotsLeft,
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
      if (p && p.alive) { p.alive = false; p.deathCause = 'WOLF'; deaths.push({ id:p.id, name:p.name }); }
    }
  }
  if (sniperTarget) {
    const p = room.players.find(x => x.id === sniperTarget);
    if (p && p.alive) { p.alive = false; p.deathCause = 'SNIPER'; deaths.push({ id:p.id, name:p.name }); }
  }
  if (doctorTarget && room.doctorShotsLeft > 0) {
    room.doctorShotsLeft -= 1;
    const saved = (doctorTarget === wolfTarget);
    const sniperKilled = (doctorTarget === sniperTarget);
    if (!saved && !sniperKilled) {
      room.emptyShotCount[doctorTarget] = (room.emptyShotCount[doctorTarget] || 0) + 1;
      if (room.emptyShotCount[doctorTarget] >= 2) {
        const p = room.players.find(x => x.id === doctorTarget);
        if (p && p.alive) { p.alive = false; p.deathCause = 'DOCTOR'; deaths.push({ id:p.id, name:p.name }); }
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
  const t = tallyVotes(room);
  let max = 0, top = [];
  Object.keys(t).forEach(id => {
    if (t[id] > max) { max = t[id]; top = [id]; }
    else if (t[id] === max) top.push(id);
  });

  if (top.length !== 1 || max === 0) {
    systemMsg(room, '平票或全體棄票，本輪無人出局。');
    return beginNight(room);
  }
  const outId = top[0];
  const p = room.players.find(x => x.id === outId);
  if (p && p.alive) {
    p.alive = false;
    p.deathCause = 'VOTE';
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
  }
  if (room.players.length === 0) { clearTimeout(room.timer); rooms.delete(roomId); return; }
  if (room.hostId === removed.id) {
    const nextHost = room.players.find(p => !p.isAI);
    if (nextHost) { room.hostId = nextHost.id; room.players.forEach(p => p.isHost=false); nextHost.isHost = true; }
    else { room.hostId = room.players[0].id; room.players[0].isHost = true; }
  }
  emitRoomState(room);
}

io.on('connection', socket => {
  console.log('[+] connected:', socket.id);

  socket.on('create_room', (payload, cb) => {
    const nickname = String((payload && payload.nickname) || '').trim().slice(0,12);
    const len = (payload && payload.roomIdLength === 4) ? 4 : 6;
    if (!nickname) return cb && cb({ ok:false, error:'暱稱不可為空' });

    const roomId = genRoomId(len);
    const room = {
      roomId, hostId:socket.id, phase:'LOBBY', day:0, players:[],
      wolfVotes:{}, wolfTarget:null, seerChecks:{}, votes:{}, pendingDeaths:[],
      doctorTarget:null, sniperTarget:null, doctorShotsLeft:0, sniperShotsLeft:0,
      emptyShotCount:{}, aiIntel:{}, timer:null, endsAt:null,
    };
    room.players.push({ id:socket.id, name:nickname, alive:true, isHost:true, role:null, isAI:false });
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

    room.players.push({ id:socket.id, name:nickname, alive:true, isHost:false, role:null, isAI:false });
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

    room.players.push({ id:genAiId(room), name, alive:true, isHost:false, role:null, isAI:true });
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
    room.seerChecks = {}; room.pendingDeaths = [];
    room.doctorTarget = null; room.sniperTarget = null; room.emptyShotCount = {};
    room.aiIntel = {};
    room.players.forEach(p => { p.alive = true; p.role = null; p.deathCause = null; });
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

    // 🔑 AI 狼人立即跟隨人類的決定
    const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
    wolves.filter(w => w.isAI).forEach(ai => {
      room.wolfVotes[ai.id] = targetId;
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
    const targetId = payload && payload.targetId;
    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target || target.id === me.id) return;
    if (!room.seerChecks[me.id]) room.seerChecks[me.id] = {};
    const camp = (target.role === 'WEREWOLF' || target.role === 'SNIPER') ? 'WOLF' : 'GOOD';
    room.seerChecks[me.id][target.id] = camp;
    io.to(me.id).emit('seer_result', { targetId:target.id, targetName:target.name, camp });
    io.to(me.id).emit('phase_changed', phasePayload(room, me, ''));
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
    const msg = { channel, from:me.name, text };

    if (channel === 'PUBLIC') processChatForAI(room, me.id, text);

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
