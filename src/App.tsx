import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, PointerEvent } from "react";
import { socket, type ServerRoomState } from "./socket";
import { MUSIC_CHART } from "./musicChart";
import "./App.css";

type Phase =
  | "home"
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

type MusicChartNote = {
  time: number;
  lane: number;
  type: NoteType;
  duration?: number;
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
  title: string;
  sub?: string;
  kind: "perfect" | "good" | "miss" | "skill";
  key: number;
};

type HoldTransfer = {
  noteId: string;
  requiredLane: number;
  until: number;
};

type FinalScores = {
  A: number;
  B: number;
};

const TURN_DURATION = 30;
const TOTAL_TURNS = 4;
const LANE_COUNT = 4;

const FALL_DURATION = 2.35;
const NOTE_START_TOP = -12;
const JUDGE_LINE_TOP = 82;

const PERFECT_WINDOW = 0.11;
const GOOD_WINDOW = 0.28;
const EASY_GOOD_WINDOW = 0.36;
const MISS_AFTER_LINE = 0.36;

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

const TOTAL_BATTLE_DURATION = 120;
const MUSIC_URL = "/audio/battle.mp3";

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
    desc: "3초마다 좌우반전.",
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
    desc: "조작감 개선 후 다시 적용 예정.",
  },
  {
    id: "kai",
    name: "카이",
    emoji: "🔥",
    role: "버프 / 폭발",
    skillName: "피버타임",
    skillTarget: "own",
    costRatio: 0,
    desc: "10초간 점수 2배.",
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function otherSide(side: Side): Side {
  return side === "A" ? "B" : "A";
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

function generateNotesFromMusicChart(turnIndex: number) {
  const globalStart = turnIndex * TURN_DURATION;
  const globalEnd = globalStart + TURN_DURATION;

  const chartNotes: BattleNote[] = (MUSIC_CHART as MusicChartNote[])
    .filter(
      (chartNote) =>
        chartNote.time >= globalStart + 0.75 &&
        chartNote.time <= globalEnd - 0.55
    )
    .map((chartNote) => {
      const localTime = Number((chartNote.time - globalStart).toFixed(3));
      const lane = clamp(chartNote.lane, 0, LANE_COUNT - 1);

      const variedHoldDuration =
        chartNote.type === "hold"
          ? chartNote.duration ??
            [0.85, 1.25, 1.75, 2.35][
              (Math.floor(localTime * 10) + turnIndex) % 4
            ]
          : 0;

      return {
        id: `turn-${turnIndex}-chart-${localTime.toFixed(3)}-${lane}-${
          chartNote.type
        }`,
        type: chartNote.type,
        lane,
        targetTime: localTime,
        duration: variedHoldDuration,
        judged: false,
      };
    });

  const filledNotes: BattleNote[] = [...chartNotes];

  function hasNearbyNote(time: number) {
    return filledNotes.some((note) => Math.abs(note.targetTime - time) < 0.34);
  }

  function hasLaneConflict(lane: number, time: number) {
    return filledNotes.some((note) => {
      if (note.lane !== lane) return false;

      const start = note.targetTime;
      const end =
        note.type === "hold" ? note.targetTime + note.duration : note.targetTime;

      return time >= start - 0.38 && time <= end + 0.38;
    });
  }

  function pickDeterministicLane(time: number) {
    const base = Math.floor(time * 100) + turnIndex * 7;

    const laneOrder = [
      base % LANE_COUNT,
      (base + 2) % LANE_COUNT,
      (base + 1) % LANE_COUNT,
      (base + 3) % LANE_COUNT,
    ];

    return (
      laneOrder.find((candidateLane) => !hasLaneConflict(candidateLane, time)) ??
      laneOrder[0]
    );
  }

  let cursor = 1.0;

  while (cursor <= TURN_DURATION - 0.75) {
    const time = Number(cursor.toFixed(3));

    if (!hasNearbyNote(time)) {
      const lane = pickDeterministicLane(time);

      const shouldMakeHold =
        time > 3 &&
        time < TURN_DURATION - 4 &&
        (Math.floor(time * 100) + turnIndex * 13) % 17 === 0;

      const holdDuration =
        [0.85, 1.35, 2.25][(Math.floor(time * 10) + turnIndex) % 3];

      filledNotes.push({
        id: `turn-${turnIndex}-fill-${time.toFixed(3)}-${lane}`,
        type: shouldMakeHold ? "hold" : "tap",
        lane,
        targetTime: time,
        duration: shouldMakeHold ? holdDuration : 0,
        judged: false,
      });
    }

    cursor += 0.58;
  }

  const endFillTimes = [26.8, 27.5, 28.2, 28.9, 29.35];

  for (const endTime of endFillTimes) {
    const time = Number(endTime.toFixed(3));

    if (!hasNearbyNote(time)) {
      const lane = pickDeterministicLane(time);

      filledNotes.push({
        id: `turn-${turnIndex}-endfill-${time.toFixed(3)}-${lane}`,
        type: "tap",
        lane,
        targetTime: time,
        duration: 0,
        judged: false,
      });
    }
  }

  return filledNotes.sort((a, b) => {
    if (a.targetTime !== b.targetTime) return a.targetTime - b.targetTime;
    return a.lane - b.lane;
  });
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("home");
  const [roomCode, setRoomCode] = useState("");
  const [mySide, setMySide] = useState<Side>("A");
  const [serverRoom, setServerRoom] = useState<ServerRoomState | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [joined, setJoined] = useState(false);

  const [profileOpen, setProfileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [turntableAngle, setTurntableAngle] = useState(0);

  const [nickname, setNickname] = useState(() => {
    return localStorage.getItem("beatRiseNickname") || "Danzy";
  });

  const [profileImage, setProfileImage] = useState(() => {
    return localStorage.getItem("beatRiseProfileImage") || "";
  });

  const [playerStats] = useState({
    level: 12,
    rank: "B-BOY SILVER",
    exp: 68,
    following: 128,
    followers: 940,
    recent: "3승 2패",
    winRate: 62,
  });

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
  const [finalScores, setFinalScores] = useState<FinalScores | null>(null);
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
  const scoreARef = useRef(0);
  const scoreBRef = useRef(0);

  const currentElapsedRef = useRef(0);
  const currentTurnSideRef = useRef<Side>("A");
  const activeEffectsRef = useRef(activeEffects);
  const mySideRef = useRef<Side>("A");
  const holdingNoteIdRef = useRef<string | null>(null);
  const activePointerLanesRef = useRef<Map<number, number>>(new Map());
  const holdPointerNoteIdsRef = useRef<Map<number, string>>(new Map());
  const lastFlipCountRef = useRef(0);
  const advancingRef = useRef(false);

  const musicRef = useRef<HTMLAudioElement | null>(null);

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
        scoreARef.current = state.scores.A;
        scoreBRef.current = state.scores.B;

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
      const firstNotes = generateNotesFromMusicChart(turnIndex);

      scoreARef.current = 0;
      scoreBRef.current = 0;

      setFirstSide(firstSide);
      resetTurnStateOnly();
      setTurnIndex(turnIndex);
      setTurnStartMs(performance.now() - Math.max(0, Date.now() - startedAt));
      setElapsed(0);
      setScoreA(0);
      setScoreB(0);
      setFinalScores(null);
      setCooldowns({});
      setPendingSkill(null);
      setNotesSafe(firstNotes);
      setPhase("battle");
      playBattleMusic(turnIndex * TURN_DURATION);
    });

    socket.on("turnChanged", ({ turnIndex, startedAt }) => {
      const nextNotes = generateNotesFromMusicChart(turnIndex);

      resetTurnStateOnly();
      setTurnIndex(turnIndex);
      setElapsed(0);
      setNotesSafe(nextNotes);
      setTurnStartMs(performance.now() - Math.max(0, Date.now() - startedAt));
      playBattleMusic(turnIndex * TURN_DURATION);
    });

    socket.on("noteResult", (payload) => {
      scoreARef.current = payload.scores.A;
      scoreBRef.current = payload.scores.B;

      setScoreA(payload.scores.A);
      setScoreB(payload.scores.B);

      if (payload.side !== mySideRef.current) {
        markRemoteNoteJudged(payload.noteId);

        if (payload.rating === "MISS" || payload.rating === "TAUNT MISS") {
          showFeedback(payload.rating, "miss", "combo break");
        } else {
          showFeedback(
            payload.rating,
            payload.rating === "PERFECT" ? "perfect" : "good",
            `${payload.combo}combo ${getComboMultiplierLabel(payload.combo)}`
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
  }, []);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    activeEffectsRef.current = activeEffects;
  }, [activeEffects]);

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
    scoreARef.current = scoreA;
  }, [scoreA]);

  useEffect(() => {
    scoreBRef.current = scoreB;
  }, [scoreB]);

  function saveNickname(nextName: string) {
    setNickname(nextName);
    localStorage.setItem("beatRiseNickname", nextName);
  }

  function handleProfileImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      setProfileImage(result);
      localStorage.setItem("beatRiseProfileImage", result);
    };

    reader.readAsDataURL(file);
  }

  function spinTurntable() {
    setTurntableAngle((prev) => prev + 120);
  }

  function openBattleFromHome() {
    goRoom();
  }

  function fakeGoogleLogin() {
    localStorage.setItem("beatRiseLogin", "google-demo");
    alert(
      "지금은 테스트 로그인 UI야. 실제 구글 로그인은 Firebase 연결 후 적용 가능해."
    );
  }

  function playBattleMusic(globalStartSec: number) {
    const audio = musicRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = clamp(globalStartSec, 0, TOTAL_BATTLE_DURATION);
    audio.volume = 0.75;

    audio.play().catch(() => {
      showFeedback("음악 재생 대기", "skill", "화면을 한 번 터치해줘");
    });
  }

  function stopBattleMusic() {
    const audio = musicRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
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

  function showFeedback(
    title: string,
    kind: Feedback["kind"],
    sub?: string
  ) {
    setFeedback({
      title,
      sub,
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
      const next = Math.max(
        0,
        scoreARef.current - Math.floor(scoreARef.current * costRatio)
      );

      scoreARef.current = next;
      setScoreA(next);
    } else {
      const next = Math.max(
        0,
        scoreBRef.current - Math.floor(scoreBRef.current * costRatio)
      );

      scoreBRef.current = next;
      setScoreB(next);
    }
  }

  function breakComboByMiss(text: Rating = "MISS") {
    setCombo(0);
    comboRef.current = 0;

    setActiveEffects((prev) => ({
      ...prev,
      feverUntil: 0,
    }));

    showFeedback(text, "miss", "combo break");
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
      scoreARef.current += scoreDelta;
      setScoreA(scoreARef.current);
    } else {
      scoreBRef.current += scoreDelta;
      setScoreB(scoreBRef.current);
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
      rating,
      rating === "PERFECT" ? "perfect" : "good",
      `${nextCombo}combo ${getComboMultiplierLabel(nextCombo)}`
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
      rating === "PERFECT" ? "PERFECT HOLD" : "GOOD HOLD",
      rating === "PERFECT" ? "perfect" : "good",
      `${nextCombo}combo ${getComboMultiplierLabel(nextCombo)}`
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
      showFeedback("상대 턴", "skill", "스킬로 방해 가능");
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
        showFeedback(
          "HOLD END",
          rating === "PERFECT" ? "perfect" : "good",
          `${comboRef.current}combo ${getComboMultiplierLabel(comboRef.current)}`
        );
      } else {
        showFeedback(
          "HOLD RELEASE",
          rating === "PERFECT" ? "perfect" : "good",
          `${comboRef.current}combo ${getComboMultiplierLabel(comboRef.current)}`
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
                rating === "PERFECT" ? "perfect" : "good",
                `${comboRef.current}combo ${getComboMultiplierLabel(
                  comboRef.current
                )}`
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
    showFeedback("FLIP!", "skill", "RECATCH");
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
      const final = {
        A: scoreARef.current,
        B: scoreBRef.current,
      };

      setFinalScores(final);
      resetTurnStateOnly();
      stopBattleMusic();
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
      targetSide === mySideRef.current ||
      targetSide === currentTurnSideRef.current;

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
      showFeedback("이지모드 준비중", "skill", "조작감 개선 후 적용");
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
    if (char.id === "luna") return false;

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
    showFeedback("2초 뒤 발동", "skill", char.skillName);

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

  const resultScoreA = finalScores?.A ?? scoreA;
  const resultScoreB = finalScores?.B ?? scoreB;

  const winnerSide: Side | null =
    resultScoreA === resultScoreB
      ? null
      : resultScoreA > resultScoreB
        ? "A"
        : "B";

  const iWon = winnerSide === mySide;

  const opponentConnected = (serverRoom?.players.length ?? 0) >= 2;
  const bothReady =
    serverRoom?.players.length === 2 &&
    serverRoom.players.every((player) => player.ready);

  return (
    <main className="app">
      <audio ref={musicRef} src={MUSIC_URL} preload="auto" />

      <section className="phone">
        {phase === "home" && (
          <div className="screen homeScreen">
            <div className="homeTopProfile" onClick={() => setProfileOpen(true)}>
              <div className="profileAvatar">
                {profileImage ? <img src={profileImage} alt="profile" /> : "D"}
              </div>

              <div className="profileInfo">
                <strong>{nickname}</strong>
                <span>
                  Lv.{playerStats.level} · {playerStats.rank}
                </span>

                <div className="expBar">
                  <div style={{ width: `${playerStats.exp}%` }} />
                </div>
              </div>
            </div>

            <div className="homeSideButtons">
              <button onClick={() => setMenuOpen(true)}>☰</button>
              <button>🎯</button>
              <button>👥</button>
              <button>✉️</button>
            </div>

            <div className="turntableWrap">
              <button className="turntableSpinButton" onClick={spinTurntable}>
                돌리기
              </button>

              <div
                className="turntable"
                style={{
                  transform: `rotate(${turntableAngle}deg)`,
                }}
              >
                <button
                  className="turntableSlice battleSlice"
                  onClick={openBattleFromHome}
                >
                  <span>배틀</span>
                </button>

                <button className="turntableSlice eventSlice">
                  <span>이벤트</span>
                </button>

                <button className="turntableSlice auditionSlice">
                  <span>오디션</span>
                </button>

                <div className="turntableCenter">
                  <b>BR</b>
                </div>
              </div>
            </div>

            <div className="homeBottomNav">
              <button>댄서</button>
              <button>인벤토리</button>
              <button className="active">홈</button>
              <button>상점</button>
              <button>스케줄</button>
            </div>

            {profileOpen && (
              <div className="modalBackdrop" onClick={() => setProfileOpen(false)}>
                <div className="profileModal" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="modalClose"
                    onClick={() => setProfileOpen(false)}
                  >
                    ×
                  </button>

                  <h2>프로필</h2>

                  <div className="profileEditAvatar">
                    <div className="bigAvatar">
                      {profileImage ? (
                        <img src={profileImage} alt="profile" />
                      ) : (
                        "D"
                      )}
                    </div>

                    <label className="imageUploadButton">
                      사진 변경
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleProfileImageChange}
                      />
                    </label>
                  </div>

                  <label className="profileEditLabel">
                    닉네임
                    <input
                      value={nickname}
                      onChange={(e) => saveNickname(e.target.value)}
                    />
                  </label>

                  <div className="followStats">
                    <div>
                      <strong>{playerStats.following}</strong>
                      <span>팔로우</span>
                    </div>
                    <div>
                      <strong>{playerStats.followers}</strong>
                      <span>팔로워</span>
                    </div>
                  </div>

                  <div className="recordBox">
                    <div>
                      <span>최근 전적</span>
                      <strong>{playerStats.recent}</strong>
                    </div>
                    <div>
                      <span>승률</span>
                      <strong>{playerStats.winRate}%</strong>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {menuOpen && (
              <div className="modalBackdrop" onClick={() => setMenuOpen(false)}>
                <div className="menuModal" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="modalClose"
                    onClick={() => setMenuOpen(false)}
                  >
                    ×
                  </button>

                  <h2>메뉴</h2>
                  <p>계정에 로그인하면 플레이 기록을 저장할 수 있어.</p>

                  <button className="googleLoginButton" onClick={fakeGoogleLogin}>
                    Google 로그인
                  </button>

                  <small>
                    현재는 테스트 로그인 UI야. 실제 구글 로그인은 Firebase 연결 후
                    완성 가능.
                  </small>
                </div>
              </div>
            )}
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
                <div
                  key={lane}
                  className={`lane ${pressedLanes[lane] ? "pressed" : ""}`}
                >
                  <div className="laneFullGlow" />
                </div>
              ))}

              <div className="judgeLine" />
              <div className="missZone" />

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
                    />
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
                  />
                );
              })}

              {feedback && (
                <div key={feedback.key} className={`feedback ${feedback.kind}`}>
                  <strong>{feedback.title}</strong>
                  {feedback.sub && <span>{feedback.sub}</span>}
                </div>
              )}
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
                <strong>{resultScoreA}</strong>
              </div>
              <div>
                <small>B SCORE</small>
                <strong>{resultScoreB}</strong>
              </div>
            </div>

            <button className="primaryButton" onClick={() => setPhase("select")}>
              다시 선택하기
            </button>

            <button className="ghostButton" onClick={() => setPhase("home")}>
              홈으로
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
