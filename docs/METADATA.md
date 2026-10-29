# Lab metadata: what each instrument reports

`db/schema.sql` is a Postgres schema that follows every plate, well, drop, crystal, pin and puck, and keeps
what each instrument reports about them. `backend/scripts/mock_db.py` fills it with mock data from one
simulated day: the timings are the simulator's, and the instrument readings are made up within the ranges below.

```bash
cd backend && uv run python scripts/mock_db.py          # writes db/seed.sql (about 12 MB, not committed)
psql -d axlr8 -f ../db/schema.sql -f ../db/seed.sql      # into an existing database, or:
cd ../db && docker compose up                            # throwaway Postgres 16 on localhost:5433 (axl/axl)
```

Then, for example:

```sql
set search_path = axl;
select * from drop_history where crystals_harvested > 0 limit 5;    -- one row per drop, everything known
select * from plate_timeline where plate_id = 1 order by t;          -- every operation and arm move
select * from crystal_history order by hours_to_appear;              -- when each crystal appeared, its fate
```

The scheduler and LIMS will be built in house, so this schema is meant as a starting specification for them:
`operation` is what the scheduler logs for every instrument call, and the typed tables and views are what the LIMS
keeps per plate, drop and crystal.

## How it is organised

* **Lab:** `device`, `device_unit` (serial, phase, capacity, imager, rail position), `cobot_arm`.
* **Samples:** `project`, `protein_sample`, `screen` / `screen_condition`, `compound`, `labware_type`,
  `plate` → `well` → `droplet` (one row per drop: protein, reservoir and seed volumes, protein : reservoir ratio).
* **Operations:** `operation` has one row per call the scheduler makes to an instrument API. It records which
  unit, which plate, the start and end times, the status, the instrument's own job id, and the raw request and
  response as JSON, so anything not yet modelled is still kept. Each instrument then has a typed table for what
  it reports.
* **Imaging:** `imaging_session` (on the way in, the growth schedule, before and after a soak) →
  `drop_image` (one per drop and modality, with its Z-stack and extended-focus image) → `drop_score` →
  `crystal` → `crystal_observation` (size in each later image).
* **Harvesting:** `harvest` (one row per attempt) → `pin` → `puck` → `dewar`, with `vitrification` and
  `puck_storage_event`.

## Per instrument

Fields marked *guess* are educated guesses about what the instrument's API exposes; check them against the
vendor's API documentation before relying on them.

| Instrument | Table | Metadata kept |
|---|---|---|
| Brooks PreciseFlex PF400 arms on the rail | `cobot_move` | arm, from/to unit, ready / start / pick / place / end times, rail positions, time blocked by another arm (from the simulator); gripper force and width, plate-present sensor (*guess*) |
| LiCONiC stores: DFSA STX-280 (−20 °C), DC2SA (N₂), SpectroQ hotels | `storage_event`, `environment_reading` | in/out, cassette and level, set and measured temperature, humidity (DC2SA), door-open time, barcode read and match; temperature and humidity polled every 10 min |
| SpectroQ imager (UV and visible) | `imaging_session`, `drop_image`, `drop_score`, `crystal`, `crystal_observation` | purpose, when it was due and when it ran, hours since set-up, temperature; per drop and modality: Z slices and step, exposure, objective, pixel size, focus score, stack and extended-focus image URIs, drop found; automatic score (MARCO-style outcome and confidence); crystals found, their position, size, habit, UV-positive, and size in later images. The SpectroQ UV detects protein crystals by tryptophan fluorescence, so `uv_positive` separates protein from salt crystals |
| Azenta Automated Plate Seal Remover (XPeel) | `peel_event` | tape adhere time, peel speed, where the peel begins (the instrument's settable parameters); seal seen before, seal removal verified by its reflective sensor, removals left on the tape roll (400 per roll) |
| Azenta Automated Roll Heat Sealer (a4S) | `seal_event` | sealing temperature (100–195 °C) and time (0.1–10 s), seal material and lot, seals left (up to 5,000 per roll) |
| Agilent PlateLoc (foil, compound plates) | `seal_event` | sealing temperature (30–200 °C, ±2 °C) and time, air pressure (about 600–690 kPa supply), seal material and lot |
| Agilent VSpin centrifuge | `centrifuge_run` | speed (rpm and g), spin time, acceleration and braking, bucket, counterweight plate, imbalance (*guess*; vendor specifications not found) |
| Agilent BenchCel and plate labeller | `plate_supply_event`, `label_event` | stack, plates left, labware type; barcode printed, symbology, sides, read back after printing |
| SPT Labtech BioMicroLab XL200 (planned: Opentrons Flex) | `liquid_transfer`, `thaw_event` | one row per transfer: source tube or plate and well, destination plate and well, volume, volume detected before aspirating, flow rates, decapped, tip reuse; thaw start and end temperature and time. The Flex's HTTP API reports runs and per-command records, which fit `operation.api_call_id` and `liquid_transfer.command_id` |
| SPT Labtech mosquito Xtal3 / LCP | `drop_setup_run`, `droplet` | source plate, protocol, sitting / hanging / LCP, humidity-chamber humidity and temperature, tips used, dispense height, LCP bolus volume, time to set up the plate; per drop: protein, reservoir, seed and additive volumes and the ratio |
| Beckman Coulter Echo 650T | `echo_survey`, `echo_transfer` | survey of each source well: volume, DMSO hydration (the Echo measures it to tune its pulses), fluid thickness; each transfer: source well, destination drop, requested and actual volume, droplets of 2.5 nL, fluid calibration class, skipped wells with the reason, soak start and duration until harvest |
| X-ACT harvester (prototype) | `harvest` | one row per attempt: crystal, pin, success or failure reason, cryo-protectant and time, images before and after (*guess*; no public documentation) |
| Vitrification, puck storage (assumed devices) | `vitrification`, `puck_storage_event` | method, LN₂ temperature, time from harvest to cold; puck in/out, dewar position, LN₂ level (*guess*) |
| Manual access points (reagents, plates, pucks, protein) | `operation` | who handed it over, and when |

## In the mock data

The mock data is one run day, phase 4, seed 1:

* **Crystal plates:** 16 new plates, each 96 wells with 3 drops at 1:1, 1:2 and 2:1. Each is imaged on the way in
  and then on the growth schedule, with crystals appearing over the following hours.
* **Soak plates:** 16 older plates that were set up 5–14 days earlier. Each has crystals, which are soaked from
  the compound plates by the Echo. The X-ACT then harvests up to 16 crystals per plate onto pins, with about
  8% of attempts failing. Each plate's pins fill one puck.
* **Images:** about 46,000 images and 37,000 scores.

Image URIs point at an imaginary `s3://axl-images` bucket. To vary the mock data, change `--phase`, `--scenario`
or `--seed`.

## Sources

* SpectroQ UV and visible imaging and storage: [CEITEC Biomolecular Interactions and Crystallography core](https://bic.ceitec.cz/automated-storage-and-visual-inspection-of-crystal-plates-4-c-and-20-c/)
* mosquito Xtal3: [SPT Labtech](https://sptlabtech.com/products/mosquito/mosquito-xtal3), [protein crystallography](https://www.sptlabtech.com/applications/structural-biology/protein-crystallography), [up to 288 drops per 96-well plate](https://www.sptlabtech.com/news/a-unique-approach-to-hanging-drop-ttp-labtechs-mosquito-can-create-up-to-288-drops-per-96-well-plate/)
* Echo 650: [Beckman Coulter](https://www.beckman.com/liquid-handlers/echo-acoustic/echo-650-plus-series), [Echo 650 SOP (HKU)](https://cpos.hku.hk/content/uploads/2024/11/SOP_Backman_Echo650.pdf), [Emerald Cloud Lab acoustic liquid handling](https://www.emeraldcloudlab.com/helpfiles/experimentacousticliquidhandling)
* Plate seal remover: [Azenta](https://www.azenta.com/products/automated-plate-seal-remover-formerly-xpeel)
* Roll heat sealer: [Azenta](https://www.azenta.com/products/automated-roll-heat-sealer-formerly-a4s)
* PlateLoc: [Agilent quick reference](https://www.agilent.com/cs/library/usermanuals/Public/G5402-90003B_PlateLocQR_EN.pdf), [datasheet](https://agilent.com/cs/library/datasheets/public/5990-9391EN.pdf), [VWorks seal task](https://automation.help.agilent.com/AutomationSolutionsKB14/VWorks%20User%20Guide/06_PlateHandling.09.15.html)
* XL200: [SPT Labtech](https://www.sptlabtech.com/products/biomicrolab/biomicrolab-xl200)
