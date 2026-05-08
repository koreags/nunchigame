const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();

const COUNTDOWN_SECONDS = 10;
const SIMULTANEOUS_THRESHOLD_MS = 100;

function createRoom() {
  return {
    players: new Map(), // socketId -> { name, alive, pick, pickTime, secured }
    gameStarted: false,
    round: 0,
    roundMaxNum: 0,
    countdownInterval: null,
    countdownValue: 0,
  };
}

function getAlivePlayers(room) {
  return [...room.players.entries()].filter(([, p]) => p.alive);
}

function buildGameState(room) {
  const alive = getAlivePlayers(room);
  return {
    gameStarted: room.gameStarted,
    round: room.round,
    N: alive.length,
    maxNum: room.roundMaxNum,
    players: [...room.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      alive: p.alive,
      hasPick: p.pick !== null,
      secured: p.secured,
      securedPick: p.secured ? p.pick : null,
    })),
  };
}

function clearCountdown(room) {
  if (room.countdownInterval) {
    clearInterval(room.countdownInterval);
    room.countdownInterval = null;
  }
}

function startCountdown(roomId, room) {
  clearCountdown(room);
  room.countdownValue = COUNTDOWN_SECONDS;
  io.to(roomId).emit('timer_warning', { seconds: COUNTDOWN_SECONDS });

  room.countdownInterval = setInterval(() => {
    room.countdownValue -= 1;
    io.to(roomId).emit('timer_tick', { seconds: room.countdownValue });
    if (room.countdownValue <= 0) {
      clearCountdown(room);
      resolveTimeout(roomId, room);
    }
  }, 1000);
}

// 라운드 종료: 결과 브로드캐스트 후 game_over 또는 3초 뒤 다음 라운드
function endRound(roomId, room, secured, eliminated) {
  clearCountdown(room);

  io.to(roomId).emit('round_result', {
    round: room.round,
    maxNum: room.roundMaxNum,
    secured,
    eliminated,
  });

  const alive = getAlivePlayers(room);

  if (alive.length <= 1) {
    room.gameStarted = false;
    const winner = alive.length === 1
      ? { id: alive[0][0], name: alive[0][1].name }
      : null;
    io.to(roomId).emit('game_over', { winner });
    return;
  }

  // 3초 후 다음 라운드
  setTimeout(() => {
    room.round      += 1;
    room.roundMaxNum = getAlivePlayers(room).length - 1;
    for (const [, player] of room.players) {
      if (player.alive) {
        player.pick     = null;
        player.pickTime = null;
        player.secured  = false;
      }
    }
    io.to(roomId).emit('game_state', buildGameState(room));
    startCountdown(roomId, room);
  }, 3000);
}

// 타이머 만료: 번호를 고르지 못한 플레이어 탈락 후 라운드 종료
function resolveTimeout(roomId, room) {
  const alive     = getAlivePlayers(room);
  const secured   = [];
  const eliminated = [];

  for (const [id, player] of alive) {
    if (player.pick !== null) {
      player.secured = true;
      secured.push({ id, name: player.name, pick: player.pick });
    } else {
      player.alive = false;
      eliminated.push({ id, name: player.name });
    }
  }

  endRound(roomId, room, secured, eliminated);
}

// ── 소켓 이벤트 ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('join_room', ({ roomId, name }) => {
    if (!roomId) return;
    if (!rooms.has(roomId)) rooms.set(roomId, createRoom());
    const room = rooms.get(roomId);

    if (room.gameStarted) {
      socket.emit('error', { message: '이미 게임이 진행 중입니다' });
      return;
    }

    const playerName = (name || '').trim() || `Player${room.players.size + 1}`;
    room.players.set(socket.id, {
      name: playerName,
      alive: true,
      pick: null,
      pickTime: null,
      secured: false,
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    io.to(roomId).emit('game_state', buildGameState(room));
    console.log(`[join] ${playerName} → room ${roomId}`);
  });

  socket.on('start_game', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.gameStarted) return;

    if (room.players.size < 2) {
      socket.emit('error', { message: '최소 2명이 필요합니다' });
      return;
    }

    room.gameStarted = true;
    room.round       = 1;
    room.roundMaxNum = room.players.size - 1;

    for (const [, player] of room.players) {
      player.alive    = true;
      player.pick     = null;
      player.pickTime = null;
      player.secured  = false;
    }

    io.to(roomId).emit('game_state', buildGameState(room));
    startCountdown(roomId, room);
    console.log(`[start] room ${roomId}, players: ${room.players.size}, maxNum: ${room.roundMaxNum}`);
  });

  socket.on('pick_number', ({ number }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.gameStarted) return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive || player.secured) return;

    const { roundMaxNum } = room;
    if (!Number.isInteger(number) || number < 1 || number > roundMaxNum) {
      socket.emit('error', { message: `1~${roundMaxNum} 사이의 숫자를 선택하세요` });
      return;
    }

    // 이미 픽한 경우 → 무시 (변경 불가)
    if (player.pick !== null) return;

    const now = Date.now();

    // 충돌 확인
    const conflictEntry = getAlivePlayers(room).find(
      ([id, p]) => id !== socket.id && p.pick === number
    );

    if (conflictEntry) {
      const [prevId, prevPlayer] = conflictEntry;
      const diff = now - prevPlayer.pickTime;
      const eliminated = [];

      if (diff <= SIMULTANEOUS_THRESHOLD_MS) {
        // 동시 입력 → 둘 다 탈락
        player.alive     = false;
        prevPlayer.alive = false;

        console.log(`[collision-simultaneous] ${player.name} & ${prevPlayer.name} → ${number} (diff=${diff}ms, room ${roomId})`);

        io.to(socket.id).emit('eliminated', {
          reason: 'simultaneous',
          number,
          rival: { id: prevId, name: prevPlayer.name },
        });
        io.to(prevId).emit('eliminated', {
          reason: 'simultaneous',
          number,
          rival: { id: socket.id, name: player.name },
        });

        eliminated.push({ id: socket.id, name: player.name });
        eliminated.push({ id: prevId,    name: prevPlayer.name });

      } else {
        // 선점 충돌 → 먼저 누른 사람 확보, 나중 탈락
        prevPlayer.secured = true;
        player.alive       = false;

        console.log(`[collision-late] ${player.name} → ${number} (${prevPlayer.name} 선점, diff=${diff}ms, room ${roomId})`);

        io.to(socket.id).emit('eliminated', {
          reason: 'collision',
          number,
          winner: { id: prevId, name: prevPlayer.name },
        });

        eliminated.push({ id: socket.id, name: player.name });
      }

      // 현재 확보된 번호 목록 (라운드 결과용)
      const secured = getAlivePlayers(room)
        .filter(([, p]) => p.secured)
        .map(([id, p]) => ({ id, name: p.name, pick: p.pick }));

      io.to(roomId).emit('game_state', buildGameState(room));
      endRound(roomId, room, secured, eliminated);
      return;
    }

    // 충돌 없음: 픽 등록, 타이머 리셋
    player.pick     = number;
    player.pickTime = now;
    console.log(`[pick] ${player.name} → ${number} (room ${roomId})`);

    clearCountdown(room);
    io.to(roomId).emit('timer_cancel');
    io.to(roomId).emit('game_state', buildGameState(room));
    startCountdown(roomId, room);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    console.log(`[disconnect] ${player?.name ?? socket.id} from room ${roomId}`);
    room.players.delete(socket.id);

    if (room.players.size === 0) {
      clearCountdown(room);
      rooms.delete(roomId);
      return;
    }

    if (room.gameStarted) {
      const alive = getAlivePlayers(room);
      if (alive.length <= 1) {
        clearCountdown(room);
        room.gameStarted = false;
        const winner = alive.length === 1
          ? { id: alive[0][0], name: alive[0][1].name }
          : null;
        io.to(roomId).emit('game_over', { winner });
        return;
      }
    }

    io.to(roomId).emit('game_state', buildGameState(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`눈치게임 서버 실행 중 → http://localhost:${PORT}`);
});
