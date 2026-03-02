// =============================================================================
// CLOUDFLARE WORKER - GambarYuk! Drawing Game
// + Discord OAuth 2.0 Login
// =============================================================================
//
// SETUP DISCORD OAUTH:
// 1. Buka https://discord.com/developers/applications
// 2. Buat aplikasi baru (atau pakai yang sudah ada)
// 3. Di menu "OAuth2":
//    - Client ID    → simpan sebagai env var: DISCORD_CLIENT_ID
//    - Client Secret → simpan sebagai env var: DISCORD_CLIENT_SECRET
//    - Tambah Redirect URI: https://mainyuk.secret5.workers.dev/auth/discord/callback
// 4. Di Cloudflare Workers dashboard, tambah env vars:
//    - DISCORD_CLIENT_ID
//    - DISCORD_CLIENT_SECRET
//    - DISCORD_REDIRECT_URI = https://mainyuk.secret5.workers.dev/auth/discord/callback
//    - SESSION_SECRET = (random string panjang, untuk sign token)
//    - TURNSTILE_SECRET (sudah ada sebelumnya)
//
// =============================================================================

const QUEUE_CONFIG = {
  MAX_CONCURRENT_CREATES: 3,
  BASE_WAIT_PER_PERSON: 45,
  MAX_WAIT_SECONDS: 240,
  QUEUE_EXPIRY_MS: 5 * 60 * 1000,
};

// Discord OAuth scopes yang dibutuhkan
const DISCORD_SCOPES = 'identify';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ── DISCORD OAUTH: Step 1 — Redirect ke Discord ──────────────────────
    if (url.pathname === '/auth/discord') {
      const state = url.searchParams.get('state') || crypto.randomUUID().slice(0, 16);
      const clientId = env.DISCORD_CLIENT_ID;
      const redirectUri = env.DISCORD_REDIRECT_URI || (url.origin + '/auth/discord/callback');

      if (!clientId) {
        return new Response(JSON.stringify({ error: 'Discord OAuth belum dikonfigurasi.' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const discordAuthUrl = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: DISCORD_SCOPES,
        state: state,
        prompt: 'none', // skip consent screen jika sudah pernah login
      });

      return Response.redirect(discordAuthUrl, 302);
    }

    // ── DISCORD OAUTH: Step 2 — Callback dari Discord ────────────────────
    if (url.pathname === '/auth/discord/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      // state bisa divalidasi di sini jika disimpan di KV

      if (error || !code) {
        return new Response(JSON.stringify({ error: error || 'Tidak ada code dari Discord' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const clientId = env.DISCORD_CLIENT_ID;
      const clientSecret = env.DISCORD_CLIENT_SECRET;
      const redirectUri = env.DISCORD_REDIRECT_URI || (url.origin + '/auth/discord/callback');

      if (!clientId || !clientSecret) {
        return new Response(JSON.stringify({ error: 'Discord OAuth credentials belum dikonfigurasi di Worker env vars.' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      try {
        // Tukar code → access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
          }),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          console.error('Discord token exchange failed:', errBody);
          return new Response(JSON.stringify({ error: 'Gagal tukar token Discord.' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // Ambil info user dari Discord
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: 'Bearer ' + accessToken },
        });

        if (!userRes.ok) {
          return new Response(JSON.stringify({ error: 'Gagal ambil data user Discord.' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const userData = await userRes.json();
        // userData: { id, username, global_name, avatar, discriminator, ... }

        // Generate session token (simpan di KV supaya bisa divalidasi)
        const sessionToken = await generateSessionToken(env, userData);

        // Kembalikan data user + session token ke frontend
        return new Response(JSON.stringify({
          id: userData.id,
          username: userData.username,
          global_name: userData.global_name || userData.username,
          avatar: userData.avatar,
          sessionToken: sessionToken,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      } catch (e) {
        console.error('Discord callback error:', e);
        return new Response(JSON.stringify({ error: 'Internal error saat proses OAuth: ' + e.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── AUTH: Validate session & return user info ─────────────────────────
    if (url.pathname === '/auth/me') {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '').trim();

      if (!token) {
        return new Response(JSON.stringify({ error: 'No token' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userData = await validateSessionToken(env, token);
      if (!userData) {
        return new Response(JSON.stringify({ error: 'Session tidak valid atau kedaluwarsa' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(userData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // --- WebSocket room ---
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2] || 'default';
      const id = env.GAME_ROOM.idFromName(roomId);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    // --- Queue status ---
    if (url.pathname === '/queue-status') {
      const queueId = url.searchParams.get('queueId');
      if (!queueId) return new Response(JSON.stringify({ error: 'queueId diperlukan' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const stub = env.QUEUE_MANAGER.get(env.QUEUE_MANAGER.idFromName('global'));
      const res = await stub.fetch(new Request('https://internal/status?queueId=' + queueId));
      return new Response(await res.text(), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Room list (public rooms) ---
    if (url.pathname === '/rooms') {
      const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('global'));
      const res = await stub.fetch(new Request('https://internal/list'));
      return new Response(await res.text(), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Create room ---
    if (url.pathname === '/create-room') {
      let captchaToken = null, queueId = null, roomName = null, password = null;
      let discordSessionToken = null, discordId = null;

      if (request.method === 'POST') {
        try {
          const b = await request.json();
          captchaToken = b.captcha;
          queueId = b.queueId;
          roomName = b.roomName;
          password = b.password || null;
          discordSessionToken = b.discordSessionToken || null;
          discordId = b.discordId || null;
        } catch (_) {}
      } else {
        captchaToken = url.searchParams.get('captcha');
        queueId = url.searchParams.get('queueId');
      }

      if (!captchaToken) {
        return new Response(JSON.stringify({ error: 'CAPTCHA token tidak ditemukan' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Discord users: validasi session token, skip Turnstile
      if (discordSessionToken && captchaToken && captchaToken.startsWith('discord:')) {
        const discordUserData = await validateSessionToken(env, discordSessionToken);
        if (!discordUserData || discordUserData.id !== discordId) {
          return new Response(JSON.stringify({ error: 'Sesi Discord tidak valid.' }), {
            status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Discord user valid, skip CAPTCHA
      } else {
        // Regular Turnstile CAPTCHA check
        const secret = env.TURNSTILE_SECRET;
        if (secret) {
          const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret, response: captchaToken, remoteip: request.headers.get('CF-Connecting-IP') || undefined }),
          });
          const vd = await vr.json();
          if (!vd.success) {
            return new Response(JSON.stringify({ error: 'Verifikasi CAPTCHA gagal. Coba lagi.', codes: vd['error-codes'] || [] }), {
              status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }
      }

      const queueStub = env.QUEUE_MANAGER.get(env.QUEUE_MANAGER.idFromName('global'));
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const qr = await queueStub.fetch(new Request('https://internal/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId, clientIp }),
      }));
      const qd = await qr.json();

      if (qd.status === 'queued') {
        return new Response(JSON.stringify({ queued: true, queueId: qd.queueId, position: qd.position, estimatedWait: qd.estimatedWait }), {
          status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (qd.status === 'ready' || qd.status === 'immediate') {
        const roomId = generateRoomId();
        await queueStub.fetch(new Request('https://internal/done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueId: qd.queueId }),
        }));
        const registry = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('global'));
        await registry.fetch(new Request('https://internal/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, roomName: roomName || ('Room ' + roomId), password: password || null }),
        }));
        return new Response(JSON.stringify({ roomId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: 'Status antrian tidak dikenal' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // --- Update room info ---
    if (url.pathname === '/room-update') {
      if (request.method === 'POST') {
        try {
          const b = await request.json();
          const registry = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('global'));
          await registry.fetch(new Request('https://internal/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(b),
          }));
        } catch (_) {}
      }
      return new Response('ok', { headers: corsHeaders });
    }

    return new Response('GambarYuk Worker Active', { headers: corsHeaders });
  },
};

// =============================================================================
// SESSION TOKEN HELPERS (menggunakan KV atau simple HMAC)
// =============================================================================

/**
 * Generate session token dan simpan di KV (jika tersedia) atau pakai HMAC.
 * Token disimpan 7 hari.
 */
async function generateSessionToken(env, userData) {
  const tokenPayload = {
    id: userData.id,
    username: userData.username,
    global_name: userData.global_name || userData.username,
    avatar: userData.avatar,
    iat: Date.now(),
    exp: Date.now() + (7 * 24 * 60 * 60 * 1000),
  };

  // Pakai KV jika tersedia untuk menyimpan session
  if (env.SESSIONS_KV) {
    const tokenId = crypto.randomUUID();
    await env.SESSIONS_KV.put(
      'session:' + tokenId,
      JSON.stringify(tokenPayload),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );
    return tokenId;
  }

  // Fallback: encode sebagai base64 JSON (tidak aman untuk produksi, tapi fungsional)
  // Untuk produksi sebaiknya gunakan KV atau gunakan HMAC signing
  return btoa(JSON.stringify(tokenPayload));
}

/**
 * Validasi session token. Return user data atau null jika invalid.
 */
async function validateSessionToken(env, token) {
  if (!token) return null;

  // Coba KV dulu
  if (env.SESSIONS_KV) {
    try {
      const raw = await env.SESSIONS_KV.get('session:' + token);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.exp && data.exp < Date.now()) {
        await env.SESSIONS_KV.delete('session:' + token);
        return null;
      }
      return data;
    } catch (_) {}
  }

  // Fallback: decode base64
  try {
    const data = JSON.parse(atob(token));
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// =============================================================================
// DURABLE OBJECT - Room Registry
// =============================================================================
export class RoomRegistry {
  constructor(state) {
    this.state = state;
    this.rooms = new Map();
    this.initialized = false;
  }

  async ensureLoaded() {
    if (this.initialized) return;
    const stored = (await this.state.storage.get('rooms')) || [];
    this.rooms = new Map(stored);
    this.initialized = true;
    this.cleanStale();
  }

  cleanStale() {
    const now = Date.now();
    for (const [id, r] of this.rooms) {
      if (now - r.createdAt > 4 * 60 * 60 * 1000) this.rooms.delete(id);
    }
  }

  async save() {
    await this.state.storage.put('rooms', [...this.rooms.entries()]);
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (url.pathname === '/list') {
      const list = [...this.rooms.entries()]
        .map(([id, r]) => ({ roomId: id, roomName: r.roomName, playerCount: r.playerCount || 0, maxPlayers: r.maxPlayers || 5, phase: r.phase || 'lobby', hasPassword: !!r.password, createdAt: r.createdAt }))
        .filter(r => r.phase !== 'dead')
        .sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/register') {
      const b = await request.json();
      this.rooms.set(b.roomId, { roomName: b.roomName, password: b.password, playerCount: 0, maxPlayers: 5, phase: 'lobby', createdAt: Date.now() });
      await this.save();
      return new Response('ok');
    }

    if (url.pathname === '/update') {
      const b = await request.json();
      const r = this.rooms.get(b.roomId);
      if (r) {
        if (b.playerCount !== undefined) r.playerCount = b.playerCount;
        if (b.phase !== undefined) r.phase = b.phase;
        if (b.maxPlayers !== undefined) r.maxPlayers = b.maxPlayers;
        if (b.dead) this.rooms.delete(b.roomId);
        else this.rooms.set(b.roomId, r);
        await this.save();
      }
      return new Response('ok');
    }

    if (url.pathname === '/verify-password') {
      const b = await request.json();
      const r = this.rooms.get(b.roomId);
      if (!r) return new Response(JSON.stringify({ ok: false, error: 'Room tidak ditemukan' }), { headers: { 'Content-Type': 'application/json' } });
      if (!r.password) return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      const match = r.password === b.password;
      return new Response(JSON.stringify({ ok: match, error: match ? null : 'Password salah!' }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('RoomRegistry Active');
  }
}

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
    this.queue = this.queue.filter(e => now - e.joinedAt <= QUEUE_CONFIG.QUEUE_EXPIRY_MS);
    const removed = before - this.queue.length;
    if (removed > 0) this.activeCount = Math.max(0, this.activeCount - removed);
  }

  getWaitingQueue() { return this.queue.filter(e => e.status === 'waiting'); }
  getPosition(queueId) { return this.getWaitingQueue().findIndex(e => e.queueId === queueId) + 1; }
  calcEstimatedWait(position) { return Math.min(position * QUEUE_CONFIG.BASE_WAIT_PER_PERSON, QUEUE_CONFIG.MAX_WAIT_SECONDS); }

  async fetch(request) {
    await this.ensureLoaded();
    this.cleanExpired();
    const url = new URL(request.url);

    if (url.pathname === '/enqueue') {
      const { queueId, clientIp } = await request.json();
      if (queueId) {
        const existing = this.queue.find(e => e.queueId === queueId);
        if (existing) {
          if (existing.status === 'processing') { await this.save(); return new Response(JSON.stringify({ status: 'ready', queueId }), { headers: { 'Content-Type': 'application/json' } }); }
          const position = this.getPosition(queueId);
          await this.save();
          return new Response(JSON.stringify({ status: 'queued', queueId, position, estimatedWait: this.calcEstimatedWait(position) }), { headers: { 'Content-Type': 'application/json' } });
        }
      }
      const newId = queueId || crypto.randomUUID().slice(0, 12);
      if (this.activeCount < QUEUE_CONFIG.MAX_CONCURRENT_CREATES && this.getWaitingQueue().length === 0) {
        this.activeCount++;
        this.queue.push({ queueId: newId, clientIp, joinedAt: Date.now(), status: 'processing' });
        await this.save();
        return new Response(JSON.stringify({ status: 'immediate', queueId: newId }), { headers: { 'Content-Type': 'application/json' } });
      }
      this.queue.push({ queueId: newId, clientIp, joinedAt: Date.now(), status: 'waiting' });
      this.promoteQueue();
      const pos = this.getPosition(newId);
      await this.save();
      return new Response(JSON.stringify({ status: 'queued', queueId: newId, position: pos, estimatedWait: this.calcEstimatedWait(pos) }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/status') {
      const queueId = url.searchParams.get('queueId');
      const entry = this.queue.find(e => e.queueId === queueId);
      if (!entry) return new Response(JSON.stringify({ status: 'not_found' }), { headers: { 'Content-Type': 'application/json' } });
      if (entry.status === 'processing') { await this.save(); return new Response(JSON.stringify({ status: 'ready', queueId }), { headers: { 'Content-Type': 'application/json' } }); }
      const pos = this.getPosition(queueId);
      await this.save();
      return new Response(JSON.stringify({ status: 'queued', queueId, position: pos, estimatedWait: this.calcEstimatedWait(pos), totalWaiting: this.getWaitingQueue().length }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/done') {
      const { queueId } = await request.json();
      this.queue = this.queue.filter(e => e.queueId !== queueId);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.promoteQueue();
      await this.save();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('QueueManager Active');
  }

  promoteQueue() {
    for (const entry of this.getWaitingQueue()) {
      if (this.activeCount >= QUEUE_CONFIG.MAX_CONCURRENT_CREATES) break;
      entry.status = 'processing'; this.activeCount++;
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
const DRAW_TIME = 80, MAX_ROUNDS = 3, MIN_PLAYERS = 3, MAX_PLAYERS = 5, SCORE_BASE = 100;
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
    this.roomId = null;
    this.gameState = {
      phase: 'lobby', round: 0, maxRounds: MAX_ROUNDS,
      drawerId: null, currentWord: null, wordHint: null,
      timeLeft: DRAW_TIME, correctGuessers: new Set(),
      drawingData: [], scores: {}, roundWinners: [],
      revealedPositions: new Set(), playerOrder: [],
      config: { drawTime: CONFIG_LIMITS.drawTime.default, maxRounds: CONFIG_LIMITS.maxRounds.default, maxPlayers: CONFIG_LIMITS.maxPlayers.default },
    };
    this.timerInterval = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 400 });
    const url = new URL(request.url);
    this.roomId = url.pathname.split('/')[2] || this.roomId;
    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server, request);
    return new Response(null, { status: 101, webSocket: client });
  }

  async notifyRegistry(updates) {
    if (!this.roomId || !this.env?.ROOM_REGISTRY) return;
    try {
      const registry = this.env.ROOM_REGISTRY.get(this.env.ROOM_REGISTRY.idFromName('global'));
      await registry.fetch(new Request('https://internal/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId, ...updates }),
      }));
    } catch (_) {}
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
      // Discord fields
      discordId: null,
      avatarUrl: null,
    };
    this.sessions.set(clientId, session);
    if (!this.hostId) this.hostId = clientId;

    ws.addEventListener('message', async (event) => {
      try { await this.handleMessage(clientId, JSON.parse(event.data)); } catch (e) { console.error(e); }
    });
    ws.addEventListener('close', () => this.handleDisconnect(clientId));
    ws.addEventListener('error', () => this.handleDisconnect(clientId));

    this.send(clientId, {
      type: 'welcome',
      clientId,
      hostId: this.hostId,
      gameState: this.getPublicGameState(),
      players: this.getPlayerList(),
      config: this.gameState.config,
    });
    this.broadcast({ type: 'player_joined', players: this.getPlayerList(), playerCount: this.sessions.size, hostId: this.hostId }, clientId);
    this.notifyRegistry({ playerCount: this.sessions.size, phase: this.gameState.phase, maxPlayers: this.gameState.config.maxPlayers });
  }

  async handleMessage(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    const type = msg.type;

    if (type === 'set_username') {
      session.username = (msg.username || '').slice(0, 20).trim() || session.username;

      // Simpan info Discord jika ada
      if (msg.discordId) session.discordId = msg.discordId;
      if (msg.avatarUrl) session.avatarUrl = msg.avatarUrl;
      if (msg.discordDisplayName) session.discordDisplayName = msg.discordDisplayName;

      this.broadcast({ type: 'player_joined', players: this.getPlayerList(), playerCount: this.sessions.size, hostId: this.hostId });

    } else if (type === 'set_config') {
      if (clientId !== this.hostId || this.gameState.phase !== 'lobby') return;
      const cfg = this.gameState.config;
      if (msg.drawTime !== undefined) cfg.drawTime = Math.max(CONFIG_LIMITS.drawTime.min, Math.min(CONFIG_LIMITS.drawTime.max, parseInt(msg.drawTime) || cfg.drawTime));
      if (msg.maxRounds !== undefined) cfg.maxRounds = Math.max(CONFIG_LIMITS.maxRounds.min, Math.min(CONFIG_LIMITS.maxRounds.max, parseInt(msg.maxRounds) || cfg.maxRounds));
      if (msg.maxPlayers !== undefined) cfg.maxPlayers = Math.max(Math.max(CONFIG_LIMITS.maxPlayers.min, Math.min(CONFIG_LIMITS.maxPlayers.max, parseInt(msg.maxPlayers) || cfg.maxPlayers)), this.sessions.size);
      this.broadcast({ type: 'config_update', config: cfg, hostId: this.hostId });
      this.notifyRegistry({ maxPlayers: cfg.maxPlayers });

    } else if (type === 'kick_player') {
      if (clientId !== this.hostId) return;
      if (this.gameState.phase !== 'lobby') return;
      const targetId = msg.targetId;
      if (!targetId || targetId === clientId) return;
      const target = this.sessions.get(targetId);
      if (!target) return;
      this.send(targetId, { type: 'kicked', reason: 'Kamu di-kick oleh host.' });
      try { target.ws.close(1000, 'Kicked'); } catch (_) {}
      this.sessions.delete(targetId);
      this.broadcast({ type: 'player_left', clientId: targetId, players: this.getPlayerList(), playerCount: this.sessions.size, hostId: this.hostId });
      this.notifyRegistry({ playerCount: this.sessions.size });

    } else if (type === 'set_ready') {
      session.isReady = msg.ready;
      this.broadcast({ type: 'player_ready', players: this.getPlayerList() });
      this.checkStartGame();

    } else if (type === 'draw') {
      if (clientId !== this.gameState.drawerId || this.gameState.phase !== 'drawing') return;
      this.gameState.drawingData.push(msg.data);
      this.broadcastExcept(clientId, { type: 'draw', data: msg.data });

    } else if (type === 'clear_canvas') {
      if (clientId !== this.gameState.drawerId) return;
      this.gameState.drawingData = [];
      this.broadcast({ type: 'clear_canvas' });

    } else if (type === 'set_word') {
      if (clientId !== this.gameState.drawerId || this.gameState.phase !== 'drawing' || this.gameState.currentWord) return;
      const word = (msg.word || '').toLowerCase().trim().replace(/[^a-z0-9 ]/gi, '').slice(0, 30);
      if (!word || word.length < 2) return;
      this.gameState.currentWord = word;
      this.gameState.wordHint = this.buildSecondLetterHint(word);
      this.broadcastExcept(this.gameState.drawerId, { type: 'hint_update', hint: this.gameState.wordHint, wordLength: word.length });
      this.startRoundTimer();

    } else if (type === 'approve_guess') {
      if (clientId !== this.gameState.drawerId || this.gameState.phase !== 'drawing') return;
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
      if (drawerSession) { drawerSession.score += Math.floor(points * 0.5); this.gameState.scores[this.gameState.drawerId] = drawerSession.score; }
      this.broadcast({ type: 'correct_guess', clientId: targetId, username: targetSession.username, points, scores: this.getScores() });
      const nonDrawers = [...this.sessions.keys()].filter(id => id !== this.gameState.drawerId);
      if (this.gameState.correctGuessers.size >= nonDrawers.length) this.endRound('all_guessed');

    } else if (type === 'guess') {
      this.handleGuess(clientId, msg.text);
    } else if (type === 'chat') {
      this.broadcast({ type: 'chat', username: session.username, text: (msg.text || '').slice(0, 200), clientId });
    } else if (type === 'start_game') {
      if (this.gameState.phase === 'lobby' && this.sessions.size >= MIN_PLAYERS) this.startGame();
      else if (this.sessions.size < MIN_PLAYERS) this.send(clientId, { type: 'error', message: `Butuh minimal ${MIN_PLAYERS} pemain!` });
    } else if (type === 'ping') {
      this.send(clientId, { type: 'pong', timestamp: msg.timestamp });
    }
  }

  handleGuess(clientId, text) {
    const session = this.sessions.get(clientId);
    if (!session || this.gameState.phase !== 'drawing' || clientId === this.gameState.drawerId || this.gameState.correctGuessers.has(clientId) || !this.gameState.currentWord) return;
    this.broadcast({ type: 'wrong_guess', username: session.username, text: (text || '').trim().slice(0, 100), clientId });
  }

  checkStartGame() {
    const players = [...this.sessions.values()];
    if (players.length >= MIN_PLAYERS && players.every(p => p.isReady)) this.startGame();
  }

  startGame() {
    if (this.gameState.phase !== 'lobby' && this.gameState.phase !== 'gameEnd') return;
    this.gameState.round = 0; this.gameState.phase = 'starting';
    this.gameState.maxRounds = this.gameState.config.maxRounds;
    for (const [id, s] of this.sessions) { s.score = 0; this.gameState.scores[id] = 0; }
    const allIds = [...this.sessions.keys()];
    for (let pass = 0; pass < 3; pass++) {
      for (let i = allIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
      }
    }
    this.gameState.playerOrder = allIds;
    this.broadcast({ type: 'game_starting', countdown: 3, playerOrder: allIds.map(id => ({ clientId: id, username: this.sessions.get(id)?.username })) });
    this.notifyRegistry({ phase: 'playing' });
    setTimeout(() => this.nextRound(), 3000);
  }

  nextRound() {
    const total = this.gameState.maxRounds * this.gameState.playerOrder.length;
    if (this.gameState.round >= total) { this.endGame(); return; }
    this.gameState.round++;
    this.gameState.correctGuessers = new Set(); this.gameState.drawingData = []; this.gameState.timeLeft = this.gameState.config.drawTime;
    this.gameState.roundWinners = []; this.gameState.revealedPositions = new Set(); this.gameState.currentWord = null; this.gameState.wordHint = null;
    const orderLen = this.gameState.playerOrder.length;
    const roundIdx = (this.gameState.round - 1) % orderLen;
    let drawerId = null;
    for (let a = 0; a < orderLen; a++) {
      const cid = this.gameState.playerOrder[(roundIdx + a) % orderLen];
      if (this.sessions.has(cid)) { drawerId = cid; break; }
    }
    if (!drawerId) { this.endGame(); return; }
    this.gameState.drawerId = drawerId; this.gameState.phase = 'drawing';
    const drawerName = this.sessions.get(drawerId)?.username;
    const totalDisplay = this.gameState.maxRounds * this.gameState.playerOrder.length;
    this.send(drawerId, { type: 'round_start_drawer', round: this.gameState.round, maxRounds: totalDisplay, drawerName, timeLeft: this.gameState.config.drawTime });
    this.broadcastExcept(drawerId, { type: 'round_start_guesser', round: this.gameState.round, maxRounds: totalDisplay, drawerId, drawerName, hint: '____', wordLength: 0, timeLeft: this.gameState.config.drawTime });
  }

  buildSecondLetterHint(word) {
    return word.split('').map((c, i) => c === ' ' ? ' ' : i === 1 ? c : '_').join('');
  }

  startRoundTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    const drawTime = this.gameState.config.drawTime;
    const revealAt = [Math.floor(drawTime * 0.5), Math.floor(drawTime * 0.75)];
    let lastReveal = 0;
    this.timerInterval = setInterval(() => {
      this.gameState.timeLeft--;
      const elapsed = drawTime - this.gameState.timeLeft;
      const rc = revealAt.filter(t => elapsed >= t).length;
      if (rc > lastReveal) {
        lastReveal = rc;
        const nh = this.revealMoreHint(this.gameState.currentWord, rc);
        if (nh !== this.gameState.wordHint) { this.gameState.wordHint = nh; this.broadcastExcept(this.gameState.drawerId, { type: 'hint_update', hint: nh }); }
      }
      this.broadcast({ type: 'timer', timeLeft: this.gameState.timeLeft });
      if (this.gameState.timeLeft <= 0) { clearInterval(this.timerInterval); this.endRound('time_up'); }
    }, 1000);
  }

  endRound(reason) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.gameState.phase = 'roundEnd';
    this.broadcast({ type: 'round_end', reason, word: this.gameState.currentWord, scores: this.getScores(), round: this.gameState.round });
    setTimeout(() => this.nextRound(), 5000);
  }

  endGame() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.gameState.phase = 'gameEnd';
    const finalScores = this.getScores();
    this.broadcast({ type: 'game_end', scores: finalScores, winner: finalScores[0]?.username });
    this.notifyRegistry({ phase: 'lobby' });
    setTimeout(() => {
      this.gameState.phase = 'lobby';
      this.gameState.playerOrder = [];
      for (const s of this.sessions.values()) { s.isReady = false; s.score = 0; }
      this.broadcast({ type: 'back_to_lobby', players: this.getPlayerList() });
    }, 10000);
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);
    if (this.hostId === clientId) this.hostId = this.sessions.keys().next().value || null;
    this.broadcast({ type: 'player_left', clientId, players: this.getPlayerList(), playerCount: this.sessions.size, hostId: this.hostId });
    this.notifyRegistry({ playerCount: this.sessions.size });
    if (this.sessions.size === 0) { this.notifyRegistry({ dead: true }); return; }
    if (this.gameState.phase === 'drawing' && this.gameState.drawerId === clientId) this.endRound('drawer_left');
    if (this.sessions.size < MIN_PLAYERS && !['lobby', 'gameEnd'].includes(this.gameState.phase)) {
      if (this.timerInterval) clearInterval(this.timerInterval);
      this.gameState.phase = 'lobby';
      this.broadcast({ type: 'game_cancelled', reason: 'Pemain terlalu sedikit', players: this.getPlayerList() });
      this.notifyRegistry({ phase: 'lobby' });
    }
  }

  revealMoreHint(word, totalRevealCount) {
    const chars = word.split('');
    const hidden = chars.map((c, i) => i).filter(i => chars[i] !== ' ' && !this.gameState.revealedPositions.has(i));
    const target = Math.floor(chars.filter(c => c !== ' ').length * totalRevealCount * 0.3);
    const toAdd = Math.max(0, target - this.gameState.revealedPositions.size);
    hidden.sort(() => Math.random() - 0.5).slice(0, toAdd).forEach(i => this.gameState.revealedPositions.add(i));
    return chars.map((c, i) => c === ' ' ? ' ' : this.gameState.revealedPositions.has(i) ? c : '_').join('');
  }

  getScores() {
    return [...this.sessions.entries()]
      .map(([id, s]) => ({ clientId: id, username: s.username, score: s.score, avatarUrl: s.avatarUrl || null }))
      .sort((a, b) => b.score - a.score);
  }

  getPlayerList() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      clientId: id,
      username: s.username,
      score: s.score,
      isReady: s.isReady,
      discordId: s.discordId || null,
      avatarUrl: s.avatarUrl || null,
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
    const s = this.sessions.get(clientId);
    if (s?.ws.readyState === WebSocket.OPEN) {
      try { s.ws.send(JSON.stringify(data)); } catch (_) {}
    }
  }

  broadcast(data, excludeId = null) {
    const j = JSON.stringify(data);
    for (const [id, s] of this.sessions) {
      if (id === excludeId) continue;
      if (s.ws.readyState === WebSocket.OPEN) {
        try { s.ws.send(j); } catch (_) {}
      }
    }
  }

  broadcastExcept(excludeId, data) { this.broadcast(data, excludeId); }
}
