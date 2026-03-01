// =============================================================================
// CLOUDFLARE WORKER - Skribbl-style Drawing Game
// Deploy ini sebagai Cloudflare Worker dengan Durable Objects enabled
// =============================================================================

// Secret Key Cloudflare Turnstile (jangan disebarkan!)
const TURNSTILE_SECRET = '0x4AAAAAACkPBqhrP1dPiEnb';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: WebSocket untuk room tertentu
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2] || 'default';
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Route: Buat room baru — wajib lewat validasi Turnstile
    if (url.pathname === '/create-room') {

      // Coba baca token CAPTCHA dari body (POST) atau query param (GET fallback)
      let captchaToken = null;

      if (request.method === 'POST') {
        try {
          const body = await request.json();
          captchaToken = body.captcha || null;
        } catch (_) {}
      } else {
        captchaToken = url.searchParams.get('captcha');
      }

      // Validasi token ke Cloudflare Turnstile
      if (!captchaToken) {
        return new Response(JSON.stringify({ error: 'CAPTCHA token tidak ditemukan' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: TURNSTILE_SECRET,
          response: captchaToken,
          remoteip: request.headers.get('CF-Connecting-IP') || undefined,
        }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyData.success) {
        return new Response(JSON.stringify({
          error: 'Verifikasi CAPTCHA gagal. Coba lagi.',
          codes: verifyData['error-codes'] || [],
        }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // CAPTCHA valid — buat room
      const roomId = generateRoomId();
      return new Response(JSON.stringify({ roomId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Skribbl Worker Active', { headers: corsHeaders });
  }
};

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// =============================================================================
// DURABLE OBJECT - Game Room State
// =============================================================================

const WORD_CATEGORIES = {
  animals: ['kucing', 'anjing', 'gajah', 'harimau', 'kelinci', 'buaya', 'penguin', 'lumba-lumba', 'jerapah', 'gorila', 'kuda nil', 'kanguru', 'koala', 'panda', 'singa'],
  food: ['pizza', 'sushi', 'rendang', 'bakso', 'mie goreng', 'nasi goreng', 'gado-gado', 'martabak', 'donat', 'es krim', 'burger', 'roti bakar', 'sate', 'pempek', 'gudeg'],
  objects: ['sepeda', 'mobil', 'pesawat', 'kapal', 'payung', 'kacamata', 'jam tangan', 'tas ransel', 'bola', 'gitar', 'piano', 'kamera', 'televisi', 'kulkas', 'komputer'],
  places: ['pantai', 'gunung', 'hutan', 'sekolah', 'rumah sakit', 'bandara', 'pasar', 'taman', 'museum', 'perpustakaan', 'masjid', 'stadion', 'pelabuhan', 'kebun binatang', 'mall'],
  actions: ['berlari', 'berenang', 'memasak', 'menari', 'melukis', 'memancing', 'berkebun', 'bermain bola', 'naik sepeda', 'membaca'],
};

const ALL_WORDS = Object.values(WORD_CATEGORIES).flat();

const DRAW_TIME = 80; // seconds per round
const MAX_ROUNDS = 3;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 5;
const SCORE_BASE = 100;

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // clientId -> { ws, username, score, isReady }
    this.gameState = {
      phase: 'lobby', // lobby | drawing | roundEnd | gameEnd
      round: 0,
      maxRounds: MAX_ROUNDS,
      drawerId: null,
      currentWord: null,
      wordHint: null,
      roundTimer: null,
      timeLeft: DRAW_TIME,
      correctGuessers: new Set(),
      drawingData: [], // stroke history
      scores: {},
      roundWinners: [],
    };
    this.timerInterval = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server, request);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  handleSession(ws, request) {
    ws.accept();

    const clientId = crypto.randomUUID();
    const session = {
      ws,
      clientId,
      username: `Player_${clientId.slice(0, 4)}`,
      score: 0,
      isReady: false,
      joinedAt: Date.now(),
    };

    this.sessions.set(clientId, session);

    ws.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleMessage(clientId, msg);
      } catch (e) {
        console.error('Message error:', e);
      }
    });

    ws.addEventListener('close', () => {
      this.handleDisconnect(clientId);
    });

    ws.addEventListener('error', () => {
      this.handleDisconnect(clientId);
    });

    // Send welcome + current state
    this.send(clientId, {
      type: 'welcome',
      clientId,
      gameState: this.getPublicGameState(),
      players: this.getPlayerList(),
    });

    // Notify others
    this.broadcast({
      type: 'player_joined',
      players: this.getPlayerList(),
      playerCount: this.sessions.size,
    }, clientId);
  }

  async handleMessage(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    switch (msg.type) {
      case 'set_username':
        session.username = msg.username.slice(0, 20).trim() || session.username;
        this.broadcast({ type: 'player_joined', players: this.getPlayerList(), playerCount: this.sessions.size });
        break;

      case 'set_ready':
        session.isReady = msg.ready;
        this.broadcast({ type: 'player_ready', players: this.getPlayerList() });
        this.checkStartGame();
        break;

      case 'draw':
        if (clientId !== this.gameState.drawerId) return;
        if (this.gameState.phase !== 'drawing') return;
        this.gameState.drawingData.push(msg.data);
        this.broadcastExcept(clientId, { type: 'draw', data: msg.data });
        break;

      case 'clear_canvas':
        if (clientId !== this.gameState.drawerId) return;
        this.gameState.drawingData = [];
        this.broadcast({ type: 'clear_canvas' });
        break;

      case 'guess':
        this.handleGuess(clientId, msg.text);
        break;

      case 'chat':
        const sanitized = msg.text.slice(0, 200);
        this.broadcast({
          type: 'chat',
          username: session.username,
          text: sanitized,
          clientId,
        });
        break;

      case 'start_game':
        if (this.gameState.phase === 'lobby' && this.sessions.size >= MIN_PLAYERS) {
          this.startGame();
        } else if (this.sessions.size < MIN_PLAYERS) {
          this.send(clientId, { type: 'error', message: `Butuh minimal ${MIN_PLAYERS} pemain!` });
        }
        break;

      case 'ping':
        this.send(clientId, { type: 'pong', timestamp: msg.timestamp });
        break;
    }
  }

  handleGuess(clientId, text) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    if (this.gameState.phase !== 'drawing') return;
    if (clientId === this.gameState.drawerId) return;
    if (this.gameState.correctGuessers.has(clientId)) return;

    const guess = text.trim().toLowerCase();
    const word = this.gameState.currentWord?.toLowerCase();

    if (guess === word) {
      this.gameState.correctGuessers.add(clientId);
      const timeBonus = Math.floor((this.gameState.timeLeft / DRAW_TIME) * SCORE_BASE);
      const points = SCORE_BASE + timeBonus;

      session.score += points;
      this.gameState.scores[clientId] = session.score;

      const drawerSession = this.sessions.get(this.gameState.drawerId);
      if (drawerSession) {
        drawerSession.score += Math.floor(points * 0.5);
        this.gameState.scores[this.gameState.drawerId] = drawerSession.score;
      }

      this.broadcast({
        type: 'correct_guess',
        clientId,
        username: session.username,
        points,
        scores: this.getScores(),
      });

      const nonDrawers = [...this.sessions.keys()].filter(id => id !== this.gameState.drawerId);
      if (this.gameState.correctGuessers.size >= nonDrawers.length) {
        this.endRound('all_guessed');
      }
    } else {
      this.broadcast({
        type: 'wrong_guess',
        username: session.username,
        text: guess,
        clientId,
      });
    }
  }

  checkStartGame() {
    const players = [...this.sessions.values()];
    const readyCount = players.filter(p => p.isReady).length;
    const totalCount = players.length;

    if (totalCount >= MIN_PLAYERS && readyCount === totalCount) {
      this.startGame();
    }
  }

  startGame() {
    if (this.gameState.phase !== 'lobby' && this.gameState.phase !== 'gameEnd') return;

    this.gameState.round = 0;
    this.gameState.phase = 'starting';

    for (const [id, session] of this.sessions) {
      session.score = 0;
      this.gameState.scores[id] = 0;
    }

    this.broadcast({ type: 'game_starting', countdown: 3 });
    setTimeout(() => this.nextRound(), 3000);
  }

  nextRound() {
    if (this.gameState.round >= this.gameState.maxRounds * this.sessions.size) {
      this.endGame();
      return;
    }

    this.gameState.round++;
    this.gameState.correctGuessers = new Set();
    this.gameState.drawingData = [];
    this.gameState.timeLeft = DRAW_TIME;
    this.gameState.roundWinners = [];

    const playerIds = [...this.sessions.keys()];
    const drawerIndex = (this.gameState.round - 1) % playerIds.length;
    this.gameState.drawerId = playerIds[drawerIndex];

    const words = this.pickWords(3);
    this.gameState.currentWord = words[0];
    this.gameState.wordHint = this.generateHint(this.gameState.currentWord, 0);

    this.gameState.phase = 'drawing';

    this.send(this.gameState.drawerId, {
      type: 'round_start_drawer',
      round: this.gameState.round,
      maxRounds: this.gameState.maxRounds * playerIds.length,
      word: this.gameState.currentWord,
      drawerName: this.sessions.get(this.gameState.drawerId)?.username,
      timeLeft: DRAW_TIME,
    });

    this.broadcastExcept(this.gameState.drawerId, {
      type: 'round_start_guesser',
      round: this.gameState.round,
      maxRounds: this.gameState.maxRounds * playerIds.length,
      drawerId: this.gameState.drawerId,
      drawerName: this.sessions.get(this.gameState.drawerId)?.username,
      wordLength: this.gameState.currentWord.length,
      hint: this.gameState.wordHint,
      timeLeft: DRAW_TIME,
    });

    this.startRoundTimer();
  }

  startRoundTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      this.gameState.timeLeft--;

      const revealAt = [Math.floor(DRAW_TIME * 0.5), Math.floor(DRAW_TIME * 0.25)];
      const elapsed = DRAW_TIME - this.gameState.timeLeft;
      const revealed = revealAt.filter(t => elapsed >= t).length;
      const newHint = this.generateHint(this.gameState.currentWord, revealed);

      if (newHint !== this.gameState.wordHint) {
        this.gameState.wordHint = newHint;
        this.broadcastExcept(this.gameState.drawerId, {
          type: 'hint_update',
          hint: newHint,
        });
      }

      this.broadcast({ type: 'timer', timeLeft: this.gameState.timeLeft });

      if (this.gameState.timeLeft <= 0) {
        clearInterval(this.timerInterval);
        this.endRound('time_up');
      }
    }, 1000);
  }

  endRound(reason) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.gameState.phase = 'roundEnd';

    this.broadcast({
      type: 'round_end',
      reason,
      word: this.gameState.currentWord,
      scores: this.getScores(),
      round: this.gameState.round,
    });

    setTimeout(() => this.nextRound(), 5000);
  }

  endGame() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.gameState.phase = 'gameEnd';

    const finalScores = this.getScores();
    const winner = finalScores[0];

    this.broadcast({
      type: 'game_end',
      scores: finalScores,
      winner: winner?.username,
    });

    setTimeout(() => {
      this.gameState.phase = 'lobby';
      for (const session of this.sessions.values()) {
        session.isReady = false;
        session.score = 0;
      }
      this.broadcast({ type: 'back_to_lobby', players: this.getPlayerList() });
    }, 10000);
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);

    this.broadcast({
      type: 'player_left',
      clientId,
      players: this.getPlayerList(),
      playerCount: this.sessions.size,
    });

    if (this.gameState.phase === 'drawing' && this.gameState.drawerId === clientId) {
      this.endRound('drawer_left');
    }

    if (this.sessions.size < MIN_PLAYERS && this.gameState.phase !== 'lobby' && this.gameState.phase !== 'gameEnd') {
      if (this.timerInterval) clearInterval(this.timerInterval);
      this.gameState.phase = 'lobby';
      this.broadcast({ type: 'game_cancelled', reason: 'Pemain terlalu sedikit', players: this.getPlayerList() });
    }
  }

  pickWords(count) {
    const shuffled = [...ALL_WORDS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  generateHint(word, revealCount) {
    const chars = word.split('');
    const positions = chars.map((c, i) => i).filter(i => chars[i] !== ' ');
    const toReveal = new Set();

    for (let i = 0; i < revealCount && i < positions.length; i++) {
      const idx = Math.floor(Math.random() * positions.length);
      toReveal.add(positions[idx]);
    }

    return chars.map((c, i) => {
      if (c === ' ') return ' ';
      if (toReveal.has(i)) return c;
      return '_';
    }).join('');
  }

  getScores() {
    return [...this.sessions.entries()]
      .map(([id, s]) => ({ clientId: id, username: s.username, score: s.score }))
      .sort((a, b) => b.score - a.score);
  }

  getPlayerList() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      clientId: id,
      username: s.username,
      score: s.score,
      isReady: s.isReady,
    }));
  }

  getPublicGameState() {
    return {
      phase: this.gameState.phase,
      round: this.gameState.round,
      maxRounds: this.gameState.maxRounds,
      drawerId: this.gameState.drawerId,
      drawerName: this.sessions.get(this.gameState.drawerId)?.username,
      timeLeft: this.gameState.timeLeft,
      hint: this.gameState.wordHint,
      wordLength: this.gameState.currentWord?.length,
      playerCount: this.sessions.size,
    };
  }

  send(clientId, data) {
    const session = this.sessions.get(clientId);
    if (session?.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify(data));
      } catch (e) {}
    }
  }

  broadcast(data, excludeId = null) {
    const json = JSON.stringify(data);
    for (const [id, session] of this.sessions) {
      if (id === excludeId) continue;
      if (session.ws.readyState === WebSocket.OPEN) {
        try {
          session.ws.send(json);
        } catch (e) {}
      }
    }
  }

  broadcastExcept(excludeId, data) {
    this.broadcast(data, excludeId);
  }
}
