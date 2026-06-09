import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import type { User } from "@supabase/supabase-js";
import "./App.css";

type PlayerProfile = {
  id: string;
  nickname: string;
  level: number;
  exp: number;
  wins: number;
  losses: number;
  avatar_url: string | null;
  created_at?: string;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [playerProfile, setPlayerProfile] = useState<PlayerProfile | null>(
    null
  );
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [message, setMessage] = useState("");

  const loadPlayerProfile = async (loginUser: User) => {
    setProfileLoading(true);
    setMessage("");

    const { data, error } = await supabase
      .from("player_profiles")
      .select("*")
      .eq("id", loginUser.id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("프로필 불러오기 실패:", error.message);
      setMessage("프로필 불러오기 실패: " + error.message);
      setProfileLoading(false);
      return;
    }

    if (data) {
      setPlayerProfile(data);
      setProfileLoading(false);
      return;
    }

    const nickname =
      loginUser.user_metadata?.full_name ||
      loginUser.user_metadata?.name ||
      loginUser.email?.split("@")[0] ||
      "Riser";

    const avatarUrl =
      loginUser.user_metadata?.avatar_url ||
      loginUser.user_metadata?.picture ||
      null;

    const { data: newProfile, error: insertError } = await supabase
      .from("player_profiles")
      .insert({
        id: loginUser.id,
        nickname,
        level: 1,
        exp: 0,
        wins: 0,
        losses: 0,
        avatar_url: avatarUrl,
      })
      .select()
      .single();

    if (insertError) {
      console.error("프로필 생성 실패:", insertError.message);
      setMessage("프로필 생성 실패: " + insertError.message);
      setProfileLoading(false);
      return;
    }

    setPlayerProfile(newProfile);
    setProfileLoading(false);
  };

  useEffect(() => {
    const initAuth = async () => {
      setAuthLoading(true);

      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("세션 확인 실패:", error.message);
        setMessage("세션 확인 실패: " + error.message);
        setAuthLoading(false);
        return;
      }

      const currentUser = data.session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        await loadPlayerProfile(currentUser);
      }

      setAuthLoading(false);
    };

    initAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        await loadPlayerProfile(currentUser);
      } else {
        setPlayerProfile(null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const loginWithGoogle = async () => {
    setMessage("");

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) {
      console.error("Google 로그인 실패:", error.message);
      setMessage("Google 로그인 실패: " + error.message);
    }
  };

  const logout = async () => {
    setMessage("");

    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("로그아웃 실패:", error.message);
      setMessage("로그아웃 실패: " + error.message);
      return;
    }

    setUser(null);
    setPlayerProfile(null);
  };

  const addTestExp = async () => {
    if (!user || !playerProfile) return;

    const nextExp = playerProfile.exp + 30;
    const nextLevel = nextExp >= playerProfile.level * 100 ? playerProfile.level + 1 : playerProfile.level;
    const finalExp = nextExp >= playerProfile.level * 100 ? 0 : nextExp;

    const { data, error } = await supabase
      .from("player_profiles")
      .update({
        exp: finalExp,
        level: nextLevel,
      })
      .eq("id", user.id)
      .select()
      .single();

    if (error) {
      console.error("EXP 저장 실패:", error.message);
      setMessage("EXP 저장 실패: " + error.message);
      return;
    }

    setPlayerProfile(data);
    setMessage("테스트 EXP가 저장됐어.");
  };

  const addTestWin = async () => {
    if (!user || !playerProfile) return;

    const { data, error } = await supabase
      .from("player_profiles")
      .update({
        wins: playerProfile.wins + 1,
        exp: playerProfile.exp + 50,
      })
      .eq("id", user.id)
      .select()
      .single();

    if (error) {
      console.error("승리 기록 저장 실패:", error.message);
      setMessage("승리 기록 저장 실패: " + error.message);
      return;
    }

    setPlayerProfile(data);
    setMessage("테스트 승리 기록이 저장됐어.");
  };

  return (
    <main className="app">
      <section className="phone-frame">
        <div className="top-glow" />

        <header className="top-bar">
          <div className="brand-box">
            <div className="app-icon">BR</div>
            <div>
              <h1>Beat Rise</h1>
              <p>Online Rhythm Battle</p>
            </div>
          </div>

          {authLoading ? (
            <button className="small-btn" disabled>
              확인 중
            </button>
          ) : user ? (
            <button className="small-btn" onClick={logout}>
              로그아웃
            </button>
          ) : (
            <button className="small-btn" onClick={loginWithGoogle}>
              Google 로그인
            </button>
          )}
        </header>

        <section className="profile-card">
          {authLoading || profileLoading ? (
            <div className="loading-box">로그인 정보를 확인하는 중...</div>
          ) : user && playerProfile ? (
            <>
              <div className="profile-main">
                <img
                  className="profile-avatar"
                  src={
                    playerProfile.avatar_url ||
                    "https://api.dicebear.com/7.x/adventurer/svg?seed=Riser"
                  }
                  alt="profile"
                />

                <div className="profile-info">
                  <strong>{playerProfile.nickname}</strong>
                  <span>{user.email}</span>

                  <div className="exp-line">
                    <div
                      className="exp-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          (playerProfile.exp /
                            Math.max(100, playerProfile.level * 100)) *
                            100
                        )}%`,
                      }}
                    />
                  </div>

                  <small>
                    Lv.{playerProfile.level} / EXP {playerProfile.exp}
                  </small>
                </div>
              </div>

              <div className="record-grid">
                <div>
                  <strong>{playerProfile.wins}</strong>
                  <span>승리</span>
                </div>
                <div>
                  <strong>{playerProfile.losses}</strong>
                  <span>패배</span>
                </div>
                <div>
                  <strong>
                    {playerProfile.wins + playerProfile.losses === 0
                      ? "0%"
                      : `${Math.round(
                          (playerProfile.wins /
                            (playerProfile.wins + playerProfile.losses)) *
                            100
                        )}%`}
                  </strong>
                  <span>승률</span>
                </div>
              </div>

              <div className="test-buttons">
                <button onClick={addTestExp}>EXP 테스트 저장</button>
                <button onClick={addTestWin}>승리 테스트 저장</button>
              </div>
            </>
          ) : (
            <div className="login-panel">
              <h2>라이저 계정 연결</h2>
              <p>
                Google로 로그인하면 레벨, 경험치, 승패 기록을 Supabase에 저장할
                수 있어.
              </p>
              <button className="google-btn" onClick={loginWithGoogle}>
                Google로 시작하기
              </button>
            </div>
          )}
        </section>

        <section className="menu-area">
          <button className="main-menu active">배틀</button>
          <button className="main-menu">오디션</button>
          <button className="main-menu">스케줄</button>
          <button className="main-menu">이벤트</button>
        </section>

        <section className="battle-card">
          <h2>Battle Room</h2>
          <p>다음 단계에서 기존 방코드/캐릭터 선택/배틀 코드랑 합치면 돼.</p>

          <div className="room-box">
            <input placeholder="방 코드 입력" />
            <button>입장</button>
          </div>

          <button className="ai-btn">AI 배틀</button>
        </section>

        {message && <div className="message-box">{message}</div>}

        <nav className="bottom-nav">
          <button>댄서</button>
          <button>트레이닝</button>
          <button className="selected">홈</button>
          <button>인벤토리</button>
          <button>상점</button>
        </nav>
      </section>
    </main>
  );
}
