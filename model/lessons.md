# FPL agent lessons

Read before every deadline decision.

## Automated findings

Regenerated after every review from reports/reviews/.

- Season to date over 3 reviewed gameweek(s): lineup regret 18, captain regret 17, bench points unused 35, transfers net +14.0, minutes-miss cost 0.0.
- Departures from the model: 2, net -3.0 points. A persistent negative total means judgement overrides are costing points and the bar for overriding should rise; a positive total means the news layer is adding value.
- 10+ points left on the bench in 2 of the last 3 gameweeks. Bench spend may be too high, or the XI selection is not trusting bench players who are starting.
- Mbeumo blanked (60+ minutes, 2 or fewer points, projected 4.5+) in 3 of the last 3 gameweeks. The projection may be living on reputation; check underlying numbers before keeping or captaining.
- Calibration in force: GK a 0.03 b 1, DEF a 0.1 b 0.99, MID a 0.2 b 0.92, FWD a 0.05 b 1; minutes mapping active; ep_next blend 0.16. 

## Reflections

Written by the deadline agent after each review, newest first. Each entry names what went wrong in its own judgement, the evidence, and the rule it will apply from now on. Rules here are advisory to the judgement layer; they do not change model code.

### GW10 reflection (10 November 2026)

Result: 83 less a 4-point hit (79 net) against 65.4 projected for the side fielded (plus 1.4 standard deviations, plausibly variance); overall rank 3,185,415 to 2,184,887; Mane League 32nd to 25th, top score in the league this week.

Judgement layer: the plan (B.Fernandes to Rogers, Thomas to Van Hecke, one -4) was the model's best plan within one hit, executed early from the DRAFT run on price pressure (Fernandes fall, Van Hecke rise). The hit cleared the threshold (295.8 against 292.6 best no-hit, confirmed at 295.7 against 292.1 in the FINAL report). The recorded departure (-6) is the one-hit cap, not a news override: the model's top plan needed two hits (adding Calvert-Lewin to Isak). Net of the second hit that plan would have scored about 81, two points more than the 79 achieved, which is within noise. Captaincy followed the armband arithmetic: Gabriel 6.8 against Haaland 6.0; Gabriel returned 8 with the armband, Haaland 2. Barry's 16 (projected 5.0) was not a foreseeable armband choice. Bench order was the model's and left 6 points, all from low-scoring reserves.

Evidence: the transfer loss (-8) is Fernandes scoring 10 after his sale against Rogers' 2; Fernandes was projected 3.5 with an 86% start chance and nothing reported before the deadline pointed to a haul. Thomas (calf) did not play, so that sale was correct. Mbeumo has now blanked in three successive gameweeks; the new MID calibration (b 0.92) addresses part of that and it remains an automated watch item, not a rule.

No rule change: decisions were sound and the swing was variance. Watch: the one-hit cap has now cost about 2 net points once; revisit only if two-hit plans keep beating the capped plan over several gameweeks. Check Mbeumo's underlying numbers before keeping or captaining him in GW11.

### GW9 reflection (4 November 2026)

Result: 44 against 60.7 projected for the side fielded (minus 1.3 standard deviations, plausibly variance); overall rank 2,814,721 to 3,185,415.

Judgement layer: no departures from the model. Both transfers were the model's plan and returned +9 net. The armband went to Haaland, the highest armband value at the deadline (7.7); he blanked while Barry scored 9. The no-hit call followed the threshold (best free plan 291.3 against best hit plan 290.4). Bench order was the model's. The one news call, keeping Gabriel through a reported knock with no FPL flag and predicted line-ups still starting him, was correct: 90 minutes, 6 points.

Evidence: the shortfall came from blanks across projected starters (Haaland, Mbeumo, Tavernier, Gross) and Verbruggen's 11 on the bench. Nothing reported before the deadline pointed to these outcomes. The goalkeeper choice (Kinsky 4.1 over Verbruggen 3.8) was a near coin-flip that went the other way in GW8 (Kinsky 9 on the bench); the reserve goalkeeper accounts for 20 of the 29 bench points unused over GW8 and GW9, so the bench finding reflects two near-equal goalkeepers rather than excess outfield bench spend.

No rule change: variance. Watch: revisit bench spend only if 10+ outfield bench points persist over four gameweeks. The backtest showed the recommended XI over-projecting materially over GW8 and GW9, so close calls warrant extra caution until calibration starts.
