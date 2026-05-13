"use strict";
(() => {
  // src/client/engine/GameLoop.ts
  var GameLoop = class {
    constructor(canvas2) {
      this.canvas = canvas2;
      this.scene = null;
      this.lastTimestamp = 0;
      this.rafId = 0;
      this.running = false;
      this.ctx = canvas2.getContext("2d");
      this.tick = this.tick.bind(this);
    }
    /** Swap the active scene (menu → lobby → gameplay, etc.). */
    setScene(scene) {
      this.scene = scene;
    }
    start() {
      if (this.running) return;
      this.running = true;
      this.lastTimestamp = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
    stop() {
      this.running = false;
      cancelAnimationFrame(this.rafId);
    }
    tick(timestamp) {
      const dt = (timestamp - this.lastTimestamp) / 1e3;
      this.lastTimestamp = timestamp;
      if (this.scene) {
        this.scene.update(dt);
        this.scene.render(this.ctx);
      }
      if (this.running) {
        this.rafId = requestAnimationFrame(this.tick);
      }
    }
  };

  // src/client/engine/InputManager.ts
  var InputManager = class _InputManager {
    constructor(canvas2) {
      this.keys = /* @__PURE__ */ new Set();
      this.mouse = { x: 0, y: 0, down: false };
      this.canvas = canvas2;
      this.onKeyDown = (e) => {
        const key = e.key.toLowerCase();
        this.keys.add(key);
        if (_InputManager.SUPPRESSED_KEYS.has(key)) e.preventDefault();
      };
      this.onKeyUp = (e) => {
        this.keys.delete(e.key.toLowerCase());
      };
      this.onMouseMove = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = e.clientX - rect.left;
        this.mouse.y = e.clientY - rect.top;
      };
      this.onMouseDown = (e) => {
        if (e.button === 0) this.mouse.down = true;
      };
      this.onMouseUp = (e) => {
        if (e.button === 0) this.mouse.down = false;
      };
      this.onCtxMenu = (e) => e.preventDefault();
      window.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("keyup", this.onKeyUp);
      canvas2.addEventListener("mousemove", this.onMouseMove);
      canvas2.addEventListener("mousedown", this.onMouseDown);
      canvas2.addEventListener("mouseup", this.onMouseUp);
      canvas2.addEventListener("contextmenu", this.onCtxMenu);
    }
    static {
      /** Keys that should not trigger default browser behaviour (scrolling, etc.). */
      this.SUPPRESSED_KEYS = /* @__PURE__ */ new Set([
        "w",
        "a",
        "s",
        "d",
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
        " "
      ]);
    }
    isKeyDown(key) {
      return this.keys.has(key.toLowerCase());
    }
    /** Removes all listeners — call when tearing down the game. */
    dispose() {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      this.canvas.removeEventListener("mousemove", this.onMouseMove);
      this.canvas.removeEventListener("mousedown", this.onMouseDown);
      this.canvas.removeEventListener("mouseup", this.onMouseUp);
      this.canvas.removeEventListener("contextmenu", this.onCtxMenu);
    }
  };

  // src/shared/types.ts
  var NO_SLOT = 255;

  // src/shared/wire.ts
  var OP = {
    "player-id": 1,
    "joined-matched-lobby": 2,
    "player-joined": 3,
    "player-left": 4,
    "countdown": 5,
    "lobby-state": 6,
    "player-hit": 7,
    "player-eliminated": 8,
    "player-revived": 9,
    "game-over": 10,
    "lobby-reset": 11,
    "revive-available": 12,
    "join-lobby": 32,
    "join-spectate": 33,
    "request-start": 34,
    "request-restart": 35,
    "player-input": 38,
    "shoot": 39,
    "self-hit": 40,
    "bullet-inactive": 41,
    "request-revive": 42
  };
  var EVENT_BY_OP = Object.fromEntries(
    Object.entries(OP).map(([k, v]) => [v, k])
  );
  var STATUS_TO_U8 = {
    lobby: 0,
    countdown: 1,
    playing: 2,
    ended: 3
  };
  var U8_TO_STATUS = ["lobby", "countdown", "playing", "ended"];
  var POS_SCALE = 10;
  var TWO_PI = Math.PI * 2;
  var ROT_SCALE = 65535 / TWO_PI;
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var Writer = class {
    constructor(size) {
      this.pos = 0;
      this.buf = new Uint8Array(size);
      this.view = new DataView(this.buf.buffer);
    }
    u8(v) {
      this.buf[this.pos++] = v & 255;
    }
    u16(v) {
      this.view.setUint16(this.pos, v & 65535, true);
      this.pos += 2;
    }
    i16(v) {
      this.view.setInt16(this.pos, v, true);
      this.pos += 2;
    }
    pos16(v) {
      this.i16(Math.round(v * POS_SCALE));
    }
    rot16(v) {
      let r = v % TWO_PI;
      if (r < 0) r += TWO_PI;
      this.u16(Math.round(r * ROT_SCALE));
    }
    bool(v) {
      this.u8(v ? 1 : 0);
    }
    /** u8 slot with 0xFF as null sentinel. */
    slotOrNone(v) {
      this.u8(v === null ? NO_SLOT : v);
    }
    str(s) {
      const bytes = enc.encode(s);
      if (bytes.length > 255) {
        throw new Error(`wire: string too long (${bytes.length} > 255)`);
      }
      this.u8(bytes.length);
      this.buf.set(bytes, this.pos);
      this.pos += bytes.length;
    }
    view0() {
      return this.buf.subarray(0, this.pos);
    }
  };
  var Reader = class {
    constructor(input) {
      this.pos = 0;
      if (input instanceof Uint8Array) {
        this.buf = input;
        this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      } else {
        this.buf = new Uint8Array(input);
        this.view = new DataView(input);
      }
    }
    remaining() {
      return this.buf.length - this.pos;
    }
    u8() {
      return this.buf[this.pos++];
    }
    u16() {
      const v = this.view.getUint16(this.pos, true);
      this.pos += 2;
      return v;
    }
    i16() {
      const v = this.view.getInt16(this.pos, true);
      this.pos += 2;
      return v;
    }
    pos16() {
      return this.i16() / POS_SCALE;
    }
    rot16() {
      return this.u16() / ROT_SCALE;
    }
    bool() {
      return this.u8() !== 0;
    }
    /** u8 slot with 0xFF as null sentinel. */
    slotOrNone() {
      const v = this.u8();
      return v === NO_SLOT ? null : v;
    }
    str() {
      const len = this.u8();
      const bytes = this.buf.subarray(this.pos, this.pos + len);
      this.pos += len;
      return dec.decode(bytes);
    }
  };
  var strSize = (s) => 1 + enc.encode(s).length;
  var PLAYER_SIZE = 1 + 2 + 2 + 2 + 1 + 1 + 1;
  var BULLET_SIZE = 2 + 1 + 2 + 2 + 2 + 2 + 2 + 2 + 2;
  var sizes = {
    "player-id": () => 1,
    "joined-matched-lobby": (d) => strSize(d),
    "player-joined": (d) => 1 + 1 + strSize(d.lobbyId),
    "player-left": (d) => 1 + 1 + strSize(d.lobbyId),
    "countdown": (d) => 1 + strSize(d.lobbyId),
    "lobby-state": (d) => 1 + d.players.length * PLAYER_SIZE + 1 + d.bullets.length * BULLET_SIZE + 1 + 1 + strSize(d.lobbyId),
    "player-hit": (d) => 1 + 1 + strSize(d.lobbyId),
    "player-eliminated": (d) => 1 + 1 + strSize(d.lobbyId),
    "revive-available": (d) => 1 + 1 + strSize(d.lobbyId),
    "player-revived": (d) => 1 + 1 + strSize(d.lobbyId),
    "game-over": (d) => 1 + strSize(d.lobbyId),
    "lobby-reset": (d) => strSize(d.lobbyId),
    "join-lobby": () => 1,
    "join-spectate": (d) => strSize(d),
    "request-start": () => 0,
    "request-restart": () => 0,
    "player-input": () => 1 + 2,
    "shoot": () => 2,
    "self-hit": () => 2 + 1 + 1,
    "bullet-inactive": () => 2,
    "request-revive": () => 0
  };
  var emitters = {
    "player-id": (w, d) => w.u8(d),
    "joined-matched-lobby": (w, d) => w.str(d),
    "player-joined": (w, d) => {
      w.u8(d.slot);
      w.u8(d.playerCount);
      w.str(d.lobbyId);
    },
    "player-left": (w, d) => {
      w.u8(d.slot);
      w.u8(d.playerCount);
      w.str(d.lobbyId);
    },
    "countdown": (w, d) => {
      w.u8(d.time);
      w.str(d.lobbyId);
    },
    "lobby-state": (w, d) => {
      w.u8(d.players.length);
      for (const p of d.players) {
        w.u8(p.slot);
        w.pos16(p.x);
        w.pos16(p.y);
        w.rot16(p.rotation);
        w.u8(p.health);
        w.u8(p.maxHealth);
        w.bool(p.isEliminated);
      }
      w.u8(d.bullets.length);
      for (const b of d.bullets) {
        w.u16(b.id);
        w.u8(b.ownerSlot);
        w.pos16(b.prevX);
        w.pos16(b.prevY);
        w.pos16(b.x);
        w.pos16(b.y);
        w.pos16(b.startX);
        w.pos16(b.startY);
        w.rot16(b.rotation);
      }
      w.u8(STATUS_TO_U8[d.status]);
      w.slotOrNone(d.winnerSlot);
      w.str(d.lobbyId);
    },
    "player-hit": (w, d) => {
      w.u8(d.targetSlot);
      w.u8(d.health);
      w.str(d.lobbyId);
    },
    "player-eliminated": (w, d) => {
      w.u8(d.targetSlot);
      w.u8(d.killerSlot);
      w.str(d.lobbyId);
    },
    "revive-available": (w, d) => {
      w.u8(d.slot);
      w.u8(d.killerSlot);
      w.str(d.lobbyId);
    },
    "player-revived": (w, d) => {
      w.u8(d.slot);
      w.u8(d.killerSlot);
      w.str(d.lobbyId);
    },
    "game-over": (w, d) => {
      w.slotOrNone(d.winnerSlot);
      w.str(d.lobbyId);
    },
    "lobby-reset": (w, d) => {
      w.str(d.lobbyId);
    },
    "join-lobby": (w, d) => w.u8(d),
    "join-spectate": (w, d) => w.str(d),
    "request-start": () => {
    },
    "request-restart": () => {
    },
    "player-input": (w, d) => {
      w.u8(d.keys & 15);
      w.rot16(d.rotation);
    },
    "shoot": (w, d) => {
      w.rot16(d.rotation);
    },
    "self-hit": (w, d) => {
      w.u16(d.bulletId);
      w.u8(d.health);
      w.bool(d.isEliminated);
    },
    "bullet-inactive": (w, d) => {
      w.u16(d.bulletId);
    },
    "request-revive": () => {
    }
  };
  function encode(event, data) {
    const op = OP[event];
    if (op === void 0) throw new Error(`wire.encode: unknown event "${event}"`);
    const payloadSize = sizes[event](data);
    const w = new Writer(1 + payloadSize);
    w.u8(op);
    emitters[event](w, data);
    return w.view0();
  }
  var decoders = {
    "player-id": (r) => r.u8(),
    "joined-matched-lobby": (r) => r.str(),
    "player-joined": (r) => ({ slot: r.u8(), playerCount: r.u8(), lobbyId: r.str() }),
    "player-left": (r) => ({ slot: r.u8(), playerCount: r.u8(), lobbyId: r.str() }),
    "countdown": (r) => ({ time: r.u8(), lobbyId: r.str() }),
    "lobby-state": (r) => {
      const playerCount = r.u8();
      const players = [];
      for (let i = 0; i < playerCount; i++) {
        players.push({
          slot: r.u8(),
          x: r.pos16(),
          y: r.pos16(),
          rotation: r.rot16(),
          health: r.u8(),
          maxHealth: r.u8(),
          isEliminated: r.bool()
        });
      }
      const bulletCount = r.u8();
      const bullets = [];
      for (let i = 0; i < bulletCount; i++) {
        bullets.push({
          id: r.u16(),
          ownerSlot: r.u8(),
          prevX: r.pos16(),
          prevY: r.pos16(),
          x: r.pos16(),
          y: r.pos16(),
          startX: r.pos16(),
          startY: r.pos16(),
          rotation: r.rot16()
        });
      }
      const status = U8_TO_STATUS[r.u8()];
      const winnerSlot = r.slotOrNone();
      const lobbyId = r.str();
      return { players, bullets, status, winnerSlot, lobbyId };
    },
    "player-hit": (r) => ({ targetSlot: r.u8(), health: r.u8(), lobbyId: r.str() }),
    "player-eliminated": (r) => ({ targetSlot: r.u8(), killerSlot: r.u8(), lobbyId: r.str() }),
    "revive-available": (r) => ({ slot: r.u8(), killerSlot: r.u8(), lobbyId: r.str() }),
    "player-revived": (r) => ({ slot: r.u8(), killerSlot: r.u8(), lobbyId: r.str() }),
    "game-over": (r) => ({ winnerSlot: r.slotOrNone(), lobbyId: r.str() }),
    "lobby-reset": (r) => ({ lobbyId: r.str() }),
    "join-lobby": (r) => r.u8(),
    "join-spectate": (r) => r.str(),
    "request-start": () => void 0,
    "request-restart": () => void 0,
    "player-input": (r) => ({ keys: r.u8() & 15, rotation: r.rot16() }),
    "shoot": (r) => ({ rotation: r.rot16() }),
    "self-hit": (r) => ({ bulletId: r.u16(), health: r.u8(), isEliminated: r.bool() }),
    "bullet-inactive": (r) => ({ bulletId: r.u16() }),
    "request-revive": () => void 0
  };
  function decode(input) {
    if ((input instanceof Uint8Array ? input.length : input.byteLength) === 0) return null;
    const r = new Reader(input);
    const op = r.u8();
    const event = EVENT_BY_OP[op];
    if (!event) return null;
    try {
      const data = decoders[event](r);
      return { event, data };
    } catch {
      return null;
    }
  }

  // src/client/network/NetworkClient.ts
  var NetworkClient = class {
    constructor() {
      this.listeners = /* @__PURE__ */ new Map();
      this.outbox = [];
      this.open = false;
      /** Populated once the server assigns our lobby slot (u8, 0..6). -1 = unknown. */
      this.localSlot = -1;
      /** The lobby room we've been assigned to. */
      this.lobbyId = "";
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${proto}//${location.host}/`);
      this.ws.binaryType = "arraybuffer";
      this.ws.addEventListener("open", () => {
        this.open = true;
        for (const msg of this.outbox) this.ws.send(msg.buffer);
        this.outbox.length = 0;
      });
      this.ws.addEventListener("message", (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const msg = decode(new Uint8Array(ev.data));
        if (!msg) return;
        const arr = this.listeners.get(msg.event);
        if (!arr) return;
        for (const h of arr) h(msg.data);
      });
    }
    //  Outbound 
    joinLobby(size) {
      this.send("join-lobby", size);
    }
    joinSpectate(lobbyId) {
      this.send("join-spectate", lobbyId);
    }
    requestStart() {
      this.send("request-start", void 0);
    }
    requestRestart() {
      this.send("request-restart", void 0);
    }
    sendInput(keys, rotation) {
      this.send("player-input", { keys, rotation });
    }
    sendShoot(rotation) {
      this.send("shoot", { rotation });
    }
    sendSelfHit(bulletId, health, isEliminated) {
      this.send("self-hit", { bulletId, health, isEliminated });
    }
    sendBulletInactive(bulletId) {
      this.send("bullet-inactive", { bulletId });
    }
    requestRevive() {
      this.send("request-revive", void 0);
    }
    //  Inbound 
    on(event, handler) {
      let arr = this.listeners.get(event);
      if (!arr) {
        arr = [];
        this.listeners.set(event, arr);
      }
      arr.push(handler);
    }
    disconnect() {
      try {
        this.ws.close();
      } catch {
      }
    }
    //  Internals 
    send(event, data) {
      const payload = encode(event, data);
      if (this.open) {
        this.ws.send(payload.buffer);
      } else {
        this.outbox.push(payload);
      }
    }
  };

  // src/client/game/components/PlayerComponent.ts
  var PlayerComponent = class {
    constructor(dto) {
      this.slot = dto.slot;
      this.x = dto.x;
      this.y = dto.y;
      this.rotation = dto.rotation;
      this.health = dto.health;
      this.maxHealth = dto.maxHealth;
      this.isEliminated = dto.isEliminated;
    }
    get isAlive() {
      return this.health > 0 && !this.isEliminated;
    }
    /** Merge an incoming DTO into this component (avoids re-allocation). */
    applyDTO(dto) {
      this.x = dto.x;
      this.y = dto.y;
      this.rotation = dto.rotation;
      this.health = dto.health;
      this.maxHealth = dto.maxHealth;
      this.isEliminated = dto.isEliminated;
    }
  };

  // src/client/game/components/BulletComponent.ts
  var BulletComponent = class {
    constructor(dto) {
      this.id = dto.id;
      this.ownerSlot = dto.ownerSlot;
      this.x = dto.x;
      this.y = dto.y;
      this.prevX = dto.prevX;
      this.prevY = dto.prevY;
      this.rotation = dto.rotation;
      this.startX = dto.startX;
      this.startY = dto.startY;
    }
    applyDTO(dto) {
      this.prevX = dto.prevX;
      this.prevY = dto.prevY;
      this.x = dto.x;
      this.y = dto.y;
      this.startX = dto.startX;
      this.startY = dto.startY;
      this.rotation = dto.rotation;
    }
  };

  // src/shared/constants.ts
  var CANVAS_WIDTH = 900;
  var CANVAS_HEIGHT = 630;
  var PLAYER_BASE = 18;
  var PLAYER_SIDE = 27;
  var PLAYER_STROKE_WIDTH = 2;
  var BULLET_RADIUS = 4;
  var BULLET_MAX_DISTANCE = 1500;
  var RELOAD_TIME = 1500;
  var LOBBY_SIZES = [3, 5, 7];
  var COLORS = {
    BACKGROUND: "#1a1a2e",
    GRID: "#333333",
    SELF: "#00ff00",
    OPPONENT: "#ff4444",
    BULLET: "#ffff00",
    HEALTH_OK: "#00ff00",
    HEALTH_LOW: "#ff9900",
    WHITE: "#ffffff"
  };

  // src/client/game/systems/RenderSystem.ts
  var GRID_SIZE = 50;
  function drawBackground(ctx) {
    ctx.fillStyle = COLORS.BACKGROUND;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.strokeStyle = COLORS.GRID;
    ctx.lineWidth = 1;
    for (let x = 0; x <= CANVAS_WIDTH; x += GRID_SIZE) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_HEIGHT; y += GRID_SIZE) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_WIDTH, y);
      ctx.stroke();
    }
  }
  function drawPlayer(ctx, player, isLocal, mouse) {
    const color = isLocal ? COLORS.SELF : COLORS.OPPONENT;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.rotation);
    ctx.fillStyle = player.health < player.maxHealth ? COLORS.HEALTH_LOW : color;
    ctx.strokeStyle = COLORS.WHITE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PLAYER_SIDE, 0);
    ctx.lineTo(-PLAYER_BASE / 2, -PLAYER_BASE / 2);
    ctx.lineTo(-PLAYER_BASE / 2, PLAYER_BASE / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (isLocal) {
      ctx.fillStyle = COLORS.WHITE;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, BULLET_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    const barW = 30;
    const barH = 4;
    ctx.fillStyle = "#333";
    ctx.fillRect(player.x - barW / 2, player.y - 35, barW, barH);
    const pct = player.health / player.maxHealth;
    ctx.fillStyle = player.health >= player.maxHealth ? COLORS.HEALTH_OK : COLORS.HEALTH_LOW;
    ctx.fillRect(player.x - barW / 2, player.y - 35, barW * pct, barH);
  }
  function drawBullet(ctx, bullet) {
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.rotate(bullet.rotation);
    ctx.fillStyle = COLORS.BULLET;
    ctx.strokeStyle = COLORS.WHITE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, BULLET_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  function drawCountdown(ctx, seconds) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.fillStyle = COLORS.WHITE;
    ctx.font = "bold 120px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(seconds.toString(), CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
  }
  function drawMenu(ctx, selectedSize) {
    const BTN_W = 200;
    const BTN_H = 50;
    const BTN_Y = 320;
    ctx.fillStyle = COLORS.WHITE;
    ctx.font = "bold 48px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Triangle Shooter", CANVAS_WIDTH / 2, 150);
    ctx.font = "24px Arial";
    ctx.fillText("Multiplayer Battle Royale", CANVAS_WIDTH / 2, 200);
    const sizeButtons = [];
    LOBBY_SIZES.forEach((size, i) => {
      const x = CANVAS_WIDTH / 2 - 350 + i * 250;
      const isSelected = selectedSize === size;
      ctx.fillStyle = isSelected ? "#4CAF50" : "#555";
      ctx.fillRect(x, BTN_Y, BTN_W, BTN_H);
      ctx.strokeStyle = COLORS.WHITE;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, BTN_Y, BTN_W, BTN_H);
      ctx.fillStyle = COLORS.WHITE;
      ctx.font = "20px Arial";
      ctx.fillText(`${size} Players`, x + BTN_W / 2, BTN_Y + BTN_H / 2 + 7);
      sizeButtons.push({ x, y: BTN_Y, w: BTN_W, h: BTN_H, size });
    });
    const startX = CANVAS_WIDTH / 2 - 100;
    ctx.fillStyle = "#2196F3";
    ctx.fillRect(startX, 420, 200, 60);
    ctx.strokeStyle = COLORS.WHITE;
    ctx.strokeRect(startX, 420, 200, 60);
    ctx.fillStyle = COLORS.WHITE;
    ctx.font = "bold 24px Arial";
    ctx.fillText("START", CANVAS_WIDTH / 2, 458);
    ctx.fillStyle = "#aaa";
    ctx.font = "16px Arial";
    ctx.fillText("WASD/Arrows to move | Mouse to aim | Click to shoot", CANVAS_WIDTH / 2, 550);
    return {
      sizeButtons,
      startButton: { x: startX, y: 420, w: 200, h: 60 }
    };
  }
  function drawLobby(ctx, maxPlayers, currentCount, lobbyId) {
    ctx.fillStyle = COLORS.WHITE;
    ctx.font = "bold 36px Arial";
    ctx.textAlign = "center";
    ctx.fillText(`Lobby (${maxPlayers} Players)`, CANVAS_WIDTH / 2, 100);
    ctx.font = "20px Arial";
    ctx.fillText(`Waiting for players... (${currentCount}/${maxPlayers})`, CANVAS_WIDTH / 2, 150);
    if (lobbyId) {
      ctx.fillStyle = "#aaa";
      ctx.font = "14px Arial";
      ctx.fillText(`Lobby ID: ${lobbyId}`, CANVAS_WIDTH / 2, 175);
      ctx.fillStyle = "#888";
      ctx.fillText(`SDK: ws://localhost:3000  Lobby: ${lobbyId}`, CANVAS_WIDTH / 2, 195);
    }
    const startX = CANVAS_WIDTH / 2 - 75;
    const canStart = currentCount >= maxPlayers;
    ctx.fillStyle = canStart ? "#4CAF50" : "#555";
    ctx.fillRect(startX, 200, 150, 50);
    ctx.strokeStyle = COLORS.WHITE;
    ctx.lineWidth = 2;
    ctx.strokeRect(startX, 200, 150, 50);
    ctx.fillStyle = COLORS.WHITE;
    ctx.font = "20px Arial";
    ctx.fillText(
      canStart ? "Start Game" : `Need ${maxPlayers - currentCount} more`,
      CANVAS_WIDTH / 2,
      235
    );
    return { startButton: { x: startX, y: 200, w: 150, h: 50 } };
  }

  // src/client/game/systems/HUDSystem.ts
  var HUDSystem = class {
    constructor() {
      this.healthFill = document.getElementById("healthFill");
      this.healthText = document.getElementById("healthText");
      this.reloadFill = document.getElementById("reloadFill");
      this.messageEl = document.getElementById("message");
      this.playerCountEl = document.getElementById("playerCount");
    }
    //  Health 
    updateHealth(current, max) {
      if (!this.healthFill) return;
      const pct = current / max * 100;
      this.healthFill.style.width = `${pct}%`;
      this.healthFill.style.background = current <= 1 ? "linear-gradient(90deg, #ff9900, #ff6600)" : "linear-gradient(90deg, #00ff00, #00cc00)";
      if (this.healthText) {
        this.healthText.textContent = current.toString();
      }
    }
    //  Reload 
    setReloadProgress(progress) {
      if (this.reloadFill) {
        this.reloadFill.style.width = `${Math.min(progress, 1) * 100}%`;
      }
    }
    //  Center message 
    showMessage(html) {
      if (this.messageEl) {
        this.messageEl.innerHTML = html;
        this.messageEl.style.display = "block";
      }
    }
    hideMessage() {
      if (this.messageEl) {
        this.messageEl.style.display = "none";
      }
    }
    //  Player count 
    updatePlayerCount(alive, max) {
      if (this.playerCountEl) {
        this.playerCountEl.textContent = `Players: ${alive}/${max}`;
      }
    }
  };

  // src/shared/collision.ts
  function getPlayerTriangle(px, py, rotation) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const halfBase = PLAYER_BASE / 2;
    return [
      { x: px + PLAYER_SIDE * cos, y: py + PLAYER_SIDE * sin },
      { x: px - halfBase * cos + halfBase * sin, y: py - halfBase * sin - halfBase * cos },
      { x: px - halfBase * cos - halfBase * sin, y: py - halfBase * sin + halfBase * cos }
    ];
  }
  function getPlayerHitTriangle(px, py, rotation) {
    const verts = getPlayerTriangle(px, py, rotation);
    const cx = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const cy = (verts[0].y + verts[1].y + verts[2].y) / 3;
    const pad = PLAYER_STROKE_WIDTH / 2;
    return verts.map((v) => {
      const dx = v.x - cx;
      const dy = v.y - cy;
      const len = Math.hypot(dx, dy);
      return {
        x: v.x + dx / len * pad,
        y: v.y + dy / len * pad
      };
    });
  }
  function circleTouchesTriangle(cx, cy, r, a, b, c) {
    const p = { x: cx, y: cy };
    if (pointInTriangle(p, a, b, c)) return true;
    if (distToSegment(p, a, b) < r) return true;
    if (distToSegment(p, b, c) < r) return true;
    if (distToSegment(p, c, a) < r) return true;
    return false;
  }
  function pointInTriangle(p, a, b, c) {
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }
  function sign(p1, p2, p3) {
    return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  }
  function distToSegment(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const lenSq = abx * abx + aby * aby;
    if (lenSq === 0) return Math.hypot(apx, apy);
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq));
    return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
  }

  // src/client/game/scenes/GameScene.ts
  var GameScene = class {
    constructor(canvas2) {
      // ── Entity stores ───────────────────────────────────────────────────────
      this.players = /* @__PURE__ */ new Map();
      this.bullets = /* @__PURE__ */ new Map();
      this.inactiveBulletIds = /* @__PURE__ */ new Set();
      this.clientPlayerStates = /* @__PURE__ */ new Map();
      // ── State ───────────────────────────────────────────────────────────────
      this.status = "menu";
      this.maxPlayers = 3;
      this.countdownTime = 10;
      this.isSpectator = false;
      this.reviveRequested = false;
      // Weapon
      this.canShoot = true;
      this.reloadStartMs = 0;
      // Click hit-testing areas cached from last render
      this.menuHitAreas = null;
      this.lobbyHitAreas = null;
      this.canvas = canvas2;
      this.input = new InputManager(canvas2);
      this.net = new NetworkClient();
      this.hud = new HUDSystem();
      this.bindNetworkEvents();
      this.bindCanvasClick();
      this.bindBackToMenu();
      this.checkSpectateMode();
    }
    checkSpectateMode() {
      const params = new URLSearchParams(window.location.search);
      const spectateLobby = params.get("spectate");
      if (spectateLobby) {
        this.isSpectator = true;
        this.status = "lobby";
        this.net.joinSpectate(spectateLobby);
      }
    }
    // ── Network wiring ────────────────────────────────────────────────────
    bindNetworkEvents() {
      this.net.on("player-id", (slot) => {
        this.net.localSlot = slot;
      });
      this.net.on("joined-matched-lobby", (lobbyId) => {
        this.net.lobbyId = lobbyId;
      });
      this.net.on("player-joined", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.refreshPlayerCount();
      });
      this.net.on("player-left", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.clientPlayerStates.delete(data.slot);
        this.refreshPlayerCount();
      });
      this.net.on("countdown", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.status = "countdown";
        this.countdownTime = data.time;
        this.hud.showMessage(`Game starting in ${data.time}...`);
      });
      this.net.on("lobby-state", (state) => {
        if (state.lobbyId !== this.net.lobbyId) return;
        this.applyLobbyState(state);
      });
      this.net.on("player-hit", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.setClientPlayerState(data.targetSlot, data.health, data.health <= 0);
        this.refreshHUD();
        this.refreshPlayerCount();
      });
      this.net.on("player-eliminated", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.setClientPlayerState(data.targetSlot, 0, true);
        this.refreshHUD();
        this.refreshPlayerCount();
      });
      this.net.on("revive-available", (data) => {
        if (data.lobbyId !== this.net.lobbyId || data.slot !== this.net.localSlot) return;
        if (!this.isSpectator && !this.reviveRequested) {
          this.reviveRequested = true;
          this.net.requestRevive();
        }
      });
      this.net.on("player-revived", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.setClientPlayerState(data.slot, 1, false);
        if (data.slot === this.net.localSlot) {
          this.reviveRequested = false;
        }
        this.refreshHUD();
        this.refreshPlayerCount();
      });
      this.net.on("game-over", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.status = "ended";
        this.showEndScreen(data.winnerSlot !== null && data.winnerSlot === this.net.localSlot);
      });
      this.net.on("lobby-reset", (data) => {
        if (data.lobbyId !== this.net.lobbyId) return;
        this.status = "lobby";
        this.resetClientAuthorityState();
        this.hud.hideMessage();
      });
    }
    // ── State application ─────────────────────────────────────────────────
    applyLobbyState(state) {
      this.status = state.status;
      if (state.status !== "playing") {
        this.resetClientAuthorityState();
      }
      const serverBulletIds = new Set(state.bullets.map((b) => b.id));
      for (const id of this.inactiveBulletIds) {
        if (!serverBulletIds.has(id)) this.inactiveBulletIds.delete(id);
      }
      this.players.clear();
      const playerSlots = /* @__PURE__ */ new Set();
      for (const dto of state.players) {
        const player = new PlayerComponent(dto);
        playerSlots.add(dto.slot);
        const clientState = this.clientPlayerStates.get(dto.slot);
        if (state.status === "playing" && clientState) {
          player.health = clientState.health;
          player.isEliminated = clientState.isEliminated;
        }
        this.players.set(dto.slot, player);
      }
      for (const slot of this.clientPlayerStates.keys()) {
        if (!playerSlots.has(slot)) this.clientPlayerStates.delete(slot);
      }
      const nextBullets = /* @__PURE__ */ new Map();
      for (const dto of state.bullets) {
        if (this.inactiveBulletIds.has(dto.id)) continue;
        const existing = this.bullets.get(dto.id);
        if (existing) {
          existing.applyDTO(dto);
          nextBullets.set(dto.id, existing);
        } else {
          nextBullets.set(dto.id, new BulletComponent(dto));
        }
      }
      this.bullets = nextBullets;
      if (state.status === "playing") {
        this.applyClientBulletAuthority();
      }
      if (state.status === "ended" && state.winnerSlot !== null) {
        this.showEndScreen(state.winnerSlot === this.net.localSlot);
      } else if (state.status === "playing") {
        this.hud.hideMessage();
      }
      this.refreshPlayerCount();
      this.refreshHUD();
    }
    // ── Scene interface ───────────────────────────────────────────────────
    update(_dt) {
      if (this.status !== "playing") return;
      this.applyClientBulletAuthority();
      const local = this.players.get(this.net.localSlot);
      if (!local || !local.isAlive || this.isSpectator) return;
      let keys = 0;
      if (this.input.isKeyDown("w") || this.input.isKeyDown("arrowup")) keys |= 1;
      if (this.input.isKeyDown("s") || this.input.isKeyDown("arrowdown")) keys |= 2;
      if (this.input.isKeyDown("a") || this.input.isKeyDown("arrowleft")) keys |= 4;
      if (this.input.isKeyDown("d") || this.input.isKeyDown("arrowright")) keys |= 8;
      const rotation = Math.atan2(
        this.input.mouse.y - local.y,
        this.input.mouse.x - local.x
      );
      this.net.sendInput(keys, rotation);
      if (!this.canShoot) {
        const elapsed = Date.now() - this.reloadStartMs;
        const progress = Math.min(elapsed / RELOAD_TIME, 1);
        this.hud.setReloadProgress(progress);
        if (progress >= 1) this.canShoot = true;
      }
      if (this.input.mouse.down && this.canShoot) {
        this.shoot(rotation);
      }
    }
    render(ctx) {
      drawBackground(ctx);
      if (this.status === "menu") {
        this.menuHitAreas = drawMenu(ctx, this.maxPlayers);
        return;
      }
      if (this.status === "lobby") {
        this.lobbyHitAreas = drawLobby(ctx, this.maxPlayers, this.players.size, this.net.lobbyId);
      }
      this.players.forEach((p) => {
        if (p.isAlive) drawPlayer(ctx, p, p.slot === this.net.localSlot, this.input.mouse);
      });
      this.bullets.forEach((b) => drawBullet(ctx, b));
      if (this.status === "countdown") {
        drawCountdown(ctx, this.countdownTime);
      }
    }
    // ── Shooting ──────────────────────────────────────────────────────────
    shoot(rotation) {
      this.net.sendShoot(rotation);
      this.canShoot = false;
      this.reloadStartMs = Date.now();
      this.hud.setReloadProgress(0);
    }
    // ── Client-owned combat outcomes ─────────────────────────────────────
    applyClientBulletAuthority() {
      for (const bullet of [...this.bullets.values()]) {
        if (this.isBulletOutOfBounds(bullet)) {
          this.markBulletInactive(bullet.id, !this.isSpectator && bullet.ownerSlot === this.net.localSlot);
          continue;
        }
        const hitPlayer = this.findBulletHitPlayer(bullet);
        if (hitPlayer) {
          this.applyPredictedHit(bullet, hitPlayer);
        }
      }
    }
    isBulletOutOfBounds(bullet) {
      const dx = bullet.x - bullet.startX;
      const dy = bullet.y - bullet.startY;
      return bullet.x < -BULLET_RADIUS || bullet.x > CANVAS_WIDTH + BULLET_RADIUS || bullet.y < -BULLET_RADIUS || bullet.y > CANVAS_HEIGHT + BULLET_RADIUS || Math.hypot(dx, dy) > BULLET_MAX_DISTANCE;
    }
    bulletHitsPlayer(bullet, player) {
      const [v0, v1, v2] = getPlayerHitTriangle(player.x, player.y, player.rotation);
      const dx = bullet.x - bullet.prevX;
      const dy = bullet.y - bullet.prevY;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / BULLET_RADIUS));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = bullet.prevX + dx * t;
        const y = bullet.prevY + dy * t;
        if (circleTouchesTriangle(x, y, BULLET_RADIUS, v0, v1, v2)) return true;
      }
      return false;
    }
    findBulletHitPlayer(bullet) {
      for (const player of this.players.values()) {
        if (!player.isAlive || player.slot === bullet.ownerSlot) continue;
        if (this.bulletHitsPlayer(bullet, player)) return player;
      }
      return null;
    }
    applyPredictedHit(bullet, target) {
      const nextHealth = Math.max(0, target.health - 1);
      const isEliminated = nextHealth <= 0;
      this.markBulletInactive(bullet.id, false);
      this.setClientPlayerState(target.slot, nextHealth, isEliminated);
      if (!this.isSpectator && target.slot === this.net.localSlot) {
        this.net.sendSelfHit(bullet.id, nextHealth, isEliminated);
      }
      this.refreshHUD();
      this.refreshPlayerCount();
    }
    markBulletInactive(bulletId, notifyServer) {
      if (this.inactiveBulletIds.has(bulletId)) return;
      this.inactiveBulletIds.add(bulletId);
      this.bullets.delete(bulletId);
      if (notifyServer) {
        this.net.sendBulletInactive(bulletId);
      }
    }
    // ── Click handling (canvas-based menus) ───────────────────────────────
    bindCanvasClick() {
      this.canvas.addEventListener("click", (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (this.status === "menu" && this.menuHitAreas) {
          this.handleMenuClick(x, y);
        } else if (this.status === "lobby" && this.lobbyHitAreas) {
          this.handleLobbyClick(x, y);
        }
      });
    }
    handleMenuClick(x, y) {
      const areas = this.menuHitAreas;
      for (const btn of areas.sizeButtons) {
        if (x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
          this.maxPlayers = btn.size;
          return;
        }
      }
      const s = areas.startButton;
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        this.status = "lobby";
        this.refreshPlayerCount();
        this.net.joinLobby(this.maxPlayers);
      }
    }
    handleLobbyClick(x, y) {
      const s = this.lobbyHitAreas.startButton;
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        if (this.players.size >= this.maxPlayers) {
          this.net.requestStart();
        }
      }
    }
    /** "Back to Home" button injected into the DOM message overlay. */
    bindBackToMenu() {
      document.addEventListener("click", (e) => {
        if (e.target.id === "backToMenuBtn") {
          location.reload();
        }
      });
    }
    // ── HUD helpers ───────────────────────────────────────────────────────
    refreshPlayerCount() {
      const alive = [...this.players.values()].filter((p) => p.isAlive).length;
      this.hud.updatePlayerCount(alive, this.maxPlayers);
    }
    refreshHUD() {
      const local = this.players.get(this.net.localSlot);
      if (local) this.hud.updateHealth(local.health, local.maxHealth);
    }
    setClientPlayerState(slot, health, isEliminated) {
      this.clientPlayerStates.set(slot, { health, isEliminated });
      const player = this.players.get(slot);
      if (player) {
        player.health = health;
        player.isEliminated = isEliminated;
      }
    }
    resetClientAuthorityState() {
      this.reviveRequested = false;
      this.inactiveBulletIds.clear();
      this.clientPlayerStates.clear();
    }
    showEndScreen(isWinner) {
      const label = isWinner ? "\u{1F389} You Win!" : "\u{1F480} Game Over";
      this.hud.showMessage(
        `${label}<br><button id="backToMenuBtn" class="game-over-btn">Back to Home</button>`
      );
    }
  };

  // src/client/wallet/cip30.ts
  function getInstalledWallets() {
    const cardano = window.cardano;
    if (!cardano) return [];
    return Object.keys(cardano).filter((id) => cardano[id]?.apiVersion && cardano[id]?.enable).map((id) => ({ id, info: cardano[id] }));
  }
  function hexEncode(s) {
    return Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // src/client/wallet/walletAuth.ts
  async function authenticateWithWallet(walletMeta) {
    const api = await walletMeta.enable();
    const addressHex = await api.getChangeAddress();
    const nonceRes = await fetch(
      `/api/auth/nonce?address=${encodeURIComponent(addressHex)}`
    );
    if (!nonceRes.ok) throw new Error("Server refused nonce request");
    const { nonce } = await nonceRes.json();
    const signature = await api.signData(addressHex, hexEncode(nonce));
    const verifyRes = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: addressHex, signature })
    });
    if (!verifyRes.ok) throw new Error("Signature verification failed");
    const { token } = await verifyRes.json();
    sessionStorage.setItem("authToken", token);
    sessionStorage.setItem("walletAddress", addressHex);
    return { api, addressHex, token };
  }

  // src/client/wallet/walletUI.ts
  function initWalletUI(els, onConnected) {
    let connected = false;
    els.connectBtn.addEventListener("click", () => {
      if (connected) return;
      const installed = getInstalledWallets();
      if (installed.length === 0) {
        els.walletList.style.display = "block";
        els.walletList.innerHTML = `<div style="color:#fff;font-size:12px;">No CIP-30 wallets found. Please install Eternl, Nami, or Lace.</div>`;
        return;
      }
      els.walletList.style.display = "block";
      els.walletList.innerHTML = "";
      installed.forEach(({ id, info }) => {
        const btn = document.createElement("button");
        btn.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;padding:6px;margin:2px 0;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;";
        btn.innerHTML = `<img src="${info.icon}" width="20" height="20"/> ${info.name}`;
        btn.onclick = () => attemptConnect(id, info);
        els.walletList.appendChild(btn);
      });
    });
    async function attemptConnect(_id, info) {
      els.walletList.style.display = "none";
      try {
        const result = await authenticateWithWallet(info);
        connected = true;
        els.connectBtn.textContent = "Connected";
        els.connectBtn.disabled = true;
        els.walletInfo.style.display = "block";
        els.walletInfo.innerHTML = `<div style="color:#fff;font-size:11px;">${result.addressHex.slice(0, 16)}...${result.addressHex.slice(-8)}</div>`;
        onConnected(result);
      } catch (err) {
        console.error("Wallet connect failed:", err);
        const msg = err instanceof Error ? err.message : String(err);
        els.walletInfo.style.display = "block";
        els.walletInfo.innerHTML = `<div style="color:#ff6666;">${msg.toLowerCase().includes("reject") ? "Connection declined" : "Authentication failed"}</div>`;
      }
    }
  }

  // src/client/main.ts
  var canvas = document.getElementById("game");
  canvas.style.filter = "blur(8px) brightness(0.4)";
  canvas.style.pointerEvents = "none";
  initWalletUI(
    {
      connectBtn: document.getElementById("connectBtn"),
      walletList: document.getElementById("walletList"),
      walletInfo: document.getElementById("walletInfo")
    },
    () => {
      canvas.style.filter = "";
      canvas.style.pointerEvents = "";
      const loop = new GameLoop(canvas);
      const scene = new GameScene(canvas);
      loop.setScene(scene);
      loop.start();
    }
  );
})();
