import { io } from "socket.io-client";

function getSocketServerUrl() {
  const envUrl = import.meta.env.VITE_SOCKET_SERVER_URL;

  if (envUrl) return envUrl;

  const { protocol, hostname } = window.location;

  // StackBlitz WebContainer 주소에서 프론트 포트를 서버 포트 3001로 바꿈
  if (hostname.includes("webcontainer-api.io")) {
    const serverHostname = hostname.replace(/-(\d+)(--|-)/, "-3001$2");
    return `${protocol}//${serverHostname}`;
  }

  return "http://localhost:3001";
}

export const socket = io(getSocketServerUrl(), {
  autoConnect: false,
  transports: ["websocket", "polling"],
});

export type ServerRoomPlayer = {
  socketId: string;
  side: "A" | "B";
  ready: boolean;
  characters: string[];
};

export type ServerRoomState = {
  roomCode: string;
  phase: "waiting" | "select" | "bottle" | "battle" | "result";
  players: ServerRoomPlayer[];
  firstSide: "A" | "B" | null;
  turnIndex: number;
  currentTurnSide: "A" | "B" | null;
  scores: {
    A: number;
    B: number;
  };
  startedAt: number | null;
};