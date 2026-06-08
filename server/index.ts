import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

type Side = "A" | "B";

type RoomPhase = "waiting" | "select" | "bottle" | "battle" | "result";

type RoomPlayer = {
  socketId: string;
  side: Side;
  ready: boolean;
  characters: string[];
};

type RoomState = {
  roomCode: string;
  phase: RoomPhase;
  players: RoomPlayer[];
  firstSide: Side | null;
  turnIndex: number;
  currentTurnSide: Side | null;
  scores: {
    A: number;
    B: number;
  };
  startedAt: number | null;
};

const PORT = Number(process.env.PORT || 3001);

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"]
  })
);

app.get("/", (_req, res) => {
  res.send("Beat Rise Socket.IO server is running.");
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const rooms = new Map<string, RoomState>();

function normalizeRoomCode(roomCode: string) {
  return (roomCode || "BEAT").trim().toUpperCase().slice(0, 8);
}

function otherSide(side: Side): Side {
  return side === "A" ? "B" : "A";
}

function getTurnOrder(firstSide: Side): Side[] {
  return [firstSide, otherSide(firstSide), firstSide, otherSide(firstSide)];
}

function createRoom(roomCode: string): RoomState {
  return {
    roomCode,
    phase: "waiting",
    players: [],
    firstSide: null,
    turnIndex: 0,
    currentTurnSide: null,
    scores: {
      A: 0,
      B: 0
    },
    startedAt: null
  };
}

function getPublicRoomState(room: RoomState): RoomState {
  return {
    roomCode: room.roomCode,
    phase: room.phase,
    players: room.players,
    firstSide: room.firstSide,
    turnIndex: room.turnIndex,
    currentTurnSide: room.currentTurnSide,
    scores: room.scores,
    startedAt: room.startedAt
  };
}

function emitRoomState(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;

  io.to(roomCode).emit("roomState", getPublicRoomState(room));
}

function findPlayerRoom(socketId: string) {
  for (const room of rooms.values()) {
    const player = room.players.find((item) => item.socketId === socketId);

    if (player) {
      return {
        room,
        player
      };
    }
  }

  return null;
}

function removePlayer(socketId: string) {
  for (const [roomCode, room] of rooms.entries()) {
    const before = room.players.length;
    room.players = room.players.filter((player) => player.socketId !== socketId);

    if (room.players.length !== before) {
      if (room.players.length === 0) {
        rooms.delete(roomCode);
      } else {
        room.phase = "waiting";
        room.players = room.players.map((player, index) => ({
          ...player,
          side: index === 0 ? "A" : "B",
          ready: false
        }));
        room.firstSide = null;
        room.turnIndex = 0;
        room.currentTurnSide = null;
        room.startedAt = null;
        room.scores = {
          A: 0,
          B: 0
        };

        emitRoomState(roomCode);
      }

      break;
    }
  }
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("createOrJoinRoom", (payload: { roomCode: string }) => {
    const roomCode = normalizeRoomCode(payload.roomCode);

    let room = rooms.get(roomCode);

    if (!room) {
      room = createRoom(roomCode);
      rooms.set(roomCode, room);
    }

    const alreadyInRoom = room.players.find(
      (player) => player.socketId === socket.id
    );

    if (alreadyInRoom) {
      socket.join(roomCode);

      socket.emit("joinedRoom", {
        roomCode,
        side: alreadyInRoom.side,
        state: getPublicRoomState(room)
      });

      emitRoomState(roomCode);
      return;
    }

    if (room.players.length >= 2) {
      socket.emit("roomFull", {
        roomCode
      });
      return;
    }

    const side: Side = room.players.length === 0 ? "A" : "B";

    const player: RoomPlayer = {
      socketId: socket.id,
      side,
      ready: false,
      characters: []
    };

    room.players.push(player);
    room.phase = "select";

    socket.join(roomCode);

    socket.emit("joinedRoom", {
      roomCode,
      side,
      state: getPublicRoomState(room)
    });

    emitRoomState(roomCode);
  });

  socket.on(
    "selectCharacters",
    (payload: { roomCode: string; characters: string[] }) => {
      const roomCode = normalizeRoomCode(payload.roomCode);
      const room = rooms.get(roomCode);
      if (!room) return;

      const player = room.players.find((item) => item.socketId === socket.id);
      if (!player) return;

      player.characters = Array.isArray(payload.characters)
        ? payload.characters.slice(0, 2)
        : [];

      emitRoomState(roomCode);
    }
  );

  socket.on("playerReady", (payload: { roomCode: string }) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find((item) => item.socketId === socket.id);
    if (!player) return;

    player.ready = true;

    emitRoomState(roomCode);
  });

  socket.on("spinBottle", (payload: { roomCode: string }) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    if (!room) return;

    const firstSide: Side = Math.random() >= 0.5 ? "A" : "B";

    const baseAngle = firstSide === "A" ? 180 : 0;
    const extraSpin = 360 * (5 + Math.floor(Math.random() * 3));
    const angle = extraSpin + baseAngle;

    room.firstSide = firstSide;
    room.phase = "bottle";
    room.turnIndex = 0;
    room.currentTurnSide = firstSide;
    room.startedAt = null;

    io.to(roomCode).emit("bottleResult", {
      firstSide,
      angle
    });

    emitRoomState(roomCode);
  });

  socket.on("startBattle", (payload: { roomCode: string }) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    if (!room) return;

    if (!room.firstSide) {
      room.firstSide = Math.random() >= 0.5 ? "A" : "B";
    }

    const startedAt = Date.now();

    room.phase = "battle";
    room.turnIndex = 0;
    room.currentTurnSide = room.firstSide;
    room.startedAt = startedAt;
    room.scores = {
      A: 0,
      B: 0
    };

    io.to(roomCode).emit("battleStarted", {
      firstSide: room.firstSide,
      turnIndex: room.turnIndex,
      currentTurnSide: room.currentTurnSide,
      startedAt,
      scores: room.scores
    });

    emitRoomState(roomCode);
  });

  socket.on("turnChanged", (payload: { roomCode: string; turnIndex: number }) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    if (!room) return;
    if (!room.firstSide) return;

    const nextTurnIndex = Math.max(0, Math.min(3, Number(payload.turnIndex)));
    const turnOrder = getTurnOrder(room.firstSide);
    const startedAt = Date.now();

    room.turnIndex = nextTurnIndex;
    room.currentTurnSide = turnOrder[nextTurnIndex];
    room.startedAt = startedAt;

    io.to(roomCode).emit("turnChanged", {
      turnIndex: room.turnIndex,
      currentTurnSide: room.currentTurnSide,
      startedAt,
      scores: room.scores
    });

    emitRoomState(roomCode);
  });

  socket.on(
    "noteResult",
    (payload: {
      roomCode: string;
      noteId: string;
      side: Side;
      rating: string;
      scoreDelta: number;
      combo: number;
    }) => {
      const roomCode = normalizeRoomCode(payload.roomCode);
      const room = rooms.get(roomCode);
      if (!room) return;

      const side: Side = payload.side === "B" ? "B" : "A";
      const scoreDelta = Number(payload.scoreDelta) || 0;

      room.scores[side] += Math.max(0, Math.floor(scoreDelta));

      io.to(roomCode).emit("noteResult", {
        noteId: payload.noteId,
        side,
        rating: payload.rating,
        scoreDelta,
        combo: Number(payload.combo) || 0,
        scores: room.scores
      });

      emitRoomState(roomCode);
    }
  );

  socket.on(
    "useSkill",
    (payload: {
      roomCode: string;
      fromSide: Side;
      skillId: string;
      skillName: string;
      targetSide: Side;
      fireAt: number;
    }) => {
      const roomCode = normalizeRoomCode(payload.roomCode);
      const room = rooms.get(roomCode);
      if (!room) return;

      const fromSide: Side = payload.fromSide === "B" ? "B" : "A";
      const targetSide: Side = payload.targetSide === "B" ? "B" : "A";

      io.to(roomCode).emit("skillActivated", {
        fromSide,
        skillId: payload.skillId,
        skillName: payload.skillName,
        targetSide,
        fireAt: Number(payload.fireAt) || Date.now()
      });
    }
  );

  socket.on("battleEnded", (payload: { roomCode: string }) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    if (!room) return;

    room.phase = "result";

    io.to(roomCode).emit("battleEnded", {
      scores: room.scores
    });

    emitRoomState(roomCode);
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
    removePlayer(socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Beat Rise server running on port ${PORT}`);
});