// ============================================================
// 狼人殺後端主程式（無女巫 + AI 玩家）
// ============================================================
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.send('🐺 狼人殺伺服器運作中');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = new Map();

const PHASE_SECONDS = {
  NIGHT_WOLF: 30,
  NIGHT_SEER: 20,
  DAY_ANNOUNCE: 10,
  DAY_DISCUSS: 60,
  DAY_VOTE: 30,
  HUNTER_SHOOT: 25,
};

// ============================================================
// 工具函式
// ============================================================
function genRoomId(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do {
    id = '';
    for (let i = 0; i < len; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(id));
  return id;
}

function nameOf(room, id) {
  const p = room.players.find(x => x.id === id);
  return p ? p.name : '未知';
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isHost: p.isHost,
    isAI: !!p.isAI,
  }));
}

function roomPayload(room) {
  return {
    roomId: room.roomId,
    players: publicPlayers(room),
    phase: room.phase,
  };
}

function broadcastPlayers(room) {
  io.to(room.roomId).emit('players_updated', { players: publicPlayers(room) });
}

function emitRoomState(room) {
  io.to(room.roomId).emit('room_updated', roomPayload(room));
}

function tallyVotes(room) {
  const t = {};
  Object.values(room.votes).forEach(v => {
    if (v) t[v] = (t[v] || 0) + 1;
  });
  return t;
}

function systemMsg(room, text) {
  io.to(room.roomId).emit('chat_message', {
    channel: 'PUBLIC', system: true, text: text
  });
}

// ============================================================
// 角色分配（無女巫）
// ============================================================
function assignRoles(n) {
  const table = {
    6:  { WEREWOLF: 2, SEER: 1, HUNTER: 1, VILLAGER: 2 },
    7:  { WEREWOLF: 2, SEER: 1, HUNTER: 1, VILLAGER: 3 },
    8:  { WEREWOLF: 2, SEER: 1, HUNTER: 1, VILLAGER: 4 },
    9:  { WEREWOLF: 3, SEER: 1, HUNTER: 1, VILLAGER: 4 },
    10: { WEREWOLF: 3, SEER: 1, HUNTER: 1, VILLAGER: 5 },
    11: { WEREWOLF: 3, SEER: 1, HUNTER: 1, VILLAGER: 6 },
    12: { WEREWOLF: 4, SEER: 1, HUNTER: 1, VILLAGER: 6 },
  };
  const cfg = table[n] || table[6];
  const pool = [];
  Object.keys(cfg).forEach(role => {
    for (let i = 0; i < cfg[role]; i++) pool.push(role);
  });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool;
}

// ============================================================
// AI 玩家邏輯
// ============================================================
const AI_NAMES = ['小狼', '阿智', '阿呆', '小紅', '阿明', '阿豪', '小玉', '大頭', '阿芬', '老張', '小陳', '阿傑'];

function genAiId(room) {
  let i = 1;
  while (room.players.find(p => p.id === 'ai_' + i)) i++;
  return 'ai_' + i;
}

function aiWolfPick(room, ai) {
  const targets = room.players.filter(p =>
    p.alive && p.id !== ai.id && p.role !== 'WEREWOLF'
  );
  if (!targets.length) return null;

  const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
  const otherVotes = wolves
    .filter(w => w.id !== ai.id && room.wolfVotes[w.id])
    .map(w => room.wolfVotes[w.id]);
  if (otherVotes.length && Math.random() < 0.6) {
    return otherVotes[0];
  }
  const seer = targets.find(p => p.role === 'SEER');
  if (seer && Math.random() < 0.7) return seer.id;
  return targets[Math.floor(Math.random() * targets.length)].id;
}

function aiSeerPick(room, ai) {
  const checked = room.seerChecks[ai.id] || {};
  const targets = room.players.filter(p =>
    p.alive && p.id !== ai.id && !checked[p.id]
  );
  if (!targets.length) return null;
  return targets[Math.floor(Math.random() * targets.length)].id;
}

function aiVotePick(room, ai) {
  const targets = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!targets.length) return null;

  if (ai.role !== 'WEREWOLF') {
    const checked = room.seerChecks[ai.id] || {};
    const knownWolf = targets.find(p => checked[p.id] === 'WOLF');
    if (knownWolf) return knownWolf.id;
    const current = tallyVotes(room);
    let max = 0, top = null;
    Object.keys(current).forEach(id => {
      if (current[id] > max && targets.find(t => t.id === id)) {
        max = current[id]; top = id;
      }
    });
    if (top) return top;
  }

  if (ai.role === 'WEREWOLF') {
    const good = targets.filter(p => p.role !== 'WEREWOLF');
    if (good.length) return good[Math.floor(Math.random() * good.length)].id;
  }
  return targets[Math.floor(Math.random() * targets.length)].id;
}

function aiHunterPick(room, ai) {
  const targets = room.players.filter(p => p.alive && p.id !== ai.id);
  if (!targets.length) return null;
  if (Math.random() < 0.3) return null;
  const checked = room.seerChecks[ai.id] || {};
  const knownWolf = targets.find(p => checked[p.id] === 'WOLF');
  if (knownWolf) return knownWolf.id;
  return targets[Math.floor(Math.random() * targets.length)].id;
}

function aiSpeak(room, ai) {
  const templates = {
    WEREWOLF: [
      '我是平民，請相信我。',
      '昨晚我很安靜，因為我在觀察。',
      '我覺得應該從最沉默的人開始懷疑。',
      '我們先聽聽其他人的推理吧。',
      '我覺得預言家要小心，不要被騙。',
    ],
    SEER: [
      '我是預言家，我查過人了。',
      '請大家相信我，我是好人陣營的。',
      '我昨晚看到了一些東西，但要小心狼人說謊。',
      '我是預言家，大家可以問我查驗結果。',
    ],
    HUNTER: [
      '我是獵人，如果你們投我，我會開槍的。',
      '我是好人，請不要浪費票在我身上。',
      '我有槍，狼人最好小心點。',
    ],
    VILLAGER: [
      '我是平民，沒有特殊技能。',
      '我懷疑昨晚發言最少的人。',
      '我們應該冷靜推理，不要亂投。',
      '我覺得第一輪先聽大家的想法。',
      '誰一直沒說話？這很可疑。',
      '我覺得狼人現在應該很緊張。',
    ],
  };
  const pool = templates[ai.role] || templates.VILLAGER;
  const text = pool[Math.floor(Math.random() * pool.length)];
  io.to(room.roomId).emit('chat_message', {
    channel: 'PUBLIC', from: ai.name, text: text
  });
}

function checkWolfUnified(room) {
  const wolves = room.players.filter(p => p.role === 'WEREWOLF' && p.alive);
  const votes = wolves.map(w => room.wolfVotes[w.id]);
  const allVoted = votes.every(v => v);
  const unified = allVoted && votes.every(v => v === votes[0]);

  if (unified) {
    room.wolfTarget = votes[0];
    setPhase(room, 'NIGHT_SEER');
  } else {
    wolves.forEach(w => {
      if (!w.isAI) {
        io.to(w.id).emit('phase_changed', phasePayload(room, w, ''));
      }
    });
  }
}

function scheduleAiActions(room, phase) {
  const ais = room.players.filter(p => p.isAI && p.alive);

  if (phase === 'DAY_DISCUSS') {
    ais.forEach((ai, idx) => {
      const delay = 3000 + idx * 3500 + Math.random() * 3000;
      setTimeout(() => {
        if (room.phase !== 'DAY_DISCUSS') return;
        if (!ai.alive) return;
        aiSpeak(room, ai);
      }, delay);
    });
  }

  if (phase === 'NIGHT_WOLF') {
    const aiWolves = ais.filter(p => p.role === 'WEREWOLF');
    aiWolves.forEach((ai, idx) => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_WOLF') return;
        if (!ai.alive) return;
        const target = aiWolfPick(room, ai);
        if (!target) return;
        room.wolfVotes[ai.id] = target;
        checkWolfUnified(room);
      }, 2500 + idx * 3000 + Math.random() * 3000);
    });
  }

  if (phase === 'NIGHT_SEER') {
    const aiSeers = ais.filter(p => p.role === 'SEER');
    aiSeers.forEach(ai => {
      setTimeout(() => {
        if (room.phase !== 'NIGHT_SEER') return;
        if (!ai.alive) return;
        const target = aiSeerPick(room, ai);
        if (!target) return;
        if (!room.seerChecks[ai.id]) room.seerChecks[ai.id] = {};
        const t = room.players.find(p => p.id === target);
        room.seerChecks[ai.id][target] = t.role === 'WEREWOLF' ? 'WOLF' : 'GOOD';
      }, 2000 + Math.random() * 4000);
    });
  }

  if (phase === 'DAY_VOTE') {
    ais.forEach((ai, idx) => {
      setTimeout(() => {
        if (room.phase !== 'DAY_VOTE') return;
        if (!ai.alive) return;
        if (room.votes[ai.id] !== undefined) return;
        const target = aiVotePick(room, ai);
        room.votes[ai.id] = target;
        io.to(room.roomId).emit('vote_updated', { votes: tallyVotes(room) });

        const aliveCount = room.players.filter(p => p.alive).length;
        const votedCount = Object.keys(room.votes).length;
        if (votedCount >= aliveCount) {
          clearTimeout(room.timer);
          setTimeout(() => resolveVote(room), 800);
        }
      }, 3000 + idx * 2500 + Math.random() * 3000);
    });
  }

  if (phase === 'HUNTER_SHOOT') {
    const hunter = room.players.find(p => p.id === room.hunterId);
    if (hunter && hunter.isAI) {
      setTimeout(() => {
        if (room.phase !== 'HUNTER_SHOOT') return;
        const target = aiHunterPick(room, hunter);
        hunterShoot(room, target);
      }, 3000 + Math.random() * 3000);
    }
  }
}

// ============================================================
// 法官台詞
// ============================================================
function judgeSpeech(room, phase) {
  const d = room.day;
  switch (phase) {
    case 'NIGHT_WOLF':  return '天黑請閉眼。第 ' + d + ' 夜，狼人請睜眼，請選擇今晚要刺殺的對象。';
    case 'NIGHT_SEER':  return '狼人請閉眼。預言家請睜眼，請選擇一名玩家查驗身分。';
    case 'DAY_ANNOUNCE': {
      if (!room.pendingDeaths.length) return '天亮了。第 ' + d + ' 天，昨晚是平安夜。';
      return '天亮了。昨晚，' + room.pendingDeaths.map(x => x.name).join('、') + ' 倒牌了。';
    }
    case 'DAY_DISCUSS': return '現在進入白天討論，請所有玩家依序發言。';
    case 'DAY_VOTE':    return '發言結束，請所有玩家投票，選出你要放逐的對象。';
    case 'HUNTER_SHOOT': return '獵人請睜眼，你有一槍，是否要帶走一名玩家？';
    case 'GAME_OVER':   return '遊戲結束。';
    default:            return '';
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
      .map(p => ({ id: p.id, name: p.name }));
  }

  if (room.phase === 'NIGHT_SEER' && player.role === 'SEER' && player.alive) {
    data.selectableIds = aliveOthers;
    data.checks = room.seerChecks[player.id] || {};
  }

  if (room.phase === 'DAY_VOTE' && player.alive) {
    data.selectableIds = aliveOthers;
  }

  if (room.phase === 'HUNTER_SHOOT') {
    data.hunterId = room.hunterId;
    if (player.id === room.hunterId) data.selectableIds = aliveOthers;
  }

  if (room.phase === 'DAY_ANNOUNCE') {
    data.deaths = room.pendingDeaths;
  }

  return {
    phase: room.phase,
    day: room.day,
    endsAt: room.endsAt,
    data: data,
    votes: tallyVotes(room),
    speech: { text: speechText || '' },
  };
}

function setPhase(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;

  const sec = PHASE_SECONDS[phase] || 20;
  room.endsAt = Date.now() + sec * 1000;

  if (phase === 'DAY_VOTE') room.votes = {};

  const speech = judgeSpeech(room, phase);

  room.players.forEach(p => {
    if (p.isAI) return;
    io.to(p.id).emit('phase_changed', phasePayload(room, p, speech));
  });

  scheduleAiActions(room, phase);

  room.timer = setTimeout(() => onPhaseTimeout(room, phase), sec * 1000 + 500);
}

function onPhaseTimeout(room, phase) {
  if (room.phase !== phase) return;

  if (phase === 'NIGHT_WOLF')      return setPhase(room, 'NIGHT_SEER');
  if (phase === 'NIGHT_SEER')      return resolveNight(room);
  if (phase === 'DAY_ANNOUNCE')    return afterAnnounce(room);
  if (phase === 'DAY_DISCUSS')     return setPhase(room, 'DAY_VOTE');
  if (phase === 'DAY_VOTE')        return resolveVote(room);
  if (phase === 'HUNTER_SHOOT')    return hunterShoot(room, null);
}

// ============================================================
// 遊戲流程
// ============================================================
function startGame(room) {
  const roles = assignRoles(room.players.length);
  room.players.forEach((p, i) => {
    p.alive = true;
    p.role = roles[i];
    p.deathCause = null;
    p.hunterUsed = false;
  });

  room.day = 0;
  room.seerChecks = {};
  room.wolfVotes = {};
  room.wolfTarget = null;
  room.votes = {};
  room.pendingDeaths = [];
  room.hunterId = null;
  room.hunterNext = null;

  room.players.forEach(p => {
    if (p.isAI) return;
    io.to(p.id).emit('game_started', {
      myRole: p.role,
      players: publicPlayers(room),
      day: 0,
    });
  });

  setTimeout(() => beginNight(room), 3500);
}

function beginNight(room) {
  room.day += 1;
  room.wolfVotes = {};
  room.wolfTarget = null;
  room.pendingDeaths = [];
  room.hunterId = null;
  setPhase(room, 'NIGHT_WOLF');
}

function resolveNight(room) {
  const deaths = [];

  if (room.wolfTarget) {
    const p = room.players.find(x => x.id === room.wolfTarget);
    if (p && p.alive) {
      p.alive = false;
      p.deathCause = 'WOLF';
      deaths.push({ id: p.id, name: p.name });
    }
  }

  room.pendingDeaths = deaths;
  room.wolfTarget = null;

  broadcastPlayers(room);
  if (checkWin(room)) return;
  setPhase(room, 'DAY_ANNOUNCE');
}

function afterAnnounce(room) {
  const hunter = room.players.find(
    p => p.role === 'HUNTER' && !p.alive && p.deathCause === 'WOLF' && !p.hunterUsed
  );
  if (hunter) {
    hunter.hunterUsed = true;
    room.hunterId = hunter.id;
    room.hunterNext = 'DAY_DISCUSS';
    return setPhase(room, 'HUNTER_SHOOT');
  }
  setPhase(room, 'DAY_DISCUSS');
}

function resolveVote(room) {
  if (room.phase !== 'DAY_VOTE') return;

  const t = tallyVotes(room);
  let max = 0;
  let top = [];
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
    systemMsg(room, p.name + ' 被投票放逐出局。');
  }

  if (checkWin(room)) return;

  if (p && p.role === 'HUNTER' && !p.hunterUsed) {
    p.hunterUsed = true;
    room.hunterId = p.id;
    room.hunterNext = 'NIGHT_WOLF';
    return setPhase(room, 'HUNTER_SHOOT');
  }
  beginNight(room);
}

function hunterShoot(room, targetId) {
  if (targetId) {
    const t = room.players.find(x => x.id === targetId && x.alive);
    if (t) {
      t.alive = false;
      t.deathCause = 'HUNTER';
      broadcastPlayers(room);
      systemMsg(room, '獵人開槍帶走了 ' + t.name + '！');
    }
  } else {
    systemMsg(room, '獵人放棄開槍。');
  }

  room.hunterId = null;
  if (checkWin(room)) return;

  const next = room.hunterNext || 'NIGHT_WOLF';
  room.hunterNext = null;
  if (next === 'NIGHT_WOLF') beginNight(room);
  else setPhase(room, 'DAY_DISCUSS');
}

// ============================================================
// 勝負判定
// ============================================================
function checkWin(room) {
  if (room.phase === 'GAME_OVER') return true;

  const alive = room.players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === 'WEREWOLF');
  const villagers = alive.filter(p => p.role === 'VILLAGER');
  const gods = alive.filter(p => ['SEER', 'HUNTER'].indexOf(p.role) >= 0);

  let winner = null;
  let reason = '';

  if (wolves.length === 0) {
    winner = 'GOOD'; reason = '所有狼人已出局，好人陣營勝利！';
  } else if (villagers.length === 0) {
    winner = 'WOLF'; reason = '所有平民出局（屠民），狼人陣營勝利！';
  } else if (gods.length === 0) {
    winner = 'WOLF'; reason = '所有神職出局（屠神），狼人陣營勝利！';
  } else if (wolves.length >= alive.length - wolves.length) {
    winner = 'WOLF'; reason = '狼人數量已不低於好人，狼人陣營勝利！';
  }

  if (winner) {
    clearTimeout(room.timer);
    room.phase = 'GAME_OVER';
    io.to(room.roomId).emit('game_over', {
      winner: winner,
      reason: reason,
      players: room.players.map(p => ({
        id: p.id, name: p.name, alive: p.alive, isHost: p.isHost,
        isAI: !!p.isAI, role: p.role,
      })),
    });
    return true;
  }
  return false;
}

// ============================================================
// 離房處理
// ============================================================
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
    systemMsg(room, removed.name + ' 已離線。');
    if (checkWin(room)) return;
  }

  if (room.players.length === 0) {
    clearTimeout(room.timer);
    rooms.delete(roomId);
    return;
  }

  if (room.hostId === removed.id) {
    const nextHost = room.players.find(p => !p.isAI);
    if (nextHost) {
      room.hostId = nextHost.id;
      room.players.forEach(p => p.isHost = false);
      nextHost.isHost = true;
    } else {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }
  }

  emitRoomState(room);
}

// ============================================================
// Socket 連線事件
// ============================================================
io.on('connection', socket => {
  console.log('[+] connected:', socket.id);

  socket.on('create_room', (payload, cb) => {
    const nickname = String((payload && payload.nickname) || '').trim().slice(0, 12);
    const len = (payload && payload.roomIdLength === 4) ? 4 : 6;
    if (!nickname) return cb && cb({ ok: false, error: '暱稱不可為空' });

    const roomId = genRoomId(len);
    const room = {
      roomId: roomId,
      hostId: socket.id,
      phase: 'LOBBY',
      day: 0,
      players: [],
      wolfVotes: {},
      wolfTarget: null,
      seerChecks: {},
      votes: {},
      pendingDeaths: [],
      timer: null,
      endsAt: null,
      hunterId: null,
      hunterNext: null,
    };
    room.players.push({
      id: socket.id, name: nickname, alive: true, isHost: true,
      role: null, isAI: false,
    });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;

    if (cb) cb({ ok: true, roomId: roomId });
    socket.emit('room_created', roomPayload(room));
  });

  socket.on('join_room', (payload, cb) => {
    const nickname = String((payload && payload.nickname) || '').trim().slice(0, 12);
    const roomId = String((payload && payload.roomId) || '').trim().toUpperCase();

    if (!nickname) return cb && cb({ ok: false, error: '暱稱不可為空' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: '找不到房間' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok: false, error: '遊戲已開始' });
    if (room.players.length >= 12) return cb && cb({ ok: false, error: '房間已滿' });
    if (room.players.some(p => p.name === nickname))
      return cb && cb({ ok: false, error: '暱稱已被使用' });

    room.players.push({
      id: socket.id, name: nickname, alive: true, isHost: false,
      role: null, isAI: false,
    });
    socket.join(roomId);
    socket.data.roomId = roomId;

    if (cb) cb({ ok: true });
    socket.emit('room_joined', roomPayload(room));
    emitRoomState(room);
    systemMsg(room, nickname + ' 加入了房間。');
  });

  socket.on('add_ai_player', (payload, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok: false, error: '房間不存在' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可以新增 AI' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok: false, error: '遊戲已開始' });
    if (room.players.length >= 12) return cb && cb({ ok: false, error: '房間已滿' });

    const usedNames = room.players.map(p => p.name);
    let name = AI_NAMES.find(n => !usedNames.includes(n));
    if (!name) name = 'AI-' + Math.floor(Math.random() * 999);

    const aiId = genAiId(room);
    room.players.push({
      id: aiId, name: name, alive: true, isHost: false,
      role: null, isAI: true,
    });

    if (cb) cb({ ok: true });
    emitRoomState(room);
    broadcastPlayers(room);
    systemMsg(room, 'AI 玩家「' + name + '」加入了房間。');
  });

  socket.on('remove_ai_player', (payload, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok: false, error: '房間不存在' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可以移除 AI' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok: false, error: '遊戲已開始' });

    const aiId = payload && payload.playerId;
    const ai = room.players.find(p => p.id === aiId && p.isAI);
    if (!ai) return cb && cb({ ok: false, error: '找不到該 AI' });

    room.players = room.players.filter(p => p.id !== aiId);
    if (cb) cb({ ok: true });
    emitRoomState(room);
    broadcastPlayers(room);
    systemMsg(room, 'AI 玩家「' + ai.name + '」已被移除。');
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => {
    console.log('[-] disconnected:', socket.id);
    handleLeave(socket);
  });

  socket.on('start_game', (payload, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok: false, error: '房間不存在' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可開始' });
    if (room.phase !== 'LOBBY') return cb && cb({ ok: false, error: '遊戲已開始' });
    if (room.players.length < 6) return cb && cb({ ok: false, error: '至少需要 6 人（含 AI）' });

    if (cb) cb({ ok: true });
    startGame(room);
  });

  socket.on('return_to_lobby', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    clearTimeout(room.timer);
    room.phase = 'LOBBY';
    room.day = 0;
    room.votes = {};
    room.wolfVotes = {};
    room.wolfTarget = null;
    room.seerChecks = {};
    room.pendingDeaths = [];
    room.hunterId = null;
    room.hunterNext = null;
    room.players.forEach(p => {
      p.alive = true; p.role = null; p.deathCause = null; p.hunterUsed = false;
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
    const camp = target.role === 'WEREWOLF' ? 'WOLF' : 'GOOD';
    room.seerChecks[me.id][target.id] = camp;

    io.to(me.id).emit('seer_result', {
      targetId: target.id, targetName: target.name, camp: camp,
    });
    io.to(me.id).emit('phase_changed', phasePayload(room, me, ''));
  });

  socket.on('day_vote', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'DAY_VOTE') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || !me.alive) return;
    if (room.votes[me.id] !== undefined) return;

    room.votes[me.id] = (payload && payload.targetId) || null;
    io.to(room.roomId).emit('vote_updated', { votes: tallyVotes(room) });

    const aliveCount = room.players.filter(p => p.alive).length;
    const votedCount = Object.keys(room.votes).length;

    if (votedCount >= aliveCount) {
      clearTimeout(room.timer);
      setTimeout(() => resolveVote(room), 800);
    }
  });

  socket.on('hunter_shoot', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'HUNTER_SHOOT') return;
    if (socket.id !== room.hunterId) return;
    clearTimeout(room.timer);
    hunterShoot(room, (payload && payload.targetId) || null);
  });

  socket.on('chat_send', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me) return;

    const channel = (payload && payload.channel) || 'PUBLIC';
    const text = String((payload && payload.text) || '').trim().slice(0, 200);
    if (!text) return;

    const msg = { channel: channel, from: me.name, text: text };

    if (channel === 'WOLF') {
      if (me.role !== 'WEREWOLF') return;
      room.players.filter(p => p.role === 'WEREWOLF' && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', msg));
      return;
    }
    if (channel === 'DEAD') {
      if (me.alive) return;
      room.players.filter(p => !p.alive && !p.isAI)
        .forEach(p => io.to(p.id).emit('chat_message', msg));
      return;
    }
    io.to(room.roomId).emit('chat_message', {
      channel: 'PUBLIC', from: me.name, text: text
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🐺 狼人殺伺服器已啟動，port = ' + PORT);
});
