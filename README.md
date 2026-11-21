# Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/abtravels/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/abtravels/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, written for the
[make.fun sokoban-solver-01-run-20261121 bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).
It reads every level under `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` — the player's moves in LURD letters
(`u`/`d`/`l`/`r`, upper case for pushes).

## How it works

Every level the generator draws is a hallway with one to four rooms off
it, and a box pushed out of a room is lost for good, so each room is its
own problem: a level's push-optimal count is the sum of its rooms'
optima. The solver

1. **cuts the level into rooms** — the dead squares of the player's row
   (the hallway: a box there reaches no goal) come out of the floor, and
   each part left that holds a box is a room;
2. **solves each room on its own** with a push-optimal A* over box
   configurations, the player tracked by flood-fill reachability. The
   estimate is the cheapest assignment of boxes to goals, where one
   box's cost is the fewest pushes it needs alone, so the estimate never
   overshoots and the first solved state taken off the open list is
   push-optimal. Two deadlocks are pruned, both safe: a box on a square
   no lone push can ever leave toward a goal, and a frozen 2×2 block of
   walls and boxes holding a box off its goal;
3. **stitches the rooms together** with the player's walks between
   doors, other rooms' boxes treated as walls until their turn comes.

The budget is work, never the clock: a fixed number of expansions for
the whole run, split across rooms and across three phases per room
(plain A*, then a weighted A*, then a breadth-first search), so two
executions write the same bytes. No randomness, no clock, no network.

## Results

| Set | Score |
| --- | --- |
| Practice set (kit) | **1,000,000 / 1,000,000** — all 5 instances at exactly P\* (13, 16, 29, 47, 60 pushes), reproduced byte-for-byte |
| House baseline plain-astar 1.0.0, same set | 200,000 (only the first instance solved) |
| 10 fresh generator-drawn sets | 1,000,000 on every one, all instances at exactly P\*, ~0.25 s wall each |

Original work, written for this competition — no solver code was copied.
