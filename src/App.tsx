import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { socket, type ServerRoomState } from "./socket";
import "./App.css";

type Phase =
  | "start"
  | "room"
  | "select"
  | "ready"
  | "bottle"
  | "battle"
  | "result";

type Side = "A" | "B";
type NoteType = "tap" | "hold";
type Rating = "PERFECT" | "GOOD" | "MISS" | "TAUNT MISS";
type HitRating = "PERFECT" | "GOOD";
type SkillTarget = "own" | "opponent";

type Character = {
  id: string;
  name: string;
  emoji: string;
  role: string;
  skillName: string;
  skillTarget: SkillTarget;
  costRatio: number;
  desc: string;
};

type BattleNote = {
  id: string;
  type: NoteType;
  lane: number;
  targetTime: number;
  duration: number;
  judged: boolean;
  holding?: boolean;
  holdRating?: HitRating;
  holdLastTickAt?: number;
};

type ActiveEffects = {
  waterUntil: number;
  pushStartedAt: number;
  pushUntil: number;
  tauntUntil: number;
  easyUntil: number;
  feverUntil: number;
};

type PendingSkill = {
  charId: string;
  skillName: string;
  fireAt: number;
};

type Feedback = {
  text: string;
  kind: "perfect" | "good" | "miss" | "skill";
  key: number;
};

type HoldTransfer = {
  noteId: string;
  requiredLane: number;
  until: number;
};

const TURN_DURATION = 30;
const TOTAL_TURNS = 4;
const LANE_COUNT = 4;

const NOTE_COUNT = 50;
const HOLD_COUNT = 10;

const FALL_DURATION = 1.8;
const NOTE_START_TOP = -12;
const JUDGE_LINE_TOP = 82;

const PERFECT_WINDOW = 0.09;
const GOOD_WINDOW = 0.22;
const EASY_GOOD_WINDOW = 0.34;
const MISS_AFTER_LINE = 0.28;

const HOLD_TICK_INTERVAL = 0.25;
const HOLD_RELEASE_EARLY_WINDOW = 0.22;
const HOLD_FLIP_RECATCH_WINDOW_MS = 250;

const WATER_REVEAL_TIME = 0.34;
const WATER_FAINT_START_RATIO = 0.5;

const SKILL_DELAY_MS = 2000;
const SKILL_COOLDOWN_MS = 15000;

const PUSH_FLIP_INTERVAL_MS = 3000;
const PUSH_FLIP_COUNT = 3;
const PUSH_DURATION_MS = PUSH_FLIP_INTERVAL_MS * PUSH_FLIP_COUNT;

const MUSIC_BPM = 128;
const MUSIC_OFFSET_SEC = 0;
const TOTAL_BATTLE_DURATION = 120;
const GENERATED_BEAT_VOLUME = 0.22;
const USE_GENERATED_BEAT = false;

const COMBO_MULTIPLIERS = {
  NORMAL: 1,
  TEN_PLUS: 1.5,
  TWENTY_PLUS: 2,
};

const characters: Character[] = [
  {
    id: "rio",
    name: "리오",
    emoji: "💧",
    role: "방해 / 시야 차단",
    skillName: "물뿌리기",
    skillTarget: "opponent",
    costRatio: 0.2,
    desc: "상대 노트가 늦게 보인다.",
  },
  {
    id: "jet",
    name: "제트",
    emoji: "🌀",
    role: "방해 / 좌우 반전",
    skillName: "밀치기",
    skillTarget: "opponent",
    costRatio: 0.2,
    desc: "3초마다 좌우반전, 총 3회.",
  },
  {
    id: "mika",
    name: "미카",
    emoji: "😈",
    role: "방해 / 멘탈 공격",
    skillName: "도발",
    skillTarget: "opponent",
    costRatio: 0.1,
    desc: "성공 판정이 30% 확률로 Miss.",
  },
  {
    id: "luna",
    name: "루나",
    emoji: "🌙",
    role: "버프 / 안정",
    skillName: "이지모드",
    skillTarget: "own",
    costRatio: 0,
    desc: "판정 범위 증가, Good 보너스.",
  },
  {
    id: "kai",
    name: "카이",
    emoji: "🔥",
    role: "버프 / 폭발",
    skillName: "피버타임",
    skillTarget: "own",
    costRatio: 0,
    desc: "10초간 점수 2배. 콤보 실패 시 종료.",
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function otherSide(side: Side): Side {
  return side === "A" ? "B" : "A";
}

function hashSeed(seed: string) {
  let hash = 2166136261;

  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createRng(seed: string) {
  let state = hashSeed(seed);

  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(array: T[], rng: () => number) {
  const copied = [...array];

  for (let i = copied.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }

  return copied;
}

function generateBeatTimesForTurn(turnIndex: number, rng: () => number) {
  const turnGlobalStart = turnIndex * TURN_DURATION;
  const turnGlobalEnd = turnGlobalStart + TURN_DURATION;
  const beatInterval = 60 / MUSIC_BPM;

  const beatTimes: number[] = [];

  for (
    let globalTime = MUSIC_OFFSET_SEC;
    globalTime < TOTAL_BATTLE_DURATION;
    globalTime += beatInterval
  ) {
    if (
      globalTime >= turnGlobalStart + 1.0 &&
      globalTime <= turnGlobalEnd - 1.0
    ) {
      beatTimes.push(globalTime - turnGlobalStart);
    }
  }

  const halfBeatTimes: number[] = [];

  for (const beatTime of beatTimes) {
    const halfBeat = beatTime + beatInterval / 2;

    if (halfBeat >= 1.0 && halfBeat <= TURN_DURATION - 1.0) {
      halfBeatTimes.push(halfBeat);
    }
  }

  const candidates = seededShuffle([...beatTimes, ...halfBeatTimes], rng).sort(
    (a, b) => a - b
  );

  const picked: number[] = [];

  for (const time of candidates) {
    const tooClose = picked.some(
      (pickedTime) => Math.abs(pickedTime - time) < 0.22
    );

    if (!tooClose) {
      picked.push(time);
    }

    if (picked.length >= NOTE_COUNT) break;
  }

  return picked.sort((a, b) => a - b);
}

function pickHoldIndexesFromTimes(times: number[], rng: () => number) {
  const picked: number[] = [];

  const candidates = seededShuffle(
    times
      .map((_, index) => index)
      .filter((index) => index >= 3 && index <= times.length - 4),
    rng
  );

  for (const index of candidates) {
    const tooClose = picked.some(
      (pickedIndex) => Math.abs(pickedIndex - index) < 5
    );

    if (!tooClose) picked.push(index);
    if (picked.length >= HOLD_COUNT) break;
  }

  return picked;
}

function isLaneBlockedByHold(
  lane: number,
  time: number,
  holds: BattleNote[],
  padding = 0.42
) {
  return holds.some((hold) => {
    if (hold.lane !== lane) return false;

    const holdStart = hold.targetTime - padding;
    const holdEnd = hold.targetTime + hold.duration + padding;

    return time >= holdStart && time <= holdEnd;
  });
}

function pickSafeLaneForTap(
  time: number,
  holds: BattleNote[],
  rng: () => number
) {
  const lanes = seededShuffle([0, 1, 2, 3], rng);

  const safeLane = lanes.find(
    (lane) => !isLaneBlockedByHold(lane, time, holds, 0.42)
  );

  return safeLane ?? lanes[0];
}

function pickSafeLaneForHold(
  time: number,
  duration: number,
  existingHolds: BattleNote[],
  rng: () => number
) {
  const lanes = seededShuffle([0, 1, 2, 3], rng);

  const safeLane = lanes.find((lane) => {
    const newStart = time - 0.5;
    const newEnd = time + duration + 0.5;

    return !existingHolds.some((hold) => {
      if (hold.lane !== lane) return false;

      const oldStart = hold.targetTime - 0.5;
      const oldEnd = hold.targetTime + hold.duration + 0.5;

      return newStart <= oldEnd && newEnd >= oldStart;
    });
  });

  return safeLane ?? lanes[0];
}

function generateNotes(
  turnIndex: number,
  roomCode: string,
  firstSide: Side | null
) {
  const seed = `${roomCode || "BEAT"}-${
    firstSide || "A"
  }-${turnIndex}-${MUSIC_BPM}`;
  const rng = createRng(seed);

  const beatTimes = generateBeatTimesForTurn(turnIndex, rng);

  while (beatTimes.length < NOTE_COUNT) {
    const index = beatTimes.length;
    const fallbackTime =
      1.2 + index * ((TURN_DURATION - 2.6) / (NOTE_COUNT - 1));
    beatTimes.push(fallbackTime);
  }

  const finalTimes = beatTimes.slice(0, NOTE_COUNT).sort((a, b) => a - b);

  const holdIndexes = pickHoldIndexesFromTimes(finalTimes, rng);
  const holdIndexSet = new Set(holdIndexes);

  const holds: BattleNote[] = [];
  const notes: BattleNote[] = [];

  for (let index = 0; index < finalTimes.length; index += 1) {
    const type: NoteType = holdIndexSet.has(index) ? "hold" : "tap";
    const targetTime = finalTimes[index];

    if (type === "hold") {
      const beatInterval = 60 / MUSIC_BPM;
      const duration = beatInterval * (rng() > 0.5 ? 3 : 2) + rng() * 0.15;
      const lane = pickSafeLaneForHold(targetTime, duration, holds, rng);

      const holdNote: BattleNote = {
        id: `turn-${turnIndex}-note-${index}-hold`,
        type: "hold",
        lane,
        targetTime,
        duration,
        judged: false,
      };

      holds.push(holdNote);
      notes.push(holdNote);
      continue;
    }

    const lane = pickSafeLaneForTap(targetTime, holds, rng);

    notes.push({
      id: `turn-${turnIndex}-note-${index}-tap`,
      type: "tap",
      lane,
      targetTime,
      duration: 0,
      judged: false,
    });
  }

  return notes;
}

function getBaseScore(note: BattleNote, rating: HitRating) {
  if (note.type === "tap") return rating === "PERFECT" ? 100 : 65;
  return rating === "PERFECT" ? 160 : 105;
}

function getComboMultiplier(comboValue: number) {
  if (comboValue >= 20) return COMBO_MULTIPLIERS.TWENTY_PLUS;
  if (comboValue >= 10) return COMBO_MULTIPLIERS.TEN_PLUS;
  return COMBO_MULTIPLIERS.NORMAL;
}

function getComboMultiplierLabel(comboValue: number) {
  const multiplier = getComboMultiplier(comboValue);

  if (multiplier === 2) return "x2.0";
  if (multiplier === 1.5) return "x1.5";
  return "x1.0";
}

function createBeep(
  context: AudioContext,
  time: number,
  frequency: number,
  duration: number,
  volume: number
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, time);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(time);
  oscillator.stop(time + duration + 0.02);
}

function createKick(context: AudioContext, time: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(130, time);
  oscillator.frequency.exponentialRampToValueAtTime(45, time + 0.16);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(
    GENERATED_BEAT_VOLUME * 1.2,
    time + 0.01
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(time);
  oscillator.stop(time + 0.2);
}

function createHat(context: AudioContext, time: number) {
  const bufferSize = Math.floor(context.sampleRate * 0.04);
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();

  noise.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.setValueAtTime(7000, time);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(
    GENERATED_BEAT_VOLUME * 0.28,
    time + 0.005
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);

  noise.start(time);
  noise.stop(time + 0.05);
}

function createSnare(context: AudioContext, time: number) {
  const bufferSize = Math.floor(context.sampleRate * 0.09);
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();

  noise.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1800, time);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(
    GENERATED_BEAT_VOLUME * 0.8,
    time + 0.01
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);

  noise.start(time);
  noise.stop(time + 0.12);
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("start");
  const [roomCode, setRoomCode] = useState("");
  const [mySide, setMySide] = useState<Side>("A");
  const [serverRoom, setServerRoom] = useState<ServerRoomState | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [joined, setJoined] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [firstSide, setFirstSide] = useState<Side | null>(null);

  const [bottleSpinning, setBottleSpinning] = useState(false);
  const [bottleAngle, setBottleAngle] = useState(0);

  const [turnIndex, setTurnIndex] = useState(0);
  const [turnStartMs, setTurnStartMs] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());

  const [notes, setNotes] = useState<BattleNote[]>([]);
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);
  const [combo, setCombo] = useState(0);

  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [pendingSkill, setPendingSkill] = useState<PendingSkill | null>(null);

  const [activeEffects, setActiveEffects] = useState<ActiveEffects>({
    waterUntil: 0,
    pushStartedAt: 0,
    pushUntil: 0,
    tauntUntil: 0,
    easyUntil: 0,
    feverUntil: 0,
  });

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [holdTransfer, setHoldTransfer] = useState<HoldTransfer | null>(null);
  const [pressedLanes, setPressedLanes] = useState<boolean[]>(
    Array.from({ length: LANE_COUNT }, () => false)
  );

  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<BattleNote[]>([]);
  const processedNoteIdsRef = useRef<Set<string>>(new Set());
  const comboRef = useRef(0);

  const currentElapsedRef = useRef(0);
  const currentTurnSideRef = useRef<Side>("A");
  const activeEffectsRef = useRef(activeEffects);
  const phaseRef = useRef<Phase>("start");
  const mySideRef = useRef<Side>("A");
  const holdingNoteIdRef = useRef<string | null>(null);
  const activePointerLanesRef = useRef<Map<number, number>>(new Map());
  const holdPointerNoteIdsRef = useRef<Map<number, string>>(new Map());
  const lastFlipCountRef = useRef(0);
  const advancingRef = useRef(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const beatTimerRef = useRef<number | null>(null);
  const beatStartTimeRef = useRef(0);

  const selectedTeam = useMemo(
    () =>
      selectedIds
        .map((id) => characters.find((char) => char.id === id))
        .filter(Boolean) as Character[],
    [selectedIds]
  );

  const rivalTeam = useMemo(() => {
    const rest = characters.filter((char) => !selectedIds.includes(char.id));
    const fallback = characters.filter((char) => selectedIds.includes(char.id));
    return [...rest, ...fallback].slice(0, 2);
  }, [selectedIds]);

  const turnOrder = useMemo(() => {
    const first = firstSide ?? "A";
    return [first, otherSide(first), first, otherSide(first)] as Side[];
  }, [firstSide]);

  const currentTurnSide = turnOrder[turnIndex] ?? "A";
  const isMyTurn = currentTurnSide === mySide;
  const isSpectating = !isMyTurn;
  const roundNumber = Math.floor(turnIndex / 2) + 1;

  const myScore = mySide === "A" ? scoreA : scoreB;
  const rivalScore = mySide === "A" ? scoreB : scoreA;

  const waterActive = nowMs < activeEffects.waterUntil;
  const pushActive = nowMs < activeEffects.pushUntil;
  const tauntActive = nowMs < activeEffects.tauntUntil;
  const easyActive = nowMs < activeEffects.easyUntil;
  const feverActive = nowMs < activeEffects.feverUntil;

  const pushFlipCount = getPushFlipCount(
    nowMs,
    activeEffects.pushStartedAt,
    activeEffects.pushUntil
  );
  const lanesFlipped = pushFlipCount % 2 === 1;
  const pushTimer = getPushTimer(
    nowMs,
    activeEffects.pushStartedAt,
    activeEffects.pushUntil
  );

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    socket.on("joinedRoom", ({ roomCode, side, state }) => {
      setRoomCode(roomCode);
      setMySide(side);
      setJoined(true);
      setServerRoom(state);
      setPhase("select");
    });

    socket.on("roomFull", ({ roomCode }) => {
      alert(`${roomCode} 방이 가득 찼어.`);
    });

    socket.on("roomState", (state) => {
      setServerRoom(state);

      if (state.scores) {
        setScoreA(state.scores.A);
        setScoreB(state.scores.B);
      }

      if (state.firstSide) {
        setFirstSide(state.firstSide);
      }
    });

    socket.on("bottleResult", ({ firstSide, angle }) => {
      setBottleSpinning(true);
      setBottleAngle(angle);
      setFirstSide(firstSide);

      window.setTimeout(() => {
        setBottleSpinning(false);
      }, 2300);
    });

    socket.on("battleStarted", ({ firstSide, turnIndex, startedAt }) => {
      const firstNotes = generateNotes(turnIndex, roomCode || "BEAT", firstSide);

      setFirstSide(firstSide);
      resetTurnStateOnly();
      setTurnIndex(turnIndex);
      setTurnStartMs(performance.now() - Math.max(0, Date.now() - startedAt));
      setElapsed(0);
      setScoreA(0);
      setScoreB(0);
      setCooldowns({});
      setPendingSkill(null);
      setNotesSafe(firstNotes);
      setPhase("battle");
    });

    socket.on("turnChanged", ({ turnIndex, startedAt }) => {
      const nextNotes = generateNotes(turnIndex, roomCode || "BEAT", firstSide);

      resetTurnStateOnly();
      setTurnIndex(turnIndex);
      setElapsed(0);
      setNotesSafe(nextNotes);
      setTurnStartMs(performance.now() - Math.max(0, Date.now() - startedAt));
    });

    socket.on("noteResult", (payload) => {
      setScoreA(payload.scores.A);
      setScoreB(payload.scores.B);

      if (payload.side !== mySideRef.current) {
        markRemoteNoteJudged(payload.noteId);

        if (payload.rating === "MISS" || payload.rating === "TAUNT MISS") {
          showFeedback(payload.rating, "miss");
        } else {
          showFeedback(
            `${payload.rating} ${getComboMultiplierLabel(payload.combo)}`,
            payload.rating === "PERFECT" ? "perfect" : "good"
          );
        }
      }
    });

    socket.on(
      "skillActivated",
      ({ fromSide, skillId, skillName, targetSide, fireAt }) => {
        const delay = Math.max(0, fireAt - Date.now());

        window.setTimeout(() => {
          applySkillEffect(skillId, skillName, fromSide, targetSide);
        }, delay);
      }
    );

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("joinedRoom");
      socket.off("roomFull");
      socket.off("roomState");
      socket.off("bottleResult");
      socket.off("battleStarted");
      socket.off("turnChanged");
      socket.off("noteResult");
      socket.off("skillActivated");
    };
  }, [roomCode, firstSide]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    activeEffectsRef.current = activeEffects;
  }, [activeEffects]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    mySideRef.current = mySide;
  }, [mySide]);

  useEffect(() => {
    currentTurnSideRef.current = currentTurnSide;
  }, [currentTurnSide]);

  useEffect(() => {
    comboRef.current = combo;
  }, [combo]);

  useEffect(() => {
    if (phase !== "battle") {
      stopGeneratedBeat();
      return;
    }

    if (!USE_GENERATED_BEAT) {
      stopGeneratedBeat();
      return;
    }

    const currentTurnElapsed = Math.max(
      0,
      (performance.now() - turnStartMs) / 1000
    );

    const globalOffsetSec = clamp(
      turnIndex * TURN_DURATION + currentTurnElapsed,
      0,
      TOTAL_BATTLE_DURATION - 0.5
    );

    startGeneratedBeat(globalOffsetSec);

    return () => {
      stopGeneratedBeat();
    };
  }, [phase, turnIndex, turnStartMs]);

  function stopGeneratedBeat() {
    if (beatTimerRef.current !== null) {
      window.clearInterval(beatTimerRef.current);
      beatTimerRef.current = null;
    }
  }

  function startGeneratedBeat(globalOffsetSec: number) {
    stopGeneratedBeat();

    const AudioContextClass =
      window.AudioContext ||
      (
        window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }
      ).webkitAudioContext;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextClass();
    }

    const context = audioContextRef.current;

    if (context.state === "suspended") {
      context.resume().catch(() => {});
    }

    const beatInterval = 60 / MUSIC_BPM;
    const lookAhead = 0.12;

    beatStartTimeRef.current = context.currentTime - globalOffsetSec;

    let scheduledUntil = globalOffsetSec;

    const schedule = () => {
      const currentGlobalTime = context.currentTime - beatStartTimeRef.current;
      const scheduleUntil = currentGlobalTime + lookAhead;

      while (
        scheduledUntil < scheduleUntil &&
        scheduledUntil < TOTAL_BATTLE_DURATION
      ) {
        const beatNumber = Math.round(
          (scheduledUntil - MUSIC_OFFSET_SEC) / beatInterval
        );
        const beatTime = MUSIC_OFFSET_SEC + beatNumber * beatInterval;

        if (beatTime >= 0 && beatTime >= currentGlobalTime - 0.02) {
          const audioTime = beatStartTimeRef.current + beatTime;
          const beatInBar = ((beatNumber % 4) + 4) % 4;

          if (beatInBar === 0) {
            createKick(context, audioTime);
            createBeep(
              context,
              audioTime,
              220,
              0.06,
              GENERATED_BEAT_VOLUME * 0.35
            );
          }

          if (beatInBar === 1 || beatInBar === 3) {
            createSnare(context, audioTime);
          }

          createHat(context, audioTime);

          const halfBeatTime = audioTime + beatInterval / 2;
          if (halfBeatTime < beatStartTimeRef.current + TOTAL_BATTLE_DURATION) {
            createHat(context, halfBeatTime);
          }
        }

        scheduledUntil += beatInterval;
      }
    };

    schedule();
    beatTimerRef.current = window.setInterval(schedule, 25);
  }

  function getPushFlipCount(timeMs: number, startedAt: number, until: number) {
    if (!startedAt || timeMs >= until) return 0;

    const elapsedMs = Math.max(0, timeMs - startedAt);

    return clamp(
      Math.floor(elapsedMs / PUSH_FLIP_INTERVAL_MS),
      0,
      PUSH_FLIP_COUNT
    );
  }

  function getPushTimer(timeMs: number, startedAt: number, until: number) {
    if (!startedAt || timeMs >= until) {
      return {
        active: false,
        nextIn: 0,
        count: 0,
      };
    }

    const elapsedMs = Math.max(0, timeMs - startedAt);
    const count = clamp(
      Math.floor(elapsedMs / PUSH_FLIP_INTERVAL_MS),
      0,
      PUSH_FLIP_COUNT
    );
    const nextFlipAt = startedAt + (count + 1) * PUSH_FLIP_INTERVAL_MS;
    const nextIn = clamp((nextFlipAt - timeMs) / 1000, 0, 3);

    return {
      active: count < PUSH_FLIP_COUNT,
      nextIn,
      count,
    };
  }

  function setNotesSafe(nextNotes: BattleNote[]) {
    notesRef.current = nextNotes;
    setNotes(nextNotes);
  }

  function updateNotes(updater: (prev: BattleNote[]) => BattleNote[]) {
    const nextNotes = updater(notesRef.current);
    notesRef.current = nextNotes;
    setNotes(nextNotes);
  }

  function showFeedback(text: string, kind: Feedback["kind"]) {
    setFeedback({
      text,
      kind,
      key: Date.now() + Math.random(),
    });
  }

  function getDisplayLane(lane: number) {
    const effects = activeEffectsRef.current;
    const flipCount = getPushFlipCount(
      Date.now(),
      effects.pushStartedAt,
      effects.pushUntil
    );
    const flipped = flipCount % 2 === 1;

    return flipped ? LANE_COUNT - 1 - lane : lane;
  }

  function getLaneFromPointer(clientX: number) {
    const area = laneAreaRef.current;
    if (!area) return 0;

    const rect = area.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width - 1);

    return clamp(Math.floor((x / rect.width) * LANE_COUNT), 0, LANE_COUNT - 1);
  }

  function refreshPressedLanes() {
    const activeLanes = Array.from(activePointerLanesRef.current.values());

    setPressedLanes(
      Array.from({ length: LANE_COUNT }, (_, lane) => activeLanes.includes(lane))
    );
  }

  function pressLane(pointerId: number, lane: number) {
    activePointerLanesRef.current.set(pointerId, lane);
    refreshPressedLanes();
  }

  function releasePointer(pointerId: number) {
    activePointerLanesRef.current.delete(pointerId);
    holdPointerNoteIdsRef.current.delete(pointerId);
    refreshPressedLanes();
  }

  function getJudgeWindow() {
    return Date.now() < activeEffectsRef.current.easyUntil
      ? EASY_GOOD_WINDOW
      : GOOD_WINDOW;
  }

  function getRating(delta: number): HitRating {
    return Math.abs(delta) <= PERFECT_WINDOW ? "PERFECT" : "GOOD";
  }

  function calculateScore(
    note: BattleNote,
    rating: HitRating,
    isHoldTick = false,
    comboValue = comboRef.current + 1
  ) {
    const effects = activeEffectsRef.current;

    let score = isHoldTick
      ? rating === "PERFECT"
        ? 28
        : 20
      : getBaseScore(note, rating);

    if (Date.now() < effects.easyUntil && rating === "GOOD") {
      score += isHoldTick ? 5 : 25;
    }

    score *= getComboMultiplier(comboValue);

    if (Date.now() < effects.feverUntil) {
      score *= 2;
    }

    return Math.floor(score);
  }

  function spendMyScore(costRatio: number) {
    if (costRatio <= 0) return;

    if (mySideRef.current === "A") {
      setScoreA((prev) => Math.max(0, prev - Math.floor(prev * costRatio)));
    } else {
      setScoreB((prev) => Math.max(0, prev - Math.floor(prev * costRatio)));
    }
  }

  function breakComboByMiss(text: Rating = "MISS") {
    setCombo(0);
    comboRef.current = 0;

    setActiveEffects((prev) => ({
      ...prev,
      feverUntil: 0,
    }));

    showFeedback(text, "miss");
  }

  function emitNoteResult(
    noteId: string,
    rating: Rating,
    scoreDelta: number,
    nextCombo: number
  ) {
    socket.emit("noteResult", {
      roomCode: roomCode || "BEAT",
      noteId,
      side: mySideRef.current,
      rating,
      scoreDelta,
      combo: nextCombo,
    });
  }

  function applyLocalScoreDelta(scoreDelta: number) {
    if (mySideRef.current === "A") {
      setScoreA((prev) => prev + scoreDelta);
    } else {
      setScoreB((prev) => prev + scoreDelta);
    }
  }

  function shouldTauntMiss() {
    return Date.now() < activeEffectsRef.current.tauntUntil
      ? Math.random() < 0.3
      : false;
  }

  function judgeMyNoteSuccess(note: BattleNote, rating: HitRating) {
    if (shouldTauntMiss()) {
      markNoteJudged(note.id);
      breakComboByMiss("TAUNT MISS");
      emitNoteResult(note.id, "TAUNT MISS", 0, 0);
      return;
    }

    const nextCombo = comboRef.current + 1;
    const scoreDelta = calculateScore(note, rating, false, nextCombo);

    applyLocalScoreDelta(scoreDelta);
    setCombo(nextCombo);
    comboRef.current = nextCombo;

    showFeedback(
      `${rating} ${getComboMultiplierLabel(nextCombo)}`,
      rating === "PERFECT" ? "perfect" : "good"
    );

    markNoteJudged(note.id);
    emitNoteResult(note.id, rating, scoreDelta, nextCombo);
  }

  function applyHoldTickScore(note: BattleNote, rating: HitRating, tickCount = 1) {
    let totalScore = 0;
    let nextCombo = comboRef.current;

    for (let i = 0; i < tickCount; i += 1) {
      nextCombo += 1;
      totalScore += calculateScore(note, rating, true, nextCombo);
    }

    const tickId = `${note.id}-hold-${Date.now()}-${Math.random()}`;

    applyLocalScoreDelta(totalScore);
    setCombo(nextCombo);
    comboRef.current = nextCombo;

    showFeedback(
      `${
        rating === "PERFECT" ? "PERFECT HOLD" : "GOOD HOLD"
      } ${getComboMultiplierLabel(nextCombo)}`,
      rating === "PERFECT" ? "perfect" : "good"
    );

    emitNoteResult(tickId, rating, totalScore, nextCombo);
  }

  function markNoteJudged(noteId: string, patch?: Partial<BattleNote>) {
    processedNoteIdsRef.current.add(noteId);

    updateNotes((prev) =>
      prev.map((note) =>
        note.id === noteId
          ? {
              ...note,
              ...patch,
              judged: true,
              holding: false,
            }
          : note
      )
    );
  }

  function markRemoteNoteJudged(noteId: string) {
    updateNotes((prev) =>
      prev.map((note) =>
        note.id === noteId
          ? {
              ...note,
              judged: true,
              holding: false,
            }
          : note
      )
    );
  }

  function markNoteHolding(noteId: string, rating: HitRating, current: number) {
    updateNotes((prev) =>
      prev.map((note) =>
        note.id === noteId
          ? {
              ...note,
              holding: true,
              holdRating: rating,
              holdLastTickAt: current,
            }
          : note
      )
    );
  }

  function findCandidateNote(displayLane: number, allowedTypes: NoteType[]) {
    const current = currentElapsedRef.current;
    const window = getJudgeWindow();

    const candidates = notesRef.current
      .filter((note) => {
        if (note.judged) return false;
        if (note.holding) return false;
        if (processedNoteIdsRef.current.has(note.id)) return false;
        if (!allowedTypes.includes(note.type)) return false;

        const noteDisplayLane = getDisplayLane(note.lane);
        if (noteDisplayLane !== displayLane) return false;

        const delta = current - note.targetTime;

        return Math.abs(delta) <= window;
      })
      .sort(
        (a, b) =>
          Math.abs(current - a.targetTime) - Math.abs(current - b.targetTime)
      );

    return candidates[0] ?? null;
  }

  function recatchHoldAfterFlip(displayLane: number) {
    if (!holdTransfer) return false;
    if (Date.now() > holdTransfer.until) return false;
    if (displayLane !== holdTransfer.requiredLane) return false;

    const note = notesRef.current.find((item) => item.id === holdTransfer.noteId);
    if (!note || note.judged || !note.holding) return false;

    setHoldTransfer(null);
    holdingNoteIdRef.current = note.id;
    showFeedback("RECATCH!", "good");

    return true;
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (phase !== "battle") return;

    event.currentTarget.setPointerCapture(event.pointerId);

    const displayLane = getLaneFromPointer(event.clientX);
    pressLane(event.pointerId, displayLane);

    if (!isMyTurn) {
      showFeedback("상대 턴은 스킬로 방해", "skill");
      return;
    }

    const transferNoteId = holdTransfer?.noteId;

    if (holdTransfer && recatchHoldAfterFlip(displayLane)) {
      if (transferNoteId) {
        holdPointerNoteIdsRef.current.set(event.pointerId, transferNoteId);
      }
      return;
    }

    const current = currentElapsedRef.current;
    const candidate = findCandidateNote(displayLane, ["tap", "hold"]);
    if (!candidate) return;

    const delta = current - candidate.targetTime;
    const rating = getRating(delta);

    if (candidate.type === "hold") {
      holdingNoteIdRef.current = candidate.id;
      holdPointerNoteIdsRef.current.set(event.pointerId, candidate.id);

      markNoteHolding(candidate.id, rating, current);
      applyHoldTickScore(candidate, rating, 1);
      return;
    }

    judgeMyNoteSuccess(candidate, rating);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (phase !== "battle") return;

    const displayLane = getLaneFromPointer(event.clientX);
    pressLane(event.pointerId, displayLane);

    if (!isMyTurn) return;

    const transferNoteId = holdTransfer?.noteId;

    if (holdTransfer && recatchHoldAfterFlip(displayLane)) {
      if (transferNoteId) {
        holdPointerNoteIdsRef.current.set(event.pointerId, transferNoteId);
      }
    }
  }

  function handlePointerUp(event?: PointerEvent<HTMLDivElement>) {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!event) return;

    const holdingId = holdPointerNoteIdsRef.current.get(event.pointerId);

    if (!isMyTurn) {
      releasePointer(event.pointerId);
      return;
    }

    if (!holdingId) {
      releasePointer(event.pointerId);
      return;
    }

    const note = notesRef.current.find((item) => item.id === holdingId);

    if (
      note &&
      !note.judged &&
      note.holding &&
      !processedNoteIdsRef.current.has(note.id)
    ) {
      const current = currentElapsedRef.current;
      const holdEndTime = note.targetTime + note.duration;
      const rating = note.holdRating ?? "GOOD";

      const heldUntilEnd = current >= holdEndTime - HOLD_RELEASE_EARLY_WINDOW;

      if (heldUntilEnd) {
        applyHoldTickScore(note, rating, 1);
        showFeedback("HOLD END", rating === "PERFECT" ? "perfect" : "good");
      } else {
        showFeedback(
          "HOLD RELEASE",
          rating === "PERFECT" ? "perfect" : "good"
        );
      }

      markNoteJudged(note.id);
      emitNoteResult(
        `${note.id}-release-${Date.now()}`,
        rating,
        0,
        comboRef.current
      );
    }

    if (holdingNoteIdRef.current === holdingId) {
      holdingNoteIdRef.current = null;
    }

    releasePointer(event.pointerId);
    setHoldTransfer(null);
  }

  function processHoldTicks(current: number) {
    if (!isMyTurn) return;

    const holdTicks: { note: BattleNote; rating: HitRating; count: number }[] =
      [];

    updateNotes((prev) => {
      let changed = false;

      const next = prev.map((note) => {
        if (note.type !== "hold") return note;
        if (!note.holding) return note;
        if (note.judged) return note;
        if (processedNoteIdsRef.current.has(note.id)) return note;

        const holdEndTime = note.targetTime + note.duration;
        const tickLimit = Math.min(current, holdEndTime);
        const lastTickAt = note.holdLastTickAt ?? note.targetTime;

        if (tickLimit < lastTickAt + HOLD_TICK_INTERVAL) return note;

        const tickCount = Math.floor(
          (tickLimit - lastTickAt) / HOLD_TICK_INTERVAL
        );

        if (tickCount <= 0) return note;

        holdTicks.push({
          note,
          rating: note.holdRating ?? "GOOD",
          count: tickCount,
        });

        changed = true;

        return {
          ...note,
          holdLastTickAt: lastTickAt + tickCount * HOLD_TICK_INTERVAL,
        };
      });

      return changed ? next : prev;
    });

    holdTicks.forEach(({ note, rating, count }) => {
      applyHoldTickScore(note, rating, count);
    });
  }

  function processAutoMisses(current: number) {
    if (!isMyTurn) return;

    const misses: BattleNote[] = [];

    updateNotes((prev) => {
      let changed = false;

      const next = prev.map((note) => {
        if (note.judged) return note;
        if (processedNoteIdsRef.current.has(note.id)) return note;

        if (note.type === "hold" && note.holding) {
          const holdEndTime = note.targetTime + note.duration;

          if (
            holdTransfer &&
            holdTransfer.noteId === note.id &&
            Date.now() <= holdTransfer.until
          ) {
            return note;
          }

          if (
            holdTransfer &&
            holdTransfer.noteId === note.id &&
            Date.now() > holdTransfer.until
          ) {
            processedNoteIdsRef.current.add(note.id);
            changed = true;

            setTimeout(() => {
              showFeedback("HOLD RELEASE", "good");
              setHoldTransfer(null);
              holdingNoteIdRef.current = null;
            }, 0);

            return {
              ...note,
              judged: true,
              holding: false,
            };
          }

          if (current >= holdEndTime) {
            processedNoteIdsRef.current.add(note.id);
            changed = true;

            setTimeout(() => {
              const rating = note.holdRating ?? "GOOD";
              applyHoldTickScore(note, rating, 1);
              showFeedback(
                "HOLD END",
                rating === "PERFECT" ? "perfect" : "good"
              );
              holdingNoteIdRef.current = null;
              setHoldTransfer(null);
            }, 0);

            return {
              ...note,
              judged: true,
              holding: false,
            };
          }

          return note;
        }

        if (note.type === "hold") {
          if (current > note.targetTime + MISS_AFTER_LINE) {
            processedNoteIdsRef.current.add(note.id);
            misses.push(note);
            changed = true;

            return {
              ...note,
              judged: true,
              holding: false,
            };
          }

          return note;
        }

        if (current > note.targetTime + MISS_AFTER_LINE) {
          processedNoteIdsRef.current.add(note.id);
          misses.push(note);
          changed = true;

          return {
            ...note,
            judged: true,
            holding: false,
          };
        }

        return note;
      });

      return changed ? next : prev;
    });

    if (misses.length > 0) {
      misses.forEach((note) => {
        breakComboByMiss("MISS");
        emitNoteResult(note.id, "MISS", 0, 0);
      });

      setHoldTransfer(null);
      holdingNoteIdRef.current = null;
    }
  }

  function processFlipChange() {
    if (!isMyTurn) return;

    const currentFlipCount = getPushFlipCount(
      Date.now(),
      activeEffectsRef.current.pushStartedAt,
      activeEffectsRef.current.pushUntil
    );

    if (currentFlipCount === lastFlipCountRef.current) return;

    lastFlipCountRef.current = currentFlipCount;

    const holdingId = holdingNoteIdRef.current;
    if (!holdingId) return;

    const note = notesRef.current.find((item) => item.id === holdingId);
    if (!note || !note.holding || note.judged) return;

    const requiredLane = getDisplayLane(note.lane);

    setHoldTransfer({
      noteId: note.id,
      requiredLane,
      until: Date.now() + HOLD_FLIP_RECATCH_WINDOW_MS,
    });

    holdingNoteIdRef.current = null;
    showFeedback("FLIP! RECATCH", "skill");
  }

  function resetTurnStateOnly() {
    processedNoteIdsRef.current.clear();
    holdingNoteIdRef.current = null;
    activePointerLanesRef.current.clear();
    holdPointerNoteIdsRef.current.clear();
    lastFlipCountRef.current = 0;
    comboRef.current = 0;

    setPressedLanes(Array.from({ length: LANE_COUNT }, () => false));
    setHoldTransfer(null);
    setCombo(0);

    setActiveEffects({
      waterUntil: 0,
      pushStartedAt: 0,
      pushUntil: 0,
      tauntUntil: 0,
      easyUntil: 0,
      feverUntil: 0,
    });
  }

  function requestTurnChange() {
    if (advancingRef.current) return;

    advancingRef.current = true;

    setTimeout(() => {
      advancingRef.current = false;
    }, 350);

    if (turnIndex >= TOTAL_TURNS - 1) {
      resetTurnStateOnly();
      stopGeneratedBeat();
      setPhase("result");
      return;
    }

    if (isMyTurn) {
      socket.emit("turnChanged", {
        roomCode: roomCode || "BEAT",
        turnIndex: turnIndex + 1,
      });
    }
  }

  useEffect(() => {
    if (phase !== "battle") return;

    let raf = 0;

    const loop = (time: number) => {
      const current = clamp((time - turnStartMs) / 1000, 0, TURN_DURATION + 1);

      currentElapsedRef.current = current;
      setElapsed(current);
      setNowMs(Date.now());

      processFlipChange();
      processHoldTicks(current);
      processAutoMisses(current);

      if (current >= TURN_DURATION) {
        requestTurnChange();
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(raf);
  }, [phase, turnStartMs, turnIndex, isMyTurn, activeEffects, holdTransfer]);

  function goRoom() {
    if (!socket.connected) {
      socket.connect();
    }

    setPhase("room");
  }

  function joinRoom() {
    const normalized = (roomCode.trim().toUpperCase() || "BEAT").slice(0, 8);

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit("createOrJoinRoom", {
      roomCode: normalized,
    });
  }

  function toggleCharacter(id: string) {
    setSelectedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((item) => item !== id)
        : prev.length >= 2
          ? prev
          : [...prev, id];

      socket.emit("selectCharacters", {
        roomCode: roomCode || "BEAT",
        characters: next,
      });

      return next;
    });
  }

  function goReady() {
    if (selectedIds.length !== 2) return;

    socket.emit("playerReady", {
      roomCode: roomCode || "BEAT",
    });

    setPhase("ready");
  }

  function goBottle() {
    setPhase("bottle");
  }

  function spinBottle() {
    if (bottleSpinning) return;

    socket.emit("spinBottle", {
      roomCode: roomCode || "BEAT",
    });
  }

  function startBattle() {
    if (!firstSide) return;

    socket.emit("startBattle", {
      roomCode: roomCode || "BEAT",
    });
  }

  function applySkillEffect(
    skillId: string,
    skillName: string,
    _fromSide: Side,
    targetSide: Side
  ) {
    const now = Date.now();

    const effectShouldShow =
      targetSide === mySideRef.current || targetSide === currentTurnSideRef.current;

    if (!effectShouldShow) return;

    if (skillId === "rio") {
      setActiveEffects((prev) => ({
        ...prev,
        waterUntil: now + 5000,
      }));
      showFeedback(`${skillName}!`, "skill");
    }

    if (skillId === "jet") {
      setActiveEffects((prev) => ({
        ...prev,
        pushStartedAt: now,
        pushUntil: now + PUSH_DURATION_MS,
      }));
      lastFlipCountRef.current = 0;
      showFeedback(`${skillName}!`, "skill");
    }

    if (skillId === "mika") {
      setActiveEffects((prev) => ({
        ...prev,
        tauntUntil: now + 5000,
      }));
      showFeedback(`${skillName}!`, "skill");
    }

    if (skillId === "luna") {
      setActiveEffects((prev) => ({
        ...prev,
        easyUntil: now + 10000,
      }));
      showFeedback(`${skillName}!`, "skill");
    }

    if (skillId === "kai") {
      setActiveEffects((prev) => ({
        ...prev,
        feverUntil: now + 10000,
      }));
      showFeedback(`${skillName}!`, "skill");
    }
  }

  function canUseSkill(char: Character) {
    if (phase !== "battle") return false;
    if (pendingSkill) return false;

    const cdUntil = cooldowns[char.id] ?? 0;
    if (nowMs < cdUntil) return false;

    if (char.skillTarget === "own" && !isMyTurn) return false;
    if (char.skillTarget === "opponent" && isMyTurn) return false;

    return true;
  }

  function handleSkillClick(char: Character) {
    if (!canUseSkill(char)) return;

    const now = Date.now();
    const targetSide = char.skillTarget === "own" ? mySide : currentTurnSide;

    setCooldowns((prev) => ({
      ...prev,
      [char.id]: now + SKILL_COOLDOWN_MS,
    }));

    setPendingSkill({
      charId: char.id,
      skillName: char.skillName,
      fireAt: now + SKILL_DELAY_MS,
    });

    spendMyScore(char.costRatio);
    showFeedback("2초 뒤 발동", "skill");

    socket.emit("useSkill", {
      roomCode: roomCode || "BEAT",
      fromSide: mySide,
      skillId: char.id,
      skillName: char.skillName,
      targetSide,
      fireAt: now + SKILL_DELAY_MS,
    });

    window.setTimeout(() => {
      setPendingSkill(null);
    }, SKILL_DELAY_MS + 100);
  }

  function getCooldownText(charId: string) {
    const cdUntil = cooldowns[charId] ?? 0;
    const remain = Math.ceil((cdUntil - nowMs) / 1000);

    return remain > 0 ? `${remain}s` : "";
  }

  function getNoteTop(note: BattleNote) {
    const progress = 1 - (note.targetTime - elapsed) / FALL_DURATION;

    return NOTE_START_TOP + progress * (JUDGE_LINE_TOP - NOTE_START_TOP);
  }

  function isNoteVisibleInArea(note: BattleNote) {
    if (note.judged) return false;

    const appearAt = note.targetTime - FALL_DURATION;
    const disappearAt =
      note.type === "hold"
        ? note.targetTime + note.duration + 0.15
        : note.targetTime + MISS_AFTER_LINE;

    return elapsed >= appearAt && elapsed <= disappearAt + 0.1;
  }

  function getWaterNoteStyle(note: BattleNote): CSSProperties {
    if (!waterActive || !isMyTurn) return {};

    const timeUntilLine = note.targetTime - elapsed;
    const faintStartTime = FALL_DURATION * WATER_FAINT_START_RATIO;

    if (timeUntilLine > faintStartTime) {
      return {
        opacity: 0,
        filter: "blur(8px)",
      };
    }

    if (timeUntilLine > WATER_REVEAL_TIME) {
      return {
        opacity: 0.08,
        filter: "blur(6px)",
      };
    }

    const revealProgress = clamp(1 - timeUntilLine / WATER_REVEAL_TIME, 0, 1);
    const opacity = 0.12 + revealProgress * 0.88;
    const blur = 6 - revealProgress * 6;

    return {
      opacity,
      filter: `blur(${blur}px)`,
    };
  }

  const progressPercent = clamp((elapsed / TURN_DURATION) * 100, 0, 100);

  const winnerSide: Side | null =
    scoreA === scoreB ? null : scoreA > scoreB ? "A" : "B";

  const iWon = winnerSide === mySide;

  const opponentConnected = (serverRoom?.players.length ?? 0) >= 2;
  const bothReady =
    serverRoom?.players.length === 2 &&
    serverRoom.players.every((player) => player.ready);

  return (
    <main className="app">
      <section className="phone">
        {phase === "start" && (
          <div className="screen startScreen">
            <div className="logoMark">BR</div>
            <h1>Beat Rise</h1>
            <p>실시간 턴제 리듬 배틀</p>

            <button className="primaryButton" onClick={goRoom}>
              ONLINE BATTLE
            </button>

            <p className="startHint">
              서버 상태: {connected ? "연결 가능" : "아직 연결 안 됨"}
            </p>
          </div>
        )}

        {phase === "room" && (
          <div className="screen roomScreen">
            <p className="eyebrow">ONLINE ROOM</p>
            <h2>방 코드 입력</h2>

            <div className="roomCard">
              <label>ROOM CODE</label>
              <input
                value={roomCode}
                onChange={(event) =>
                  setRoomCode(event.target.value.toUpperCase())
                }
                placeholder="예: BEAT"
                maxLength={8}
              />

              <label>서버 연결</label>
              <div className="sideButtons">
                <button className={connected ? "active" : ""}>
                  {connected ? "CONNECTED" : "DISCONNECTED"}
                </button>
                <button className={joined ? "active" : ""}>
                  {joined ? `${mySide} 진영` : "NOT JOINED"}
                </button>
              </div>
            </div>

            <div className="ruleBox">
              <p>
                첫 번째 접속자는 A 진영, 두 번째 접속자는 B 진영으로 자동
                배정돼.
              </p>
              <p>같은 방 코드를 입력한 두 화면이 같은 방에 들어가.</p>
            </div>

            <button className="primaryButton bottomButton" onClick={joinRoom}>
              입장하기
            </button>
          </div>
        )}

        {phase === "select" && (
          <div className="screen selectScreen">
            <header className="topHeader">
              <div>
                <p className="eyebrow">ROOM {roomCode || "BEAT"}</p>
                <h2>캐릭터 2명 선택</h2>
              </div>
              <span className="pill">{mySide} 진영</span>
            </header>

            <p className="helperText">
              상대 접속: {opponentConnected ? "완료" : "대기 중"} / 방해기술은
              상대 턴, 버프기술은 내 턴에만 사용 가능.
            </p>

            <div className="characterGrid">
              {characters.map((char) => {
                const selectedIndex = selectedIds.indexOf(char.id);

                return (
                  <button
                    key={char.id}
                    className={`selectCard ${
                      selectedIndex >= 0 ? "selected" : ""
                    }`}
                    onClick={() => toggleCharacter(char.id)}
                  >
                    <span className="selectOrder">
                      {selectedIndex >= 0 ? selectedIndex + 1 : ""}
                    </span>
                    <span className="charEmoji">{char.emoji}</span>
                    <strong>{char.name}</strong>
                    <small>{char.role}</small>
                    <em>{char.skillName}</em>
                  </button>
                );
              })}
            </div>

            <button
              className="primaryButton bottomButton"
              disabled={selectedIds.length !== 2}
              onClick={goReady}
            >
              READY
            </button>
          </div>
        )}

        {phase === "ready" && (
          <div className="screen readyScreen">
            <p className="eyebrow">BATTLE READY</p>
            <h2>{mySide} 진영 출전 준비</h2>

            <div className="versusBox">
              <div>
                <h3>내 팀</h3>
                {selectedTeam.map((char, index) => (
                  <div className="readyChar" key={char.id}>
                    <span>{index + 1}</span>
                    <b>{char.emoji}</b>
                    <div>
                      <strong>{char.name}</strong>
                      <small>{char.skillName}</small>
                    </div>
                  </div>
                ))}
              </div>

              <div className="vsText">VS</div>

              <div>
                <h3>상대 팀</h3>
                {rivalTeam.map((char, index) => (
                  <div className="readyChar opponent" key={char.id}>
                    <span>{index + 1}</span>
                    <b>{char.emoji}</b>
                    <div>
                      <strong>{char.name}</strong>
                      <small>{char.skillName}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="ruleBox">
              <p>상대 접속: {opponentConnected ? "완료" : "대기 중"}</p>
              <p>양쪽 READY: {bothReady ? "완료" : "대기 중"}</p>
              <p>양쪽이 준비되면 물병 돌리기로 선공을 결정해.</p>
            </div>

            <button
              className="primaryButton bottomButton"
              disabled={!opponentConnected}
              onClick={goBottle}
            >
              물병 돌리기로 선공 결정
            </button>
          </div>
        )}

        {phase === "bottle" && (
          <div className="screen bottleScreen">
            <p className="eyebrow">FIRST TURN DECISION</p>
            <h2>물병 돌리기</h2>

            <div className="bottleArena">
              <div className="sideZone left">
                <strong>A 진영</strong>
              </div>

              <div
                className={`bottle ${bottleSpinning ? "spinning" : ""}`}
                style={{
                  transform: `rotate(${bottleAngle}deg)`,
                }}
              >
                <span className="bottleCap" />
                <span className="bottleBody" />
              </div>

              <div className="sideZone right">
                <strong>B 진영</strong>
              </div>
            </div>

            <p className="bottleDesc">물병 뚜껑이 향하는 진영이 선공이야.</p>

            {firstSide && !bottleSpinning && (
              <div className="firstResult">
                <span>선공</span>
                <strong>{firstSide} 진영</strong>
              </div>
            )}

            {!firstSide ? (
              <button className="primaryButton bottomButton" onClick={spinBottle}>
                SPIN BOTTLE
              </button>
            ) : (
              <button className="primaryButton bottomButton" onClick={startBattle}>
                BATTLE START
              </button>
            )}
          </div>
        )}

        {phase === "battle" && (
          <div className="screen battleScreen">
            <div className="battleTop">
              <div className="teamLine">
                {selectedTeam.map((char) => {
                  const glow = canUseSkill(char);
                  const cooldownText = getCooldownText(char.id);
                  const pending = pendingSkill?.charId === char.id;

                  return (
                    <button
                      key={char.id}
                      className={`battleChar ${glow ? "skillReady" : ""} ${
                        pending ? "pending" : ""
                      }`}
                      onClick={() => handleSkillClick(char)}
                    >
                      <span>{char.emoji}</span>
                      <b>{char.name}</b>
                      <small>{cooldownText || char.skillName}</small>
                    </button>
                  );
                })}
              </div>

              <div className="scoreBoard">
                <div>
                  <small>MY SCORE</small>
                  <strong>{myScore}</strong>
                </div>

                <div className="roundInfo">
                  <span>ROUND {roundNumber}</span>
                  <b>{currentTurnSide} 진영 턴</b>
                  <small>
                    {Math.max(0, TURN_DURATION - elapsed).toFixed(1)}s
                  </small>
                </div>

                <div>
                  <small>RIVAL</small>
                  <strong>{rivalScore}</strong>
                </div>
              </div>

              <div className="statusLine">
                <span className={isMyTurn ? "active" : ""}>
                  {isMyTurn ? "내가 플레이" : "상대 플레이 관전"}
                </span>
                <span className={waterActive ? "active" : ""}>물</span>
                <span className={pushActive ? "active" : ""}>반전</span>
                <span className={tauntActive ? "active" : ""}>도발</span>
                <span className={easyActive ? "active" : ""}>이지</span>
                <span className={feverActive ? "active" : ""}>피버</span>
              </div>
            </div>

            <div className="turnProgress">
              <div style={{ width: `${progressPercent}%` }} />
            </div>

            <div
              ref={laneAreaRef}
              className={`laneArea ${lanesFlipped ? "flipped" : ""} ${
                waterActive && isMyTurn ? "watered" : ""
              } ${isSpectating ? "spectating" : ""}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {[0, 1, 2, 3].map((lane) => (
                <div key={lane} className="lane">
                  <span>{lane + 1}</span>
                </div>
              ))}

              <div className="judgeLine">
                <span>판정선</span>
              </div>

              <div className="missZone">
                <span>MISS</span>
              </div>

              <div className="inputButtons" aria-hidden="true">
                {pressedLanes.map((pressed, lane) => (
                  <div
                    key={lane}
                    className={`laneInputButton ${pressed ? "pressed" : ""}`}
                  />
                ))}
              </div>

              {isSpectating && (
                <div className="spectatorOverlay">
                  <strong>상대 플레이 관전 중</strong>
                  <span>방해 스킬만 사용 가능</span>
                </div>
              )}

              {pushActive && (
                <div className="flipTimer">
                  <strong>FLIP {Math.min(pushTimer.count + 1, 3)}/3</strong>
                  <span>다음 반전 {pushTimer.nextIn.toFixed(1)}s</span>
                </div>
              )}

              {holdTransfer && (
                <div className="recatchWarning">
                  <strong>홀드 재터치!</strong>
                  <span>{holdTransfer.requiredLane + 1}번 라인</span>
                </div>
              )}

              {notes.filter(isNoteVisibleInArea).map((note) => {
                const displayLane = getDisplayLane(note.lane);
                const top = getNoteTop(note);
                const waterStyle = getWaterNoteStyle(note);

                if (note.type === "hold") {
                  return (
                    <div
                      key={note.id}
                      className={`note holdNote ${
                        note.holding ? "holding" : ""
                      }`}
                      style={{
                        left: `${displayLane * 25 + 12.5}%`,
                        top: `${top}%`,
                        height: `${Math.max(135, note.duration * 125)}px`,
                        ...waterStyle,
                      }}
                    >
                      <span>HOLD</span>
                    </div>
                  );
                }

                return (
                  <div
                    key={note.id}
                    className="note tapNote"
                    style={{
                      left: `${displayLane * 25 + 12.5}%`,
                      top: `${top}%`,
                      ...waterStyle,
                    }}
                  >
                    TAP
                  </div>
                );
              })}

              {feedback && (
                <div key={feedback.key} className={`feedback ${feedback.kind}`}>
                  {feedback.text}
                </div>
              )}
            </div>

            <div className="battleBottom">
              <div>
                <small>COMBO</small>
                <strong>{combo}</strong>
                <em className="comboMultiplier">
                  {getComboMultiplierLabel(combo)}
                </em>
              </div>

              <p>
                {isMyTurn ? (
                  <>내 턴이야. 피아노타일처럼 직접 눌러.</>
                ) : (
                  <>
                    상대 턴이야. <b>방해기술</b>만 사용 가능.
                  </>
                )}
              </p>
            </div>

            {pendingSkill && (
              <div className="skillWarning">
                <b>{pendingSkill.skillName}</b>
                <span>2초 뒤 발동!</span>
              </div>
            )}
          </div>
        )}

        {phase === "result" && (
          <div className="screen resultScreen">
            <p className="eyebrow">BATTLE RESULT</p>

            <h1>
              {winnerSide === null ? "DRAW" : iWon ? "VICTORY!" : "DEFEAT"}
            </h1>

            <div className="podiumScene">
              <div
                className={`loserSide ${winnerSide === "A" ? "right" : "left"}`}
              >
                <span>😵</span>
                <small>LOSE</small>
              </div>

              <div className="podium">
                <div className="spotlight" />
                <span className="winnerEmoji">🏆</span>
                <strong>{winnerSide ? `${winnerSide} 진영` : "DRAW"}</strong>
                <small>WINNER</small>
              </div>

              <div
                className={`loserSide ${winnerSide === "B" ? "left" : "right"}`}
              >
                <span>😞</span>
                <small>LOSE</small>
              </div>
            </div>

            <div className="finalScore">
              <div>
                <small>A SCORE</small>
                <strong>{scoreA}</strong>
              </div>
              <div>
                <small>B SCORE</small>
                <strong>{scoreB}</strong>
              </div>
            </div>

            <button className="primaryButton" onClick={() => setPhase("select")}>
              다시 선택하기
            </button>

            <button className="ghostButton" onClick={() => setPhase("start")}>
              처음으로
            </button>
          </div>
        )}
      </section>
    </main>
  );
}