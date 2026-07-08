const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const questions = require('./questions.json');

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  遊戲狀態
// ─────────────────────────────────────────────
let state = {
  phase: 'lobby',   // lobby | playing | ended
  players: {}
  // players[socketId]: { name, score, qIndex, qStartTime, answers[], finished }
};

function resetState() {
  state = { phase: 'lobby', players: {} };
}

function leaderboard() {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank:     i + 1,
      name:     p.name,
      score:    p.score,
      current:  p.qIndex + 1,          // 目前在第幾題（顯示用）
      total:    questions.length,
      finished: p.finished
    }));
}

function checkAllFinished() {
  const list = Object.values(state.players);
  if (list.length > 0 && list.every(p => p.finished)) {
    state.phase = 'ended';
    io.emit('game:ended', leaderboard());
  }
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ─────────────────────────────────────────────
//  Socket 事件
// ─────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── 員工加入 ──────────────────────────────
  socket.on('player:join', ({ name }) => {
    const trimmed = name.trim().slice(0, 20);
    if (!trimmed) return socket.emit('error', { msg: '請輸入姓名' });
    if (state.phase !== 'lobby') return socket.emit('error', { msg: '遊戲已開始，無法加入，請洽主持人' });
    if (Object.values(state.players).find(p => p.name === trimmed)) {
      return socket.emit('error', { msg: '此名稱已有人使用，請換一個' });
    }
    state.players[socket.id] = {
      name: trimmed, score: 0,
      qIndex: -1, qStartTime: null,
      answers: [], finished: false
    };
    socket.emit('player:joined', { name: trimmed, totalQ: questions.length });
    io.emit('lobby:update', leaderboard());
  });

  // ── 主持人加入 ────────────────────────────
  socket.on('admin:join', () => {
    socket.join('admins');
    socket.emit('admin:sync', {
      phase:  state.phase,
      totalQ: questions.length,
      players: leaderboard()
    });
  });

  // ── 主持人：開始遊戲 ──────────────────────
  socket.on('admin:start', () => {
    if (state.phase !== 'lobby') return;
    state.phase = 'playing';

    // 同時把第 0 題發給所有已加入的員工
    Object.keys(state.players).forEach(sid => {
      const p = state.players[sid];
      p.qIndex = 0;
      p.qStartTime = Date.now();
      io.to(sid).emit('question:new', makeQPayload(0));
    });

    io.to('admins').emit('admin:game-started');
    io.to('admins').emit('admin:progress-update', leaderboard());
  });

  // ── 員工：送出答案 ────────────────────────
  socket.on('player:answer', ({ answer }) => {
    const p = state.players[socket.id];
    if (!p || state.phase !== 'playing') return;
    if (p.answers[p.qIndex] !== undefined) return; // 避免重複計分

    const q        = questions[p.qIndex];
    const timedOut = (answer === null);

    let isCorrect = false;
    if (!timedOut) {
      isCorrect = q.isMultiple
        ? [...answer].sort().join() === [...q.correct].sort().join()
        : answer === q.correct;
    }

    const points = isCorrect ? 1000 : 0;
    p.score += points;
    p.answers[p.qIndex] = { answer, isCorrect, points };

    const isLastQ = p.qIndex >= questions.length - 1;

    // 立刻把答案 + 解析發給這位員工
    socket.emit('question:reveal', {
      correct:     q.correct,
      explanation: q.explanation,
      isCorrect,
      timedOut,
      points,
      totalScore:  p.score,
      isLastQ
    });

    const lb = leaderboard();
    io.to('admins').emit('admin:progress-update', lb);
    // 廣播最新排行給所有已在最終畫面等待的員工
    io.emit('leaderboard:live', lb);
  });

  // ── 員工：請求下一題 ──────────────────────
  socket.on('player:next', () => {
    const p = state.players[socket.id];
    if (!p || state.phase !== 'playing') return;

    const nextIdx = p.qIndex + 1;

    if (nextIdx >= questions.length) {
      // 全部答完
      p.finished = true;
      socket.emit('game:ended', leaderboard());
      io.to('admins').emit('admin:progress-update', leaderboard());
      checkAllFinished();
      return;
    }

    p.qIndex     = nextIdx;
    p.qStartTime = Date.now();
    socket.emit('question:new', makeQPayload(nextIdx));
  });

  // ── 主持人：強制結束 ──────────────────────
  socket.on('admin:force-end', () => {
    state.phase = 'ended';
    io.emit('game:ended', leaderboard());
  });

  // ── 主持人：重置遊戲 ──────────────────────
  socket.on('admin:reset', () => {
    resetState();
    io.emit('game:reset');
    socket.emit('admin:sync', { phase: 'lobby', totalQ: questions.length, players: [] });
  });

  // ── 斷線 ──────────────────────────────────
  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      delete state.players[socket.id];
      io.emit('lobby:update', leaderboard());
      io.to('admins').emit('admin:progress-update', leaderboard());
      if (state.phase === 'playing') checkAllFinished();
    }
  });
});

// ─────────────────────────────────────────────
//  輔助：組題目 payload
// ─────────────────────────────────────────────
function makeQPayload(idx) {
  const q = questions[idx];
  return {
    index:      idx,
    total:      questions.length,
    category:   q.category,
    text:       q.text,
    options:    q.options,
    isMultiple: q.isMultiple || false,
    timeLimit:  q.timeLimit || 60
  };
}

// ─────────────────────────────────────────────
//  啟動
// ─────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const LOCAL_IP = getLocalIP();
const IS_CLOUD = !!process.env.PORT;

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    🎯 AML 洗錢防制排位賽系統已啟動       ║');
  console.log('╚══════════════════════════════════════════╝');
  if (IS_CLOUD) {
    console.log('\n☁️  雲端模式運行中（Render）\n');
  } else {
    console.log(`\n📱 員工加入：http://${LOCAL_IP}:${PORT}`);
    console.log(`🎮 主持人：  http://${LOCAL_IP}:${PORT}/admin.html\n`);
  }
});
