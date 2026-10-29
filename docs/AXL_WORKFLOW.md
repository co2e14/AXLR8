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
| Slide 2: a compound plate only leaves storage for its own soak | **Start points (sync)**: two routes start a step together, each on its own device |
| "batch mode" arrow Mosquito → XL200 LiHa; compound plate peeled/dispensed/resealed for every soak | **Loops** over a block of steps |
| After X-ACT a plate yields pins, the plate itself, seed tubes | **Spawn**: a step can start items on other routes |
| Incubation inside the SpectroQ (orange, project-specific) | **Dwell** time after a step that does not hold the device |
| Grey boxes "optional: for leftover reagents", `*` steps | **Optional** steps that can be switched on/off |
| Green MAP boxes: manual access points | Manual transport (no cobot) |
| Linked devices (BenchCel + labeller; SpectroQ imaging → incubation → imaging) | Linked transport (no cobot, no move time) |
| Soaking (blue) during runs, seed stock (red) during shutdowns, crystallisation (pink) always | **Scenarios**: *Run day* / *Shutdown day*, plus *Follow-on day*: the second run day in a row, starting with day 1's unfinished work |
| Phases 1–4 of purchases (slide 3) | **Phase** selector: only units bought by that phase exist. Routes that need an unbought device (and their partners) are skipped and listed; steps pinned to an unbought unit share the bought ones, with a warning |

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
| Echo 650T | 1 (P2), 1 (P4) | 7 min | Slide 3 lists the second Echo with quantity 0 ("relocate existing XChem asset"); the flowchart says Echo (2of), so it is modelled as arriving in P4 |
| XL200 LiHa / reformatter | 1 (P3) | **assumed 2 min** per plate | deck says "batch". Slide 2 runs two Mosquitos back to back at 5 min, so the LiHa must supply a plate at least every 2.5 min |
| XL200 thawer | 1 (P3) | **assumed 10 min** | not in device list |
| DFSA STX-280 (−20 °C) | 1 (P4) | 25 s | |
| Vitrification | **assumed 1**, P3 | **assumed 2 min** | not in device list |
| Puck storage | **assumed 1**, P3 | **assumed 25 s** | not in device list |
| LN2, Waste, MAPs (reagents, plates, pucks, protein) | unlimited | 0 s (MAP manual) | |
| Cobots (arm + rail) | 1 (P3), **assumed 2 more** (P4, "2-5 TBC") | **assumed 30 s per move** | count is a run setting |

SpectroQ imaging time per plate is **assumed 3 min** (fixed timing, blue box, value not given).
Soak incubation is project-specific (orange); default **assumed 1 h**.

## 3. Routes

`→` cobot move, `⇒` linked/no move, `[opt]` optional (grey or `*`), `{join X}` convergence.

**Crystallisation setup (pink, both scenarios)**
1. *Protein from MAP* (replaces *Reagents from Arktik −80 °C*): MAP (protein in/out) → Centrifuge → XL200 LiHa → [opt LN2 → MAP (protein out)]. The Arktik and its Connect bench access (slide 3 lines 29–30) are out of price range, so protein comes in and goes out by hand at its own manual access point.
2. *Reagents from −20 °C*: MAP ⇒ DFSA → XL200 thawer → Centrifuge → Peeler → XL200 LiHa → [opt LN2 → DFSA]
3. *Reagents from SpectroQ*: MAP ⇒ SpectroQ → Centrifuge* → Peeler* → XL200 LiHa → [opt Sealer/Capper → SpectroQ]
4. *Mosquito source plates*: BenchCel ⇒ Labeller → XL200 LiHa → Sealer → Centrifuge* → Peeler → loop{ Mosquito {join mosquito} } × 8 → Waste.
   Slide 2 shows each Mosquito running its 8 plates back to back after a single reagent thaw and spin, so the source plate is prepared once and then serves the batch. The "batch mode" arrow (Mosquito → XL200 LiHa) is read as the plate going back to the LiHa for the *next* batch, which is outside one day.
5. *Crystal plates*: BenchCel ⇒ Labeller → XL200 LiHa → Mosquito {join mosquito} → Sealer → Centrifuge* → SpectroQ (growth storage)

**Soaking workflows ×2 (blue, run days)**: "post growth plates enter two workflows at 15 min intervals (imaging bottleneck), workflows are offset by 7m30s"

6. *Soak workflow 1* (odd plates; release every 15 min from 0): SpectroQ (orange) {start soak-1} → Peeler(1) → Echo(1) {join soak-1} → Sealer → SpectroQ pre-soak imaging, then incubation (dwell) ⇒ post-soak imaging → Peeler(1) → X-ACT(1,3,5) [spawns pins] → [opt Sealer → SpectroQ]
   The last two steps are grey on slide 1 and are also the separate "Route for Plates" (X-ACT → Sealer → SpectroQ). Slide 2 shows a clear sealer after harvesting, so they are on by default but marked optional.
7. *Soak workflow 2* (even plates; every 15 min from 7 min 30 s): same with Peeler(2), Echo(2), X-ACT(2,4,6)
8. *Compound plate 1*: loop{ DC2SA {start soak-1} → Centrifuge*(1) → Peeler(1) → Echo(1) {join soak-1} → PlateLoc → DC2SA } × 8
   Slide 2 shows the compound plate going storage → centrifuge → peeler → Echo → foil sealer → storage for every soak, so it only leaves storage when its crystal plate does. Compound plates enter the system through MAP (reagents in/out) beforehand.
9. *Compound plate 2*: as 8 with unit 2 and {join soak-2}. Slide 2 labels its first visit "2" and later ones "C1"; read as the same plate.

**After harvesting**

10. *Pins*: (spawned by X-ACT) Vitrification → Puck storage (⇐ MAP pucks out)

**Seed stock generation (red, shutdown days)**

11. *Seed tubes*: X-ACT → XL200 → Centrifuge* → XL200 [spawns seed vitrification] → SpectroQ
12. *Seed vitrification*: (spawned) Vitrification → DFSA (the deck says Arktik or DFSA; the Arktik is left out)

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
* Between steps an item waits in an unlimited buffer: it frees its device when the cobot picks it up, even if the next device is busy.
  A plate waiting for an X-ACT or for its meeting partner therefore occupies no device (it shows as queued on the map).
* At a meeting point the item that arrives second decides the device, unit and time; both routes' steps should name the same device.
* Reagent routes release 1 item each per day. Seed tubes: 4 per shutdown day, starting at an X-ACT. One puck of pins per harvested plate.
* "Sealer/Capper" on the reagent leftover path is read as the A4S sealer.
* The first step of a route that starts with a cobot move (pins, seed tubes) is fetched from wherever the item was, at the cobot move time.

## 6. Incubators, imaging and growth (added after review with the lab)

* The SpectroQs are incubators. Capacity per unit is taken from the model names: STX-500 **500**, STX-200 **200**,
  STX-1000 **1000** plates. Slide 3 lists the STX-500 and STX-200 as "storage & imaging" and the STX-1000 as storage
  only, so only units 1 and 2 have an imager (editable per unit).
* Plates already inside at the start of the day: **placeholder 100 / 40 / 250**, to be replaced with real counts.
* Imaging a plate takes wells × seconds per well (default **96 × 8 s = 12 min 48 s**); the 8 s covers all three drops
  of a well, Z-stacked. A crystal plate is imaged as it goes in (it cannot go elsewhere meanwhile), before and after
  each soak, and again at the growth schedule (default 1, 2, 4, 8, 16, 32, 64, 128 h after it was stored), until it is
  taken out for soaking or until 24 h after the last simulated day starts.
* While a unit images a plate it does nothing else. **Soak images (and every other step) go ahead of growth images**;
  an image already running is not interrupted.
* Plates grow before they can be soaked: **normal, mean 2 days, cut off at 2 h and 7 days** (from the lab). The spread
  was not given; **sd 1 day is assumed**. A soak takes the plate that has been ready longest; until a plate set up in
  the run has grown it takes one of the plates inside at the start (assumed grown), and if there are none it waits.
* The lab runs **24/7** (confirmed): days follow each other every 24 h, and manual access points are always staffed,
  so manual steps never wait for an operator.
* Multi-day runs repeat the day's releases every 24 h (editable). Result ranges repeat the run with the following
  seeds; with every time fixed, only growth times differ between seeds unless a time variation (±%) is set.

