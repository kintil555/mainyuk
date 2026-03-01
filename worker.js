// =============================================================================
// CLOUDFLARE WORKER - Skribbl-style Drawing Game
// Deploy sebagai Cloudflare Worker dengan Durable Objects enabled
//
// SETUP SECRET KEY:
//   Cloudflare Dashboard → Workers → Settings → Variables → Add Secret
//   Name: TURNSTILE_SECRET
//   Value: (isi dengan secret key Turnstile kamu)
// =============================================================================

// =============================================================================
// CONFIG ANTRIAN
// =============================================================================
const QUEUE_CONFIG = {
  MAX_CONCURRENT_CREATES: 3,   // Maks pembuatan room bersamaan tanpa antri
  BASE_WAIT_PER_PERSON: 45,    // Detik tunggu per orang di depan (45 detik)
  MAX_WAIT_SECONDS: 240,       // Maks tunggu 4 menit
  QUEUE_EXPIRY_MS: 5 * 60 * 1000, // Entry antrian kedaluwarsa setelah 5 menit
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

    // Route: WebSocket untuk room tertentu
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2] || 'default';
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Route: Cek status antrian
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

    // Route: Buat room baru — wajib lewat validasi Turnstile + sistem antri
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

      // Verifikasi CAPTCHA
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

      // Cek antrian via QueueManager Durable Object
      const queueStub = env.QUEUE_MANAGER.get(env.QUEUE_MANAGER.idFromName('global'));
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

      const queueReq = new Request('https://internal/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId, clientIp }),
      });
      const queueRes = await queueStub.fetch(queueReq);
      const queueData = await queueRes.json();

      // Masih harus antri
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

      // Giliran sudah tiba — buat room
      if (queueData.status === 'ready' || queueData.status === 'immediate') {
        const roomId = generateRoomId();
        // Beritahu QueueManager bahwa slot ini selesai
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
// Mengelola antrian pembuatan room secara global
// =============================================================================
export class QueueManager {
  constructor(state, env) {
    this.state = state;
    // queue: array of { queueId, clientIp, joinedAt, status: 'waiting'|'processing' }
    this.queue = [];
    this.activeCount = 0; // Berapa yang sedang diproses
    this.initialized = false;
  }

  async ensureLoaded() {
    if (this.initialized) return;
    this.queue = (await this.state.storage.get('queue')) || [];
    this.activeCount = (await this.state.storage.get('activeCount')) || 0;
    this.initialized = true;
    // Bersihkan entry kedaluwarsa saat load
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
    // Kurangi activeCount jika ada yang expire saat processing
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
    return waiting.findIndex(e => e.queueId === queueId) + 1; // 1-based
  }

  calcEstimatedWait(position) {
    // Setiap orang di depan = BASE_WAIT_PER_PERSON detik + sedikit variasi
    const raw = position * QUEUE_CONFIG.BASE_WAIT_PER_PERSON;
    return Math.min(raw, QUEUE_CONFIG.MAX_WAIT_SECONDS);
  }

  async fetch(request) {
    await this.ensureLoaded();
    this.cleanExpired();

    const url = new URL(request.url);

    // POST /enqueue — tambah ke antrian atau langsung jika kosong
    if (url.pathname === '/enqueue') {
      const body = await request.json();
      let { queueId, clientIp } = body;

      // Cek apakah queueId ini sudah ada di antrian
      if (queueId) {
        const existing = this.queue.find(e => e.queueId === queueId);
        if (existing) {
          if (existing.status === 'processing') {
            // Giliran sudah tiba!
            await this.save();
            return new Response(JSON.stringify({ status: 'ready', queueId }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } else {
            // Masih menunggu
            const position = this.getPosition(queueId);
            const estimatedWait = this.calcEstimatedWait(position);
            await this.save();
            return new Response(JSON.stringify({
              status: 'queued', queueId, position, estimatedWait,
            }), { headers: { 'Content-Type': 'application/json' } });
          }
        }
      }

      // Request baru
      const newQueueId = queueId || crypto.randomUUID().slice(0, 12);

      // Slot langsung tersedia?
      if (this.activeCount < QUEUE_CONFIG.MAX_CONCURRENT_CREATES && this.getWaitingQueue().length === 0) {
        this.activeCount++;
        this.queue.push({ queueId: newQueueId, clientIp, joinedAt: Date.now(), status: 'processing' });
        await this.save();
        return new Response(JSON.stringify({ status: 'immediate', queueId: newQueueId }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Harus antri
      this.queue.push({ queueId: newQueueId, clientIp, joinedAt: Date.now(), status: 'waiting' });

      // Promosikan antrian yang bisa diproses
      this.promoteQueue();

      const position = this.getPosition(newQueueId);
      const estimatedWait = this.calcEstimatedWait(position);

      await this.save();
      return new Response(JSON.stringify({
        status: 'queued', queueId: newQueueId, position, estimatedWait,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // GET /status — cek status antrian
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

    // POST /done — tandai slot selesai, promosikan antrian berikutnya
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
    // Pindahkan entry 'waiting' ke 'processing' selama ada slot
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

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
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
      // Menyimpan posisi huruf yang sudah dibuka agar konsisten
      revealedPositions: new Set(),
      // Urutan pemain yang sudah di-shuffle untuk giliran drawer
      playerOrder: [],
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

    this.send(clientId, {
      type: 'welcome',
      clientId,
      gameState: this.getPublicGameState(),
      players: this.getPlayerList(),
    });

    this.broadcast({
      type: 'player_joined',
      players: this.getPlayerList(),
      playerCount: this.sessions.size,
    }, clientId);
  }

  async handleMessage(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // ✅ Fix: pindahkan semua case ke blok if-else agar tidak ada masalah
    //    `const` di dalam switch yang menyebabkan error di beberapa runtime
    const type = msg.type;

    if (type === 'set_username') {
      session.username = msg.username.slice(0, 20).trim() || session.username;
      this.broadcast({ type: 'player_joined', players: this.getPlayerList(), playerCount: this.sessions.size });

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
      // Drawer mengirim kata yang dipilih sendiri
      if (clientId !== this.gameState.drawerId) return;
      if (this.gameState.phase !== 'drawing') return;
      if (this.gameState.currentWord) return; // sudah di-set
      const word = (msg.word || '').toLowerCase().trim().replace(/[^a-z0-9 ]/gi, '').slice(0, 30);
      if (!word || word.length < 2) return;
      this.gameState.currentWord = word;
      // Buat hint: hanya huruf ke-2 (index 1) yang kelihatan
      this.gameState.wordHint = this.buildSecondLetterHint(word);
      // Kirim hint ke guesser
      this.broadcastExcept(this.gameState.drawerId, {
        type: 'hint_update',
        hint: this.gameState.wordHint,
        wordLength: word.length,
      });
      // Mulai timer sekarang
      this.startRoundTimer();

    } else if (type === 'approve_guess') {
      // Drawer approve jawaban peserta
      if (clientId !== this.gameState.drawerId) return;
      if (this.gameState.phase !== 'drawing') return;
      const targetId = msg.clientId;
      if (!targetId || this.gameState.correctGuessers.has(targetId)) return;
      const targetSession = this.sessions.get(targetId);
      if (!targetSession) return;
      this.gameState.correctGuessers.add(targetId);
      const timeBonus = Math.floor((this.gameState.timeLeft / DRAW_TIME) * SCORE_BASE);
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
    if (!this.gameState.currentWord) return; // belum ada kata
    // Semua tebakan dikirim sebagai wrong_guess — drawer yang approve via tombol ✓
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

    for (const [id, session] of this.sessions) {
      session.score = 0;
      this.gameState.scores[id] = 0;
    }

    // Acak urutan pemain sekali di awal game — ini yang menentukan giliran drawer
    const allIds = [...this.sessions.keys()];
    for (let i = allIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
    }
    this.gameState.playerOrder = allIds;

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
    this.gameState.revealedPositions = new Set();
    this.gameState.currentWord = null; // drawer yang isi
    this.gameState.wordHint = null;

    // Pakai playerOrder yang sudah di-shuffle — bukan sessions.keys() yang selalu urut join
    const playerIds = this.gameState.playerOrder.filter(id => this.sessions.has(id));
    // Kalau ada pemain baru join setelah game mulai, tambahkan di akhir
    for (const id of this.sessions.keys()) {
      if (!playerIds.includes(id)) playerIds.push(id);
    }
    const drawerIndex = (this.gameState.round - 1) % playerIds.length;
    this.gameState.drawerId = playerIds[drawerIndex];
    this.gameState.phase = 'drawing';

    // Kirim ke drawer — tanpa kata, drawer yang input sendiri
    this.send(this.gameState.drawerId, {
      type: 'round_start_drawer',
      round: this.gameState.round,
      maxRounds: this.gameState.maxRounds * playerIds.length,
      drawerName: this.sessions.get(this.gameState.drawerId)?.username,
      timeLeft: DRAW_TIME,
    });

    // Kirim ke guesser — menunggu hint dari drawer
    this.broadcastExcept(this.gameState.drawerId, {
      type: 'round_start_guesser',
      round: this.gameState.round,
      maxRounds: this.gameState.maxRounds * playerIds.length,
      drawerId: this.gameState.drawerId,
      drawerName: this.sessions.get(this.gameState.drawerId)?.username,
      hint: '____',
      wordLength: 0,
      timeLeft: DRAW_TIME,
    });
    // Timer dimulai setelah drawer submit kata (set_word)
  }

  // Hint: hanya huruf ke-2 (index 1) tiap kata yang kelihatan
  buildSecondLetterHint(word) {
    return word.split('').map((c, i) => {
      if (c === ' ') return ' ';
      return i === 1 ? c : '_';
    }).join('');
  }

  startRoundTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    // Waktu reveal: di 50% dan 25% sisa waktu
    const revealAtElapsed = [
      Math.floor(DRAW_TIME * 0.5),
      Math.floor(DRAW_TIME * 0.75),
    ];
    let lastRevealCount = 0;

    this.timerInterval = setInterval(() => {
      this.gameState.timeLeft--;
      const elapsed = DRAW_TIME - this.gameState.timeLeft;
      const revealCount = revealAtElapsed.filter(t => elapsed >= t).length;

      // ✅ Hanya update hint jika jumlah reveal bertambah
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

  pickWords(count) {
    const shuffled = [...ALL_WORDS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  // ✅ Generate hint awal: semua tersembunyi (hanya spasi yang kelihatan)
  generateInitialHint(word) {
    this.gameState.revealedPositions = new Set();
    return word.split('').map(c => c === ' ' ? ' ' : '_').join('');
  }

  // ✅ Reveal huruf secara bertahap — posisi yang sudah terbuka tidak berubah
  revealMoreHint(word, totalRevealCount) {
    const chars = word.split('');
    const hiddenPositions = chars
      .map((c, i) => i)
      .filter(i => chars[i] !== ' ' && !this.gameState.revealedPositions.has(i));

    // Hitung berapa huruf yang harus ditambah
    const targetTotal = Math.floor(chars.filter(c => c !== ' ').length * totalRevealCount * 0.3);
    const toAdd = Math.max(0, targetTotal - this.gameState.revealedPositions.size);

    // Acak posisi yang belum terbuka dan ambil sejumlah toAdd
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
