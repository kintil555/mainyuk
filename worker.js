// =============================================================================
// CLOUDFLARE WORKER - Skribbl-style Drawing Game
// =============================================================================

const QUEUE_CONFIG = {
  MAX_CONCURRENT_CREATES: 3,
  BASE_WAIT_PER_PERSON: 45,
  MAX_WAIT_SECONDS: 240,
  QUEUE_EXPIRY_MS: 5 * 60 * 1000,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2] || 'default';
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/queue-status') {
      const queueId = url.searchParams.get('queueId');
      if (!queueId) {
        return new Response(JSON.stringify({ error: 'queueId diperlukan' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const queueStub = env.QUEUE_MANAGER.get(env.QUEUE_MANAGER.idFromName('global'));
      const queueReq = new Request('https://internal/status?queueId=' + queueId, { method: 'GET' });
      const queueRes = await queueStub.fetch(queueReq);
      const data = await queueRes.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/create-room') {
      let captchaToken = null;
      let queueId = null;

      if (request.method === 'POST') {
        try {
          const body = await request.json();
          captchaToken = body.captcha || null;
          queueId = body.queueId || null;
        } catch (_) {}
      } else {
        captchaToken = url.searchParams.get('captcha');
        queueId = url.searchParams.get('queueId');
      }

      if (!captchaToken) {
        return new Response(JSON.stringify({ error: 'CAPTCHA token tidak ditemukan' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const secret = env.TURNSTILE_SECRET;
      if (secret) {
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret,
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
      }

      const queueStub = env.QUEUE_MANAGER.get(env.QUEUE_MANAGER.idFromName('global'));
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

      const queueReq = new Request('https://internal/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId, clientIp }),
      });
      const queueRes = await queueStub.fetch(queueReq);
      const queueData = await queueRes.json();

      if (queueData.status === 'queued') {
        return new Response(JSON.stringify({
          queued: true,
          queueId: queueData.queueId,
          position: queueData.position,
          estimatedWait: queueData.estimatedWait,
        }), {
          status: 202,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (queueData.status === 'ready' || queueData.status === 'immediate') {
        const roomId = generateRoomId();
        const doneReq = new Request('https://internal/done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueId: queueData.queueId }),
        });
        await queueStub.fetch(doneReq);

        return new Response(JSON.stringify({ roomId }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Status antrian tidak dikenal' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Skribbl Worker Active', { headers: corsHeaders });
  }
};

// =============================================================================
// DURABLE OBJECT - Queue Manager
// =============================================================================
export class QueueManager {
  constructor(state, env) {
    this.state = state;
    this.queue = [];
    this.activeCount = 0;
    this.initialized = false;
  }

  async ensureLoaded() {
    if (this.initialized) return;
    this.queue = (await this.state.storage.get('queue')) || [];
    this.activeCount = (await this.state.storage.get('activeCount')) || 0;
    this.initialized = true;
    this.cleanExpired();
  }

  async save() {
    await this.state.storage.put('queue', this.queue);
    await this.state.storage.put('activeCount', this.activeCount);
  }

  cleanExpired() {
    const now = Date.now();
    const before = this.queue.length;
    this.queue = this.queue.filter(e => {
      if (now - e.joinedAt > QUEUE_CONFIG.QUEUE_EXPIRY_MS) return false;
      return true;
    });
    const removed = before - this.queue.length;
    if (removed > 0) {
      this.activeCount = Math.max(0, this.activeCount - removed);
    }
  }

  getWaitingQueue() {
    return this.queue.filter(e => e.status === 'waiting');
  }

  getPosition(queueId) {
    const waiting = this.getWaitingQueue();
    return waiting.findIndex(e => e.queueId === queueId) + 1;
  }

  calcEstimatedWait(position) {
    const raw = position * QUEUE_CONFIG.BASE_WAIT_PER_PERSON;
    return Math.min(raw, QUEUE_CONFIG.MAX_WAIT_SECONDS);
  }

  async fetch(request) {
    await this.ensureLoaded();
    this.cleanExpired();

    const url = new URL(request.url);

    if (url.pathname === '/enqueue') {
      const body = await request.json();
      let { queueId, clientIp } = body;

      if (queueId) {
        const existing = this.queue.find(e => e.queueId === queueId);
        if (existing) {
          if (existing.status === 'processing') {
            await this.save();
            return new Response(JSON.stringify({ status: 'ready', queueId }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } else {
            const position = this.getPosition(queueId);
            const estimatedWait = this.calcEstimatedWait(position);
            await this.save();
            return new Response(JSON.stringify({
              status: 'queued', queueId, position, estimatedWait,
            }), { headers: { 'Content-Type': 'application/json' } });
          }
        }
      }

      const newQueueId = queueId || crypto.randomUUID().slice(0, 12);

      if (this.activeCount < QUEUE_CONFIG.MAX_CONCURRENT_CREATES && this.getWaitingQueue().length === 0) {
        this.activeCount++;
        this.queue.push({ queueId: newQueueId, clientIp, joinedAt: Date.now(), status: 'processing' });
        await this.save();
        return new Response(JSON.stringify({ status: 'immediate', queueId: newQueueId }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      this.queue.push({ queueId: newQueueId, clientIp, joinedAt: Date.now(), status: 'waiting' });
      this.promoteQueue();

      const position = this.getPosition(newQueueId);
      const estimatedWait = this.calcEstimatedWait(position);

      await this.save();
      return new Response(JSON.stringify({
        status: 'queued', queueId: newQueueId, position, estimatedWait,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/status') {
      const queueId = url.searchParams.get('queueId');
      const entry = this.queue.find(e => e.queueId === queueId);

      if (!entry) {
        return new Response(JSON.stringify({ status: 'not_found' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (entry.status === 'processing') {
        await this.save();
        return new Response(JSON.stringify({ status: 'ready', queueId }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const position = this.getPosition(queueId);
      const estimatedWait = this.calcEstimatedWait(position);
      await this.save();
      return new Response(JSON.stringify({
        status: 'queued', queueId, position, estimatedWait,
        totalWaiting: this.getWaitingQueue().length,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/done') {
      const body = await request.json();
      const { queueId } = body;
      this.queue = this.queue.filter(e => e.queueId !== queueId);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.promoteQueue();
      await this.save();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('QueueManager Active', { status: 200 });
  }

  promoteQueue() {
    const waiting = this.getWaitingQueue();
    for (const entry of waiting) {
      if (this.activeCount >= QUEUE_CONFIG.MAX_CONCURRENT_CREATES) break;
      entry.status = 'processing';
      this.activeCount++;
    }
  }
}

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

const DRAW_TIME = 80;
const MAX_ROUNDS = 3;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 5;
const SCORE_BASE = 100;

const CONFIG_LIMITS = {
  drawTime: { min: 30, max: 180, default: 80 },
  maxRounds: { min: 1, max: 10, default: 3 },
  maxPlayers: { min: 3, max: 8, default: 5 },
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.hostId = null;
    this.gameState = {
      phase: 'lobby',
      round: 0,
      maxRounds: MAX_ROUNDS,
      drawerId: null,
      currentWord: null,
      wordHint: null,
      timeLeft: DRAW_TIME,
      correctGuessers: new Set(),
      drawingData: [],
      scores: {},
      roundWinners: [],
      revealedPositions: new Set(),
      // ✅ playerOrder: urutan drawer yang sudah diacak saat startGame()
      // Index ini yang dipakai nextRound(), bukan sessions.keys()
      playerOrder: [],
      config: {
        drawTime: CONFIG_LIMITS.drawTime.default,
        maxRounds: CONFIG_LIMITS.maxRounds.default,
        maxPlayers: CONFIG_LIMITS.maxPlayers.default,
      },
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

    if (!this.hostId) {
      this.hostId = clientId;
    }

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

    this.send(clientId, {
      type: 'welcome',
      clientId,
      hostId: this.hostId,
      gameState: this.getPublicGameState(),
      players: this.getPlayerList(),
      config: this.gameState.config,
    });

    this.broadcast({
      type: 'player_joined',
      players: this.getPlayerList(),
      playerCount: this.sessions.size,
      hostId: this.hostId,
    }, clientId);
  }

  async handleMessage(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    const type = msg.type;

    if (type === 'set_username') {
      session.username = msg.username.slice(0, 20).trim() || session.username;
      this.broadcast({ type: 'player_joined', players: this.getPlayerList(), playerCount: this.sessions.size, hostId: this.hostId });

    } else if (type === 'set_config') {
      if (clientId !== this.hostId) return;
      if (this.gameState.phase !== 'lobby') return;

      const cfg = this.gameState.config;
      if (msg.drawTime !== undefined) {
        cfg.drawTime = Math.max(CONFIG_LIMITS.drawTime.min, Math.min(CONFIG_LIMITS.drawTime.max, parseInt(msg.drawTime) || cfg.drawTime));
      }
      if (msg.maxRounds !== undefined) {
        cfg.maxRounds = Math.max(CONFIG_LIMITS.maxRounds.min, Math.min(CONFIG_LIMITS.maxRounds.max, parseInt(msg.maxRounds) || cfg.maxRounds));
      }
      if (msg.maxPlayers !== undefined) {
        const newMax = Math.max(CONFIG_LIMITS.maxPlayers.min, Math.min(CONFIG_LIMITS.maxPlayers.max, parseInt(msg.maxPlayers) || cfg.maxPlayers));
        cfg.maxPlayers = Math.max(newMax, this.sessions.size);
      }
      this.broadcast({ type: 'config_update', config: cfg, hostId: this.hostId });

    } else if (type === 'set_ready') {
      session.isReady = msg.ready;
      this.broadcast({ type: 'player_ready', players: this.getPlayerList() });
      this.checkStartGame();

    } else if (type === 'draw') {
      if (clientId !== this.gameState.drawerId) return;
      if (this.gameState.phase !== 'drawing') return;
      this.gameState.drawingData.push(msg.data);
      this.broadcastExcept(clientId, { type: 'draw', data: msg.data });

    } else if (type === 'clear_canvas') {
      if (clientId !== this.gameState.drawerId) return;
      this.gameState.drawingData = [];
      this.broadcast({ type: 'clear_canvas' });

    } else if (type === 'set_word') {
      if (clientId !== this.gameState.drawerId) return;
      if (this.gameState.phase !== 'drawing') return;
      if (this.gameState.currentWord) return;
      const word = (msg.word || '').toLowerCase().trim().replace(/[^a-z0-9 ]/gi, '').slice(0, 30);
      if (!word || word.length < 2) return;
      this.gameState.currentWord = word;
      this.gameState.wordHint = this.buildSecondLetterHint(word);
      this.broadcastExcept(this.gameState.drawerId, {
        type: 'hint_update',
        hint: this.gameState.wordHint,
        wordLength: word.length,
      });
      this.startRoundTimer();

    } else if (type === 'approve_guess') {
      if (clientId !== this.gameState.drawerId) return;
      if (this.gameState.phase !== 'drawing') return;
      const targetId = msg.clientId;
      if (!targetId || this.gameState.correctGuessers.has(targetId)) return;
      const targetSession = this.sessions.get(targetId);
      if (!targetSession) return;
      this.gameState.correctGuessers.add(targetId);
      const timeBonus = Math.floor((this.gameState.timeLeft / this.gameState.config.drawTime) * SCORE_BASE);
      const points = SCORE_BASE + timeBonus;
      targetSession.score += points;
      this.gameState.scores[targetId] = targetSession.score;
      const drawerSession = this.sessions.get(this.gameState.drawerId);
      if (drawerSession) {
        drawerSession.score += Math.floor(points * 0.5);
        this.gameState.scores[this.gameState.drawerId] = drawerSession.score;
      }
      this.broadcast({ type: 'correct_guess', clientId: targetId, username: targetSession.username, points, scores: this.getScores() });
      const nonDrawers = [...this.sessions.keys()].filter(id => id !== this.gameState.drawerId);
      if (this.gameState.correctGuessers.size >= nonDrawers.length) {
        this.endRound('all_guessed');
      }

    } else if (type === 'guess') {
      this.handleGuess(clientId, msg.text);

    } else if (type === 'chat') {
      const sanitized = msg.text.slice(0, 200);
      this.broadcast({
        type: 'chat',
        username: session.username,
        text: sanitized,
        clientId,
      });

    } else if (type === 'start_game') {
      if (this.gameState.phase === 'lobby' && this.sessions.size >= MIN_PLAYERS) {
        this.startGame();
      } else if (this.sessions.size < MIN_PLAYERS) {
        this.send(clientId, { type: 'error', message: `Butuh minimal ${MIN_PLAYERS} pemain!` });
      }

    } else if (type === 'ping') {
      this.send(clientId, { type: 'pong', timestamp: msg.timestamp });
    }
  }

  handleGuess(clientId, text) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    if (this.gameState.phase !== 'drawing') return;
    if (clientId === this.gameState.drawerId) return;
    if (this.gameState.correctGuessers.has(clientId)) return;
    if (!this.gameState.currentWord) return;
    this.broadcast({
      type: 'wrong_guess',
      username: session.username,
      text: text.trim().slice(0, 100),
      clientId,
    });
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
    this.gameState.maxRounds = this.gameState.config.maxRounds;

    for (const [id, session] of this.sessions) {
      session.score = 0;
      this.gameState.scores[id] = 0;
    }

    // ✅ Buat urutan drawer yang benar-benar acak:
    //    - Ambil semua pemain yang ada
    //    - Fisher-Yates shuffle
    //    - Simpan ke playerOrder — inilah urutan giliran menggambar sepanjang game
    const allIds = [...this.sessions.keys()];
    for (let i = allIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
    }
    this.gameState.playerOrder = allIds;

    // Kirim playerOrder ke semua client agar tahu urutan giliran
    this.broadcast({
      type: 'game_starting',
      countdown: 3,
      playerOrder: allIds.map(id => ({
        clientId: id,
        username: this.sessions.get(id)?.username,
      })),
    });

    setTimeout(() => this.nextRound(), 3000);
  }

  nextRound() {
    const totalRounds = this.gameState.maxRounds * this.gameState.playerOrder.length;
    if (this.gameState.round >= totalRounds) {
      this.endGame();
      return;
    }

    this.gameState.round++;
    this.gameState.correctGuessers = new Set();
    this.gameState.drawingData = [];
    this.gameState.timeLeft = this.gameState.config.drawTime;
    this.gameState.roundWinners = [];
    this.gameState.revealedPositions = new Set();
    this.gameState.currentWord = null;
    this.gameState.wordHint = null;

    // ✅ PERBAIKAN UTAMA:
    //    Gunakan playerOrder (urutan acak dari startGame) bukan sessions.keys()
    //    Kalau ada pemain yang disconnect, skip dan cari yang masih aktif
    const orderLen = this.gameState.playerOrder.length;
    const roundIdx  = (this.gameState.round - 1) % orderLen;

    // Cari drawer di urutan ini yang masih terhubung
    // Jika disconnect, geser ke slot berikutnya dalam playerOrder
    let drawerId = null;
    for (let attempt = 0; attempt < orderLen; attempt++) {
      const candidateIdx = (roundIdx + attempt) % orderLen;
      const candidateId  = this.gameState.playerOrder[candidateIdx];
      if (this.sessions.has(candidateId)) {
        drawerId = candidateId;
        break;
      }
    }

    // Tidak ada pemain yang aktif sama sekali (edge case)
    if (!drawerId) {
      this.endGame();
      return;
    }

    this.gameState.drawerId = drawerId;
    this.gameState.phase = 'drawing';

    const drawerName = this.sessions.get(drawerId)?.username;
    const totalRoundsDisplay = this.gameState.maxRounds * this.gameState.playerOrder.length;

    // Kirim ke drawer
    this.send(drawerId, {
      type: 'round_start_drawer',
      round: this.gameState.round,
      maxRounds: totalRoundsDisplay,
      drawerName,
      timeLeft: this.gameState.config.drawTime,
    });

    // Kirim ke guesser
    this.broadcastExcept(drawerId, {
      type: 'round_start_guesser',
      round: this.gameState.round,
      maxRounds: totalRoundsDisplay,
      drawerId,
      drawerName,
      hint: '____',
      wordLength: 0,
      timeLeft: this.gameState.config.drawTime,
    });
  }

  buildSecondLetterHint(word) {
    return word.split('').map((c, i) => {
      if (c === ' ') return ' ';
      return i === 1 ? c : '_';
    }).join('');
  }

  startRoundTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    const drawTime = this.gameState.config.drawTime;
    const revealAtElapsed = [
      Math.floor(drawTime * 0.5),
      Math.floor(drawTime * 0.75),
    ];
    let lastRevealCount = 0;

    this.timerInterval = setInterval(() => {
      this.gameState.timeLeft--;
      const elapsed = drawTime - this.gameState.timeLeft;
      const revealCount = revealAtElapsed.filter(t => elapsed >= t).length;

      if (revealCount > lastRevealCount) {
        lastRevealCount = revealCount;
        const newHint = this.revealMoreHint(this.gameState.currentWord, revealCount);
        if (newHint !== this.gameState.wordHint) {
          this.gameState.wordHint = newHint;
          this.broadcastExcept(this.gameState.drawerId, {
            type: 'hint_update',
            hint: newHint,
          });
        }
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
      this.gameState.playerOrder = [];
      for (const session of this.sessions.values()) {
        session.isReady = false;
        session.score = 0;
      }
      this.broadcast({ type: 'back_to_lobby', players: this.getPlayerList() });
    }, 10000);
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);

    if (this.hostId === clientId) {
      const next = this.sessions.keys().next().value;
      this.hostId = next || null;
    }

    this.broadcast({
      type: 'player_left',
      clientId,
      players: this.getPlayerList(),
      playerCount: this.sessions.size,
      hostId: this.hostId,
    });

    if (this.gameState.phase === 'drawing' && this.gameState.drawerId === clientId) {
      this.endRound('drawer_left');
    }

    if (
      this.sessions.size < MIN_PLAYERS &&
      this.gameState.phase !== 'lobby' &&
      this.gameState.phase !== 'gameEnd'
    ) {
      if (this.timerInterval) clearInterval(this.timerInterval);
      this.gameState.phase = 'lobby';
      this.broadcast({ type: 'game_cancelled', reason: 'Pemain terlalu sedikit', players: this.getPlayerList() });
    }
  }

  generateInitialHint(word) {
    this.gameState.revealedPositions = new Set();
    return word.split('').map(c => c === ' ' ? ' ' : '_').join('');
  }

  revealMoreHint(word, totalRevealCount) {
    const chars = word.split('');
    const hiddenPositions = chars
      .map((c, i) => i)
      .filter(i => chars[i] !== ' ' && !this.gameState.revealedPositions.has(i));

    const targetTotal = Math.floor(chars.filter(c => c !== ' ').length * totalRevealCount * 0.3);
    const toAdd = Math.max(0, targetTotal - this.gameState.revealedPositions.size);

    const shuffled = hiddenPositions.sort(() => Math.random() - 0.5);
    for (let i = 0; i < toAdd && i < shuffled.length; i++) {
      this.gameState.revealedPositions.add(shuffled[i]);
    }

    return chars.map((c, i) => {
      if (c === ' ') return ' ';
      if (this.gameState.revealedPositions.has(i)) return c;
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
      config: this.gameState.config,
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
