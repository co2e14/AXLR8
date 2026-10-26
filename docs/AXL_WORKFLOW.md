# AXL workflow: what the simulator models

Source: `axlworkflow.pptx` (3 slides: route flowchart, daily schedule, device list).
This document records how the deck was read and every assumption made where it is silent.
Values marked **assumed** are shown as such in the app so they can be replaced with measured ones.

## 1. Model changes versus the first version

The first version modelled one linear line. The AXL workflow needs:

| Need (from the deck) | Model feature |
|---|---|
| Many routes (reagents, source plates, crystal plates, compound plates, soaking, pins, plates, seed tubes) sharing the same devices | **Routes** that each reference shared **devices** |
| "(2of)", "(6of)": several units of one device type | Device **units**, each with the **phase** it arrives in |
| "Mosquito Xtal3 / Mosquito LCP" stacked; "Arktik / DFSA" stacked | A step may name **alternative devices** |
| Schedule pins workflow 1 to Peeler 1, Echo 1, X-ACT 1/3/5 | A step may restrict which **units** it uses |
| Convergence points (yellow): crystal plate + source plate meet at the Mosquito; crystal plate + compound plate meet at the Echo | **Joins**: two routes rendezvous at a step and share one device run |
| "batch mode" arrow Mosquito → XL200 LiHa; compound plate peeled/dispensed/resealed for every soak | **Loops** over a block of steps |
| After X-ACT a plate yields pins, the plate itself, seed tubes | **Spawn**: a step can start items on other routes |
| Incubation inside the SpectroQ (orange, project-specific) | **Dwell** time after a step that does not hold the device |
| Grey boxes "optional: for leftover reagents", `*` steps | **Optional** steps that can be switched on/off |
| Green MAP boxes: manual access points | Manual transport (no cobot) |
| Linked devices (BenchCel + labeller; SpectroQ imaging → incubation → imaging) | Linked transport (no cobot, no move time) |
| Soaking (blue) during runs, seed stock (red) during shutdowns, crystallisation (pink) always | **Scenarios**: *Run day* / *Shutdown day* |
| Phases 1–4 of purchases (slide 3) | **Phase** selector: only units bought by that phase exist |

## 2. Devices (slide 3)

Units are listed with the phase each arrives in. Times are "Max Active Device Time" from slide 3.

| Device | Units (phase) | Time per use | Notes |
|---|---|---|---|
| XPEEL plate peeler | 1 (P1), 1 (P4) | 18 s | |
| VSpin centrifuge | 1 (P1), 1 (P4) | 2 min | |
| PlateLoc foil sealer (compound plates) | 1 (P1), 1 (P4) | 8 s | slide 3 line 24 says qty 2 for "2 of 2"; flowchart says 2 in total → **2 total** |
| A4S clear sealer (crystal plates) | 1 (P2), 1 (P4) | 10 s | Flowchart "Sealer (2of)" read as A4S |
| X-ACT crystal harvester | 1 (P2), 2 (P3), 3 (P4) | 41 min | |
| Mosquito LCP | 1 (P2) | 5 min | |
| Mosquito Xtal3 | 1 (P4) | 5 min | |
| SpectroQ (STX-500, STX-200, STX-1000) | 1 (P2), 2 (P4) | 25 s per access | storage + imaging |
| BenchCel plate supply | 1 (P2) | 20 s | |
| Plate labeller | 1 (P2) | **assumed 10 s** | blank in deck |
| DC2SA compound storage | 1 (P2) | 25 s | |
| Echo 650T | 1 (P2), 1 (P4) | 7 min | P4 unit is the relocated XChem Echo |
| XL200 LiHa / reformatter | 1 (P3) | **assumed 5 min** per plate | deck says "batch" |
| XL200 thawer | 1 (P3) | **assumed 10 min** | not in device list |
| DFSA STX-280 (−20 °C) | 1 (P4) | 25 s | |
| Arktik (−80 °C) | 1 (P4) | 15 s | |
| Connect (Arktik bench access, reformatting point) | 1 (P4) | **assumed 30 s** | blank in deck |
| Vitrification | **assumed 1**, P3 | **assumed 2 min** | not in device list |
| Puck storage | **assumed 1**, P3 | **assumed 25 s** | not in device list |
| LN2, Waste, MAPs | unlimited | 0 s (MAP manual) | |
| Cobots (arm + rail) | 1 (P3), **assumed 2 more** (P4, "2-5 TBC") | **assumed 30 s per move** | count is a run setting |

SpectroQ imaging time per plate is **assumed 3 min** (fixed timing, blue box, value not given).
Soak incubation is project-specific (orange); default **assumed 1 h**.

## 3. Routes

`→` cobot move, `⇒` linked/no move, `[opt]` optional (grey or `*`), `{join X}` convergence.

**Crystallisation setup (pink, both scenarios)**
1. *Reagents from Arktik −80 °C*: MAP ⇒ Arktik → Connect (reformat) → Centrifuge → XL200 LiHa → [opt LN2 → Connect → Arktik]
2. *Reagents from −20 °C*: MAP ⇒ DFSA → XL200 thawer → Centrifuge → Peeler → XL200 LiHa → [opt LN2 → DFSA]
3. *Reagents from SpectroQ*: MAP ⇒ SpectroQ → Centrifuge* → Peeler* → XL200 LiHa → [opt Sealer/Capper → SpectroQ]
4. *Mosquito source plates*: BenchCel ⇒ Labeller → loop{ XL200 LiHa → Sealer → Centrifuge* → Peeler → Mosquito {join mosquito} } × batch → Waste
5. *Crystal plates*: BenchCel ⇒ Labeller → XL200 LiHa → Mosquito {join mosquito} → Sealer → Centrifuge* → SpectroQ (growth storage)

**Soaking workflows ×2 (blue, run days)**: "post growth plates enter two workflows at 15 min intervals (imaging bottleneck), workflows are offset by 7m30s"

6. *Soak workflow 1* (odd plates; release every 15 min from 0): SpectroQ → Peeler(1) → Echo(1) {join soak-1} → Sealer → SpectroQ pre-soak imaging ⇒ incubation (dwell) ⇒ post-soak imaging → Peeler(1) → X-ACT(1,3,5) [spawns pins] → Sealer → SpectroQ (plates route)
7. *Soak workflow 2* (even plates; every 15 min from 7 min 30 s): same with Peeler(2), Echo(2), X-ACT(2,4,6)
8. *Compound plate 1*: MAP ⇒ DC2SA → Centrifuge(1) → loop{ Peeler(1) → Echo(1) {join soak-1} → PlateLoc } × plates → DC2SA
9. *Compound plate 2*: as 8 with unit 2 and {join soak-2}

**After harvesting**

10. *Pins*: (spawned by X-ACT) Vitrification → Puck storage (⇐ MAP pucks out)

**Seed stock generation (red, shutdown days)**

11. *Seed tubes*: X-ACT → XL200 → Centrifuge* → XL200 [spawns seed vitrification] → SpectroQ
12. *Seed vitrification*: (spawned) Vitrification → Arktik or DFSA

## 4. Daily schedule defaults (slide 2)

* 16 crystal plates per day, Mosquito 1 takes odd plates and Mosquito 2 takes even ones (alternatives + FIFO gives this).
* Two source plates (one per Mosquito), reused in batch mode 8 times each.
* 8 plates per soak workflow, one compound plate per workflow serving all 8 soaks.
* Workflow 2's X-ACTs are labelled "2, 3, 4" on slide 2. With 6 X-ACTs and workflow 1 on 1/3/5, this is read as **2/4/6**.
* With 3 X-ACTs per workflow at 41 min each and a 15 min release, each X-ACT is reused every 45 min, which is just enough. The simulator checks this ("keeps up").

## 5. Other assumptions

* `*` (Centrifuge*, Peeler*) is unexplained in the deck. It is read as *conditional step*, on by default and switchable. `**` on XL200 is read as a footnote marker with no effect on flow.
* Reagent routes do not block the LiHa waiting for reagents: the deck says reagent scheduling is ad hoc and "handled by software/science schedule".
* One device unit processes one item at a time. Centrifuge balancing/pairing is not modelled.
* A cobot carries one item; any cobot can serve any move (rail).
* An item keeps its device occupied until a cobot picks it up.
* Phase defaults: cobots P2 = 0 (manual moves), P3 = 1, P4 = 3.
