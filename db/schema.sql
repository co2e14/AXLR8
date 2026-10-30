-- AXLR8 lab metadata: one place for everything the instruments report about every plate, well, drop,
-- crystal, pin and puck, so any drop's full history can be read back as one row (see the views at the end).
--
-- Layout:
--   1. Lab: devices, units, cobot arms
--   2. Samples and labware: projects, proteins, screens, compounds, plates, wells, drops
--   3. Operations: every scheduler call to an instrument API (generic), plus a typed table per instrument
--      for the metadata that instrument returns
--   4. Imaging and crystals
--   5. Harvesting: crystals -> pins -> pucks -> dewars
--   6. Views: drop_history, plate_timeline, crystal_history
--
-- Times are timestamptz; durations in seconds; volumes in nL unless named otherwise.
-- Instrument fields are educated guesses from vendor specifications (docs/METADATA.md); the raw API
-- request and response are always kept in operation.request / operation.response so nothing is lost.

create schema if not exists axl;
set search_path = axl, public;

-- ============================================================ 1. Lab

create table device (
    device_id     text primary key,            -- matches the simulator's device id (e.g. 'spectroq')
    name          text not null,
    kind          text not null check (kind in ('process', 'storage', 'manual', 'waste', 'transport')),
    vendor        text,
    model         text,
    api           text,                          -- how the scheduler drives it (SiLA 2, REST, RS-232 ...)
    replacement   text,                          -- planned replacement, if any
    notes         text
);

create table device_unit (
    unit_id       serial primary key,
    device_id     text not null references device,
    unit_no       int not null,
    serial_no     text,
    phase         int,                           -- purchase phase the unit arrives in
    capacity      int,                           -- plates it stores (incubators, stores)
    has_imager    boolean not null default false,
    rail_x_m      numeric(6, 3),                 -- position along the cobot rail
    rail_side     smallint check (rail_side in (-1, 1)),
    unique (device_id, unit_no)
);

create table cobot_arm (
    arm_id        serial primary key,
    arm_no        int not null unique,           -- 0 = nearest the start of the rail
    model         text not null default 'Brooks PreciseFlex PF400',
    serial_no     text,
    home_x_m      numeric(6, 3)
);

-- ============================================================ 2. Samples and labware

create table project (
    project_id    serial primary key,
    code          text not null unique,
    name          text not null,
    target        text
);

create table protein_sample (
    sample_id         serial primary key,
    project_id        int references project,
    name              text not null,
    construct         text,
    batch             text,
    concentration_mg_ml numeric(7, 3),
    buffer            text,
    molecular_weight_kda numeric(8, 2),
    tube_barcode      text unique,
    received_at       timestamptz,
    stored_at_c       numeric(5, 1)              -- e.g. -80, -20, 4
);

create table screen (
    screen_id     serial primary key,
    name          text not null,                 -- e.g. 'JCSG-plus', 'Morpheus'
    vendor        text,
    format        int not null default 96
);

create table screen_condition (
    condition_id  serial primary key,
    screen_id     int not null references screen,
    well          text not null,                 -- 'A1'
    buffer        text,
    ph            numeric(4, 2),
    salt          text,
    precipitant   text,
    precipitant_pct numeric(5, 2),
    additive      text,
    unique (screen_id, well)
);

create table compound (
    compound_id   serial primary key,
    library       text,
    code          text not null unique,
    smiles        text,
    mw_da         numeric(8, 2),
    stock_mm      numeric(8, 2),
    solvent       text default 'DMSO'
);

create table labware_type (
    labware_code  text primary key,              -- e.g. 'MRC3-96', 'Echo-384-LDV', 'SBS-tube-1.4'
    name          text not null,
    vendor        text,
    wells         int,
    drops_per_well int,                          -- sitting-drop sub-wells
    working_volume_ul numeric(8, 2)
);

create table plate (
    plate_id      serial primary key,
    barcode       text not null unique,
    labware_code  text references labware_type,
    role          text not null check (role in ('crystal', 'source', 'compound', 'reagent', 'seed')),
    project_id    int references project,
    screen_id     int references screen,         -- crystal and source plates
    parent_plate_id int references plate,        -- e.g. the source plate a crystal plate was set up from
    created_at    timestamptz not null,
    set_up_at     timestamptz,                   -- drops dispensed (crystal plates): imaging schedule starts here
    discarded_at  timestamptz,
    location_unit_id int references device_unit, -- where it is now
    location_slot text                           -- slot inside a store / incubator
);

create table well (
    well_id       serial primary key,
    plate_id      int not null references plate on delete cascade,
    name          text not null,                 -- 'A1'
    row_letter    char(1) not null,
    col_no        int not null,
    condition_id  int references screen_condition,  -- crystal plates: the reservoir solution
    reservoir_ul  numeric(7, 2),
    compound_id   int references compound,       -- compound plates
    compound_volume_nl numeric(9, 2),
    unique (plate_id, name)
);

create table droplet (                   -- a crystallisation drop ("drop" is reserved in SQL)
    drop_id       serial primary key,
    well_id       int not null references well on delete cascade,
    position      int not null check (position between 1 and 16),  -- sub-well 1..3
    sample_id     int references protein_sample,
    protein_nl    numeric(8, 2),
    reservoir_nl  numeric(8, 2),
    seed_nl       numeric(8, 2) default 0,
    additive_nl   numeric(8, 2) default 0,
    protein_to_reservoir numeric(7, 3) generated always as (protein_nl / nullif(reservoir_nl, 0)) stored,  -- 0.5 = 1:2
    set_up_at     timestamptz,
    set_up_op_id  bigint,                        -- the Mosquito operation that dispensed it
    unique (well_id, position)
);

-- ============================================================ 3. Operations

-- Every instrument API call the scheduler makes, with the raw payloads.
create table operation (
    op_id         bigserial primary key,
    unit_id       int not null references device_unit,
    plate_id      int references plate,
    action        text not null,                 -- 'seal', 'peel', 'store', 'retrieve', 'image', 'dispense' ...
    route         text,                          -- simulator route / workflow step that asked for it
    step_no       int,
    queued_at     timestamptz,
    started_at    timestamptz not null,
    ended_at      timestamptz,
    status        text not null default 'ok' check (status in ('ok', 'warning', 'error', 'aborted')),
    error_code    text,
    error_message text,
    operator      text,                          -- manual steps
    api_call_id   text,                          -- the instrument's own run / job / command id
    request       jsonb,
    response      jsonb
);
create index on operation (plate_id, started_at);
create index on operation (unit_id, started_at);

alter table droplet add foreign key (set_up_op_id) references operation;

-- PreciseFlex arm moves on the rail.
create table cobot_move (
    move_id       bigserial primary key,
    arm_id        int not null references cobot_arm,
    plate_id      int references plate,
    from_unit_id  int references device_unit,
    to_unit_id    int references device_unit,
    ready_at      timestamptz,                   -- plate ready to leave
    started_at    timestamptz not null,
    picked_at     timestamptz,
    placed_at     timestamptz,
    ended_at      timestamptz,
    rail_from_m   numeric(6, 3),
    rail_to_m     numeric(6, 3),
    blocked_s     numeric(9, 2),                 -- waited for another arm to clear the rail
    gripper_force_n numeric(6, 2),
    gripper_width_mm numeric(6, 2),
    plate_present boolean,                       -- gripper sensor after pick
    status        text not null default 'ok'
);

-- LiCONiC-type stores and incubators: DC2SA, DFSA STX-280, SpectroQ (STX-500/200/1000).
create table storage_event (
    op_id         bigint primary key references operation,
    direction     text not null check (direction in ('in', 'out')),
    cassette      int,
    level         int,
    set_temp_c    numeric(5, 2),
    temp_c        numeric(5, 2),
    humidity_pct  numeric(5, 2),
    door_open_s   numeric(6, 2),
    barcode_read  text,
    barcode_match boolean
);

-- Environment log of the incubators and stores (polled), for plates sitting inside.
create table environment_reading (
    unit_id       int not null references device_unit,
    t             timestamptz not null,
    temp_c        numeric(5, 2),
    humidity_pct  numeric(5, 2),
    vibration_mg  numeric(6, 2),
    primary key (unit_id, t)
);

-- Azenta Automated Plate Seal Remover (XPeel).
create table peel_event (
    op_id         bigint primary key references operation,
    tape_adhere_s numeric(5, 2),
    peel_speed    text,                          -- 'slow' | 'normal' | 'fast'
    begin_location text,
    seal_detected_before boolean,
    seal_removed  boolean,                       -- verification sensor after peeling
    tape_remaining int                           -- removals left on the tape roll
);

-- Azenta Automated Roll Heat Sealer (a4S, clear seal for crystal plates) and Agilent PlateLoc (foil, compound plates).
create table seal_event (
    op_id         bigint primary key references operation,
    sealer        text not null check (sealer in ('a4s', 'plateloc')),
    seal_material text,
    seal_lot      text,
    set_temp_c    numeric(5, 1),
    actual_temp_c numeric(5, 1),
    seal_time_s   numeric(5, 2),
    air_pressure_kpa numeric(6, 1),
    seals_remaining int
);

-- VSpin centrifuge.
create table centrifuge_run (
    op_id         bigint primary key references operation,
    rpm           int,
    rcf_g         numeric(7, 1),
    spin_s        numeric(7, 1),
    accel_pct     int,
    decel_pct     int,
    bucket        int,
    counterweight_plate_id int references plate,
    imbalance_detected boolean
);

-- Plate supply and labelling (BenchCel, labeller).
create table plate_supply_event (
    op_id         bigint primary key references operation,
    stack         int,
    plates_left_in_stack int,
    labware_code  text references labware_type
);

create table label_event (
    op_id         bigint primary key references operation,
    barcode       text not null,
    symbology     text,
    sides         text,                          -- e.g. 'south,west'
    verified      boolean,                       -- read back after printing
    print_quality text
);

-- Liquid handling into plates: SPT Labtech XL200 today, Opentrons Flex planned.
-- One row per transfer; the Flex reports run and command ids, which go in operation.api_call_id / here.
create table liquid_transfer (
    transfer_id   bigserial primary key,
    op_id         bigint not null references operation,
    command_id    text,                          -- Opentrons command id
    pipette       text,                          -- e.g. 'flex_8channel_1000'
    tip_rack_slot text,
    source_barcode text,                         -- tube or plate
    source_well   text,
    dest_plate_id int references plate,
    dest_well     text,
    volume_ul     numeric(9, 3),
    detected_volume_ul numeric(9, 3),            -- liquid level detection before aspirating
    aspirate_flow_ul_s numeric(7, 2),
    dispense_flow_ul_s numeric(7, 2),
    decapped      boolean,
    tip_reused    boolean default false,
    status        text not null default 'ok'
);

create table thaw_event (                        -- XL200 thawer
    op_id         bigint primary key references operation,
    start_temp_c  numeric(5, 1),
    end_temp_c    numeric(5, 1),
    thaw_s        numeric(7, 1),
    mixed         boolean
);

-- SPT Labtech mosquito (Xtal3 / LCP): one row per plate set up; drop volumes are on drop.
create table drop_setup_run (
    op_id         bigint primary key references operation,
    source_plate_id int references plate,
    protocol      text,
    drop_type     text check (drop_type in ('sitting', 'hanging', 'lcp')),
    humidity_pct  numeric(5, 2),                 -- humidity chamber
    temp_c        numeric(5, 2),
    tips_used     int,
    aspirate_speed text,
    dispense_height_mm numeric(5, 2),
    lcp_bolus_nl  numeric(7, 2),                 -- LCP: mesophase bolus
    set_up_s      numeric(7, 1)                  -- time to set up the whole plate
);

-- Beckman Echo 650T: the survey of the source plate, and every transfer into a drop.
create table echo_survey (
    survey_id     bigserial primary key,
    op_id         bigint not null references operation,
    source_plate_id int not null references plate,
    well          text not null,
    volume_nl     numeric(9, 2),
    dmso_pct      numeric(5, 2),                 -- measured hydration
    fluid_thickness_mm numeric(6, 3),
    status        text
);

create table echo_transfer (
    transfer_id   bigserial primary key,
    op_id         bigint not null references operation,
    source_plate_id int not null references plate,
    source_well   text not null,
    drop_id       int not null references droplet,
    requested_nl  numeric(9, 2),
    actual_nl     numeric(9, 2),
    droplets      int,                           -- 2.5 nL each
    fluid_class   text,                          -- calibration used, e.g. 'DMSO', '384LDV_DMSO'
    status        text not null default 'ok',    -- 'ok' | 'skipped'
    skip_reason   text,
    soak_started_at timestamptz,
    soak_s        numeric(9, 1)                  -- until harvest
);

-- ============================================================ 4. Imaging and crystals

-- One visit to the imager: as the plate goes in, for a soak, or on the growth schedule.
create table imaging_session (
    session_id    bigserial primary key,
    op_id         bigint references operation,
    plate_id      int not null references plate,
    unit_id       int not null references device_unit,
    purpose       text not null check (purpose in ('entry', 'growth', 'pre_soak', 'post_soak', 'manual')),
    due_at        timestamptz,                   -- when the schedule wanted it
    started_at    timestamptz not null,
    ended_at      timestamptz,
    hours_since_setup numeric(8, 2),
    temp_c        numeric(5, 2),
    seconds_per_well numeric(6, 2),
    modalities    text[] not null default '{visible}'
);

create table drop_image (
    image_id      bigserial primary key,
    session_id    bigint not null references imaging_session on delete cascade,
    drop_id       int not null references droplet,
    modality      text not null check (modality in ('visible', 'uv', 'polarised', 'sonicc')),
    taken_at      timestamptz not null,
    z_slices      int,
    z_step_um     numeric(6, 2),
    exposure_ms   numeric(8, 2),
    objective     text,
    pixel_size_um numeric(6, 3),
    focus_score   numeric(6, 3),
    uri           text not null,                 -- stack of slices
    edf_uri       text,                          -- extended-focus (Z-stacked) image
    drop_area_px  int,
    drop_found    boolean
);
create index on drop_image (drop_id, taken_at);

create table drop_score (
    score_id      bigserial primary key,
    image_id      bigint not null references drop_image on delete cascade,
    drop_id       int not null references droplet,
    scored_at     timestamptz not null,
    scorer        text not null,                 -- 'MARCO v2' | a person
    outcome       text not null check (outcome in ('clear', 'precipitate', 'skin', 'phase_separation', 'microcrystals', 'crystal', 'other')),
    confidence    numeric(4, 3),
    crystals_seen int
);

create table crystal (
    crystal_id    serial primary key,
    drop_id       int not null references droplet,
    first_image_id bigint references drop_image,
    first_seen_at timestamptz,
    x_um          numeric(8, 1),                 -- position in the drop
    y_um          numeric(8, 1),
    length_um     numeric(8, 1),
    width_um      numeric(8, 1),
    habit         text,                          -- 'rod', 'plate', 'cube', 'needle'
    uv_positive   boolean
);

-- Size of each crystal in every later image, to follow its growth.
create table crystal_observation (
    crystal_id    int not null references crystal on delete cascade,
    image_id      bigint not null references drop_image on delete cascade,
    length_um     numeric(8, 1),
    width_um      numeric(8, 1),
    primary key (crystal_id, image_id)
);

-- ============================================================ 5. Harvesting

create table dewar (
    dewar_id      serial primary key,
    barcode       text not null unique,
    location      text
);

create table puck (
    puck_id       serial primary key,
    barcode       text not null unique,
    puck_type     text default 'Unipuck',
    dewar_id      int references dewar,
    dewar_position int
);

create table pin (
    pin_id        serial primary key,
    barcode       text not null unique,
    loop_type     text,
    loop_size_um  int,
    puck_id       int references puck,
    puck_position int check (puck_position between 1 and 16),
    unique (puck_id, puck_position)
);

-- X-ACT harvester: one row per harvest attempt.
create table harvest (
    harvest_id    serial primary key,
    op_id         bigint not null references operation,
    crystal_id    int not null references crystal,
    pin_id        int references pin,
    attempt       int not null default 1,
    started_at    timestamptz not null,
    ended_at      timestamptz,
    success       boolean not null,
    failure_reason text,
    cryo_solution text,
    cryo_s        numeric(6, 2),
    image_before_uri text,
    image_after_uri text
);

create table vitrification (                  -- one row per pin; a puck's pins are vitrified in one operation
    op_id         bigint not null references operation,
    pin_id        int not null references pin,
    method        text,                          -- 'plunge' | 'cryostream'
    ln2_temp_c    numeric(6, 2),
    transfer_s    numeric(6, 2),                 -- harvest -> cold
    plunged_at    timestamptz,
    primary key (op_id, pin_id)
);

create table puck_storage_event (
    op_id         bigint primary key references operation,
    puck_id       int not null references puck,
    direction     text not null check (direction in ('in', 'out')),
    dewar_id      int references dewar,
    ln2_level_pct numeric(5, 2)
);

-- ============================================================ 6. Views

-- Everything known about a drop, one row per drop.
create view drop_history as
select
    d.drop_id,
    p.barcode                               as plate_barcode,
    w.name                                  as well,
    d.position                              as drop_position,
    pr.code                                 as project,
    ps.name                                 as protein,
    ps.batch                                as protein_batch,
    ps.concentration_mg_ml,
    sc.name                                 as screen,
    c.buffer, c.ph, c.salt, c.precipitant, c.precipitant_pct,
    d.protein_nl, d.reservoir_nl, d.seed_nl,
    (d.protein_nl::float8)::text || ':' || (d.reservoir_nl::float8)::text as ratio,  -- protein : well solution
    d.set_up_at,
    su.humidity_pct                         as setup_humidity_pct,
    su.temp_c                               as setup_temp_c,
    dev.name                                as set_up_on,
    (select count(*) from drop_image i where i.drop_id = d.drop_id)                     as images,
    (select max(i.taken_at) from drop_image i where i.drop_id = d.drop_id)              as last_imaged_at,
    (select s.outcome from drop_score s where s.drop_id = d.drop_id order by s.scored_at desc limit 1) as latest_score,
    (select count(*) from crystal x where x.drop_id = d.drop_id)                        as crystals,
    (select min(x.first_seen_at) from crystal x where x.drop_id = d.drop_id)            as first_crystal_at,
    (select string_agg(cp.code, ', ') from echo_transfer et
        join well cw on cw.plate_id = et.source_plate_id and cw.name = et.source_well
        join compound cp on cp.compound_id = cw.compound_id
        where et.drop_id = d.drop_id)                                                    as soaked_with,
    (select sum(et.actual_nl) from echo_transfer et where et.drop_id = d.drop_id)       as compound_nl,
    (select count(*) from harvest h join crystal x using (crystal_id)
        where x.drop_id = d.drop_id and h.success)                                       as crystals_harvested,
    (select string_agg(pn.barcode || '@' || pk.barcode || '/' || pn.puck_position, ', ')
        from harvest h join crystal x using (crystal_id) join pin pn using (pin_id) join puck pk using (puck_id)
        where x.drop_id = d.drop_id and h.success)                                       as pins
from droplet d
join well w using (well_id)
join plate p using (plate_id)
left join project pr on pr.project_id = p.project_id
left join protein_sample ps on ps.sample_id = d.sample_id
left join screen sc on sc.screen_id = p.screen_id
left join screen_condition c on c.condition_id = w.condition_id
left join drop_setup_run su on su.op_id = d.set_up_op_id
left join operation o on o.op_id = d.set_up_op_id
left join device_unit u on u.unit_id = o.unit_id
left join device dev on dev.device_id = u.device_id;

-- Everything that happened to a plate, in order: instrument operations and cobot moves.
create view plate_timeline as
select o.plate_id, o.started_at as t, o.ended_at as until, dv.name || ' ' || u.unit_no as at, o.action as what,
       o.status, coalesce(o.response, '{}'::jsonb) as details
from operation o
join device_unit u using (unit_id)
join device dv using (device_id)
union all
select m.plate_id, m.started_at, m.ended_at, 'Arm ' || a.arm_no,
       'move ' || coalesce(fd.name || ' ' || fu.unit_no, '?') || ' -> ' || coalesce(td.name || ' ' || tu.unit_no, '?'),
       m.status, jsonb_build_object('blocked_s', m.blocked_s, 'rail_from_m', m.rail_from_m, 'rail_to_m', m.rail_to_m)
from cobot_move m
join cobot_arm a using (arm_id)
left join device_unit fu on fu.unit_id = m.from_unit_id left join device fd on fd.device_id = fu.device_id
left join device_unit tu on tu.unit_id = m.to_unit_id left join device td on td.device_id = tu.device_id;

-- Each crystal's growth and fate.
create view crystal_history as
select
    x.crystal_id, dh.plate_barcode, dh.well, dh.drop_position, dh.protein, dh.ratio,
    x.first_seen_at, extract(epoch from x.first_seen_at - dh.set_up_at) / 3600 as hours_to_appear,
    x.habit, x.uv_positive,
    (select max(o.length_um) from crystal_observation o where o.crystal_id = x.crystal_id) as max_length_um,
    h.success as harvested, pn.barcode as pin, pk.barcode as puck, pn.puck_position
from crystal x
join drop_history dh on dh.drop_id = x.drop_id
left join harvest h on h.crystal_id = x.crystal_id and h.success
left join pin pn on pn.pin_id = h.pin_id
left join puck pk on pk.puck_id = pn.puck_id;
