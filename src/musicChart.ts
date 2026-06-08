function generateNotesFromMusicChart(turnIndex: number) {
  const globalStart = turnIndex * TURN_DURATION;
  const globalEnd = globalStart + TURN_DURATION;

  const chartNotes = (MUSIC_CHART as MusicChartNote[])
    .filter(
      (chartNote) =>
        chartNote.time >= globalStart + 0.8 &&
        chartNote.time < globalEnd - 0.6
    )
    .map((chartNote, index) => ({
      id: `turn-${turnIndex}-chart-${index}-${chartNote.type}`,
      type: chartNote.type,
      lane: clamp(chartNote.lane, 0, LANE_COUNT - 1),
      targetTime: chartNote.time - globalStart,
      duration: chartNote.type === "hold" ? chartNote.duration ?? 1.1 : 0,
      judged: false,
    }));

  const filledNotes = [...chartNotes];

  let cursor = 1.1;
  let laneSeed = turnIndex;

  while (cursor <= TURN_DURATION - 0.9) {
    const hasNearbyNote = filledNotes.some(
      (note) => Math.abs(note.targetTime - cursor) < 0.55
    );

    if (!hasNearbyNote) {
      const lane = laneSeed % LANE_COUNT;

      filledNotes.push({
        id: `turn-${turnIndex}-fill-${cursor.toFixed(2)}-${lane}`,
        type: "tap",
        lane,
        targetTime: cursor,
        duration: 0,
        judged: false,
      });

      laneSeed += 1;
    }

    cursor += 0.78;
  }

  return filledNotes.sort((a, b) => a.targetTime - b.targetTime);
}
