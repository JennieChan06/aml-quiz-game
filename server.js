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
  phase: 'lobby',          // lobby | question | reveal | ended
  questionIndex: -1,
  players: {},             // { socketId: { name, score } }
  answers: {},             // { socketId: { answer, elapsed, isCorrect, points } }
  questionStartTime: null,
  autoRevealTimer: null
};

function resetState() {
  if (state.autoRevealTimer) clearTimeout(state.autoRevealTimer);
  state = {
    phase: 'lobby',
    questionIndex: -1,
    players: {},
    answers: {},
    questionStartTime: null,
    autoRevealTimer: null
  };
}

function leaderboard() {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

function answerProgress() {
  return {
    answered: Object.keys(state.answers).length,
    total: Object.keys(state.players).length
  };
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
    state.players[socket.id] = { name: trimmed, score: 0 };
    socket.emit('player:joined', { name: trimmed, totalQ: questions.length });
    io.emit('lobby:update', leaderboard());
  });

  // ── 主持人加入 ────────────────────────────
  socket.on('admin:join', () => {
    socket.join('admins');
    socket.emit('admin:sync', {
      phase: state.phase,
      questionIndex: state.questionIndex,
      totalQ: questions.length,
      players: leaderboard(),
      progress: answerProgress()
    });
  });

  // ── 主持人：開始下一題 ────────────────────
  socket.on('admin:next', () => {
    if (state.questionIndex >= questions.length - 1) {
      state.phase = 'ended';
      io.emit('game:ended', leaderboard());
      return;
    }
    if (state.autoRevealTimer) { clearTimeout(state.autoRevealTimer); state.autoRevealTimer = null; }

    state.questionIndex++;
    state.phase = 'question';
    state.answers = {};
    state.questionStartTime = Date.now();

    const q = questions[state.questionIndex];
    const timeLimit = q.timeLimit || 60;

    io.emit('question:start', {
      index: state.questionIndex,
      total: questions.length,
      category: q.category,
      text: q.text,
      options: q.options,
      isMultiple: q.isMultiple || false,
      timeLimit
    });

    // 倒數結束後自動通知主持人
    state.autoRevealTimer = setTimeout(() => {
      io.to('admins').emit('admin:time-up');
    }, timeLimit * 1000);
  });

  // ── 員工：送出答案 ────────────────────────
  socket.on('player:answer', ({ answer }) => {
    if (state.phase !== 'question') return;
    if (!state.players[socket.id]) return;
    if (state.answers[socket.id]) return; // 已作答，不重複計分

    const elapsed = (Date.now() - state.questionStartTime) / 1000;
    const q = questions[state.questionIndex];
    const timeLimit = q.timeLimit || 60;

    const isCorrect = q.isMultiple
      ? [...answer].sort().join() === [...q.correct].sort().join()
      : answer === q.correct;

    // 計分：答對依速度給 500–1000 分，答錯 0 分
    const points = isCorrect ? Math.round(Math.max(500, 1000 - (elapsed / timeLimit) * 500)) : 0;

    state.answers[socket.id] = { answer, elapsed, isCorrect, points };
    state.players[socket.id].score += points;

    socket.emit('player:answer-ack', { isCorrect, points });

    const progress = answerProgress();
    io.to('admins').emit('admin:progress', progress);
    if (progress.answered >= progress.total && progress.total > 0) {
      io.to('admins').emit('admin:all-answered');
    }
  });

  // ── 主持人：揭曉答案 ──────────────────────
  socket.on('admin:reveal', () => {
    if (state.autoRevealTimer) { clearTimeout(state.autoRevealTimer); state.autoRevealTimer = null; }
    state.phase = 'reveal';
    const q = questions[state.questionIndex];
    io.emit('question:reveal', {
      correct: q.correct,
      explanation: q.explanation,
      leaderboard: leaderboard(),
      isLast: state.questionIndex >= questions.length - 1
    });
  });

  // ── 主持人：重置遊戲 ──────────────────────
  socket.on('admin:reset', () => {
    resetState();
    io.emit('game:reset');
    socket.emit('admin:sync', {
      phase: 'lobby', questionIndex: -1,
      totalQ: questions.length, players: [], progress: { answered: 0, total: 0 }
    });
  });

  // ── 主持人：匯出成績 ──────────────────────
  socket.on('admin:export', () => {
    socket.emit('admin:export-data', leaderboard());
  });

  // ── 斷線處理 ─────────────────────────────
  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      delete state.players[socket.id];
      delete state.answers[socket.id];
      io.emit('lobby:update', leaderboard());
      io.to('admins').emit('admin:progress', answerProgress());
    }
  });
});

// ─────────────────────────────────────────────
//  啟動伺服器
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const LOCAL_IP = getLocalIP();
const IS_CLOUD = !!process.env.PORT;

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    🎯 AML 洗錢防制排位賽系統已啟動       ║');
  console.log('╚══════════════════════════════════════════╝');
  if (IS_CLOUD) {
    console.log('\n☁️  雲端模式運行中（Railway / Render）');
    console.log('   請從雲端平台取得公開網址\n');
  } else {
    console.log(`\n📱 員工加入網址：`);
    console.log(`   http://${LOCAL_IP}:${PORT}\n`);
    console.log(`🎮 主持人控制台：`);
    console.log(`   http://${LOCAL_IP}:${PORT}/admin.html\n`);
    console.log('⚠️  請確保所有設備連接同一個 WiFi');
    console.log('   按 Ctrl+C 停止伺服器\n');
  }
});
