const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6,
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function initBoard() {
  const B = 'black', W = 'white';
  return [
    [{c:B,t:'R'},{c:B,t:'N'},{c:B,t:'B'},{c:B,t:'Q'},{c:B,t:'K'},{c:B,t:'B'},{c:B,t:'N'},{c:B,t:'R'}],
    Array(8).fill(null).map(()=>({c:B,t:'P'})),
    Array(8).fill(null), Array(8).fill(null),
    Array(8).fill(null), Array(8).fill(null),
    Array(8).fill(null).map(()=>({c:W,t:'P'})),
    [{c:W,t:'R'},{c:W,t:'N'},{c:W,t:'B'},{c:W,t:'Q'},{c:W,t:'K'},{c:W,t:'B'},{c:W,t:'N'},{c:W,t:'R'}]
  ];
}

function getRawMoves(board, r, c) {
  const piece = board[r][c];
  if (!piece) return [];
  const moves = [];
  const color = piece.c;
  const opp = color === 'white' ? 'black' : 'white';

  const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const add = (tr, tc) => {
    if (!inBounds(tr, tc)) return false;
    if (board[tr][tc]?.c === color) return false;
    moves.push([tr, tc]);
    return !board[tr][tc];
  };
  const slide = (dr, dc) => { let tr = r + dr, tc = c + dc; while (add(tr, tc)) { tr += dr; tc += dc; } };

  if (piece.t === 'P') {
    const dir = color === 'white' ? -1 : 1;
    const start = color === 'white' ? 6 : 1;
    if (inBounds(r + dir, c) && !board[r + dir][c]) {
      moves.push([r + dir, c]);
      if (r === start && !board[r + dir * 2][c]) moves.push([r + dir * 2, c]);
    }
    for (const dc of [-1, 1]) {
      if (inBounds(r + dir, c + dc) && board[r + dir][c + dc]?.c === opp) moves.push([r + dir, c + dc]);
    }
  } else if (piece.t === 'N') {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
  } else if (piece.t === 'B') {
    [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => slide(dr, dc));
  } else if (piece.t === 'R') {
    [[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr,dc]) => slide(dr, dc));
  } else if (piece.t === 'Q') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => slide(dr, dc));
  } else if (piece.t === 'K') {
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => add(r+dr, c+dc));
    if (!piece.moved) {
      if (!board[r][5] && !board[r][6] && board[r][7]?.t === 'R' && !board[r][7]?.moved) moves.push([r, 6]);
      if (!board[r][3] && !board[r][2] && !board[r][1] && board[r][0]?.t === 'R' && !board[r][0]?.moved) moves.push([r, 2]);
    }
  }
  return moves;
}

function isInCheck(board, color) {
  let kr = -1, kc = -1;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (board[r][c]?.t === 'K' && board[r][c]?.c === color) { kr = r; kc = c; }
  }
  if (kr === -1) return false;
  const opp = color === 'white' ? 'black' : 'white';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (board[r][c]?.c === opp) {
      if (getRawMoves(board, r, c).some(([tr, tc]) => tr === kr && tc === kc)) return true;
    }
  }
  return false;
}

function getLegalMoves(board, r, c) {
  const piece = board[r][c];
  if (!piece) return [];
  return getRawMoves(board, r, c).filter(([tr, tc]) => {
    const copy = board.map(row => row.map(cell => cell ? { ...cell } : null));
    copy[tr][tc] = copy[r][c];
    copy[r][c] = null;
    return !isInCheck(copy, piece.c);
  });
}

function isCheckmate(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (board[r][c]?.c === color && getLegalMoves(board, r, c).length > 0) return false;
  }
  return true;
}

function isStalemate(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (board[r][c]?.c === color && getLegalMoves(board, r, c).length > 0) return false;
  }
  return !isInCheck(board, color);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ name, photo }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: [{ id: socket.id, name, photo, color: 'white' }],
      board: initBoard(),
      turn: 'white',
      moveCount: 0,
      captured: { white: [], black: [] },
      lastMove: null,
      status: 'waiting'
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId, color: 'white', playerNum: 1 });
    console.log(`Room ${roomId} created by ${name}`);
  });

  socket.on('join_room', ({ roomId, name, photo }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.players.length >= 2) { socket.emit('error', 'Room is full'); return; }
    if (room.status !== 'waiting') { socket.emit('error', 'Game already started'); return; }

    room.players.push({ id: socket.id, name, photo, color: 'black' });
    room.status = 'playing';
    socket.join(roomId);
    socket.roomId = roomId;

    const p1 = room.players[0];
    const p2 = room.players[1];

    io.to(p1.id).emit('game_start', {
      color: 'white', opponentName: p2.name, opponentPhoto: p2.photo,
      board: room.board, turn: room.turn
    });
    io.to(p2.id).emit('game_start', {
      color: 'black', opponentName: p1.name, opponentPhoto: p1.photo,
      board: room.board, turn: room.turn
    });
    console.log(`Game started in room ${roomId}`);
  });

  socket.on('get_moves', ({ r, c }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.color !== room.turn) return;
    const moves = getLegalMoves(room.board, r, c);
    socket.emit('valid_moves', { r, c, moves });
  });

  socket.on('make_move', ({ fr, fc, tr, tc, promotion }) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.color !== room.turn) return;

    const piece = room.board[fr][fc];
    if (!piece || piece.c !== room.turn) return;

    const legal = getLegalMoves(room.board, fr, fc);
    if (!legal.some(([r, c]) => r === tr && c === tc)) return;

    const target = room.board[tr][tc];
    if (target) room.captured[room.turn].push(target);

    room.board[tr][tc] = { ...piece };
    room.board[fr][fc] = null;
    room.board[tr][tc].moved = true;
    room.lastMove = { fr, fc, tr, tc };

    if (piece.t === 'K' && Math.abs(fc - tc) === 2) {
      if (tc === 6) { room.board[fr][5] = { ...room.board[fr][7], moved: true }; room.board[fr][7] = null; }
      else { room.board[fr][3] = { ...room.board[fr][0], moved: true }; room.board[fr][0] = null; }
    }

    if (piece.t === 'P' && (tr === 0 || tr === 7)) {
      room.board[tr][tc].t = promotion || 'Q';
    }

    room.moveCount++;
    const nextTurn = room.turn === 'white' ? 'black' : 'white';
    room.turn = nextTurn;

    const check = isInCheck(room.board, nextTurn);
    const checkmate = check && isCheckmate(room.board, nextTurn);
    const stalemate = !check && isStalemate(room.board, nextTurn);

    const moveData = {
      board: room.board, turn: room.turn, lastMove: room.lastMove,
      captured: room.captured, moveCount: room.moveCount,
      check: check ? nextTurn : null,
      checkmate: checkmate ? nextTurn : null,
      stalemate: stalemate || null
    };

    io.to(socket.roomId).emit('move_made', moveData);

    if (checkmate || stalemate) {
      room.status = 'finished';
      const winner = checkmate ? player.color : null;
      const winnerPlayer = winner ? room.players.find(p => p.color === winner) : null;
      io.to(socket.roomId).emit('game_over', {
        reason: checkmate ? 'checkmate' : 'stalemate',
        winner: winnerPlayer ? { name: winnerPlayer.name, photo: winnerPlayer.photo, color: winner } : null,
        moveCount: room.moveCount,
        captured: room.captured
      });
    }
  });

  socket.on('chat_msg', ({ msg }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(socket.roomId).emit('chat_msg', { name: player.name, msg, color: player.color });
  });

  socket.on('resign', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const winner = room.players.find(p => p.id !== socket.id);
    room.status = 'finished';
    io.to(socket.roomId).emit('game_over', {
      reason: 'resign',
      winner: winner ? { name: winner.name, photo: winner.photo, color: winner.color } : null,
      moveCount: room.moveCount
    });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.status === 'playing') {
      const other = room.players.find(p => p.id !== socket.id);
      if (other) io.to(other.id).emit('opponent_disconnected');
    }
    delete rooms[socket.roomId];
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chess Royale server running on port ${PORT}`));
