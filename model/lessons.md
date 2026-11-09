# FPL agent lessons

Read before every deadline decision.

## Automated findings

Regenerated after every review from reports/reviews/.

- Season to date over 2 reviewed gameweek(s): lineup regret 18, captain regret 9, bench points unused 29, transfers net +22.0, minutes-miss cost 0.0.
- Departures from the model: 1, net +3.0 points. A persistent negative total means judgement overrides are costing points and the bar for overriding should rise; a positive total means the news layer is adding value.
- 10+ points left on the bench in 2 of the last 2 gameweeks. Bench spend may be too high, or the XI selection is not trusting bench players who are starting.
- Calibration in force: none (identity); minutes mapping none; ep_next blend 0.2. Learning starts once 3 gameweeks are reviewed.

## Reflections

Written by the deadline agent after each review, newest first. Each entry names what went wrong in its own judgement, the evidence, and the rule it will apply from now on. Rules here are advisory to the judgement layer; they do not change model code.

### GW9 reflection (4 November 2026)

Result: 44 against 60.7 projected for the side fielded (minus 1.3 standard deviations, plausibly variance); overall rank 2,814,721 to 3,185,415.

Judgement layer: no departures from the model. Both transfers were the model's plan and returned +9 net. The armband went to Haaland, the highest armband value at the deadline (7.7); he blanked while Barry scored 9. The no-hit call followed the threshold (best free plan 291.3 against best hit plan 290.4). Bench order was the model's. The one news call, keeping Gabriel through a reported knock with no FPL flag and predicted line-ups still starting him, was correct: 90 minutes, 6 points.

Evidence: the shortfall came from blanks across projected starters (Haaland, Mbeumo, Tavernier, Gross) and Verbruggen's 11 on the bench. Nothing reported before the deadline pointed to these outcomes. The goalkeeper choice (Kinsky 4.1 over Verbruggen 3.8) was a near coin-flip that went the other way in GW8 (Kinsky 9 on the bench); the reserve goalkeeper accounts for 20 of the 29 bench points unused over GW8 and GW9, so the bench finding reflects two near-equal goalkeepers rather than excess outfield bench spend.

No rule change: variance. Watch: revisit bench spend only if 10+ outfield bench points persist over four gameweeks. The backtest showed the recommended XI over-projecting materially over GW8 and GW9, so close calls warrant extra caution until calibration starts.
