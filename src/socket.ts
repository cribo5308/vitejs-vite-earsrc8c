import { io } from "socket.io-client";

const SOCKET_SERVER_URL = "https://beat-rise-server.onrender.com";

export const socket = io(SOCKET_SERVER_URL, {
  autoConnect: false,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 800,
  timeout: 20000,
});

export type Side = "A" | "B";

export type ServerRoomPlayer = {
  socketId: string;
  side: Side;
  ready: boolean;
  characters: string[];
};

export type ServerRoomState = {
  roomCode: string;
  phase: "waiting" | "select" | "bottle" | "battle" | "result";
  players: ServerRoomPlayer[];
  firstSide: Side | null;
  turnIndex: number;
  currentTurnSide: Side | null;
  scores: {
    A: number;
    B: number;
  };
  startedAt: number | null;
};
