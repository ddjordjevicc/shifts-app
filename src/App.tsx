import { useState, useMemo, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmployeeDef {
  name: string;
}
interface EmployeeState extends EmployeeDef {
  shiftsAssigned: number;
  assignedShifts: Record<string, string[]>;
}
type ShiftKey = 'B' | 'L' | 'D';
// B/L/D booleans = requested OFF.
// WB/WL/WD = this person is covering a WAITSTAFF shift that meal instead of kitchen
// (a purely local marker — it blocks the kitchen shift and is excluded from kitchen
// headcounts/totals, but is NOT synced to any other schedule).
// custom = free-text full-day work assignment (e.g. "Inventory", "Training",
// "Catering"): the person is busy all day (no regular shifts possible) but the day
// counts as 3 shift-units (Breakfast + Lunch + Dinner), and the text is shown
// verbatim in the final schedule.
type OffRequest = Partial<Record<ShiftKey, boolean>> & {
  WB?: boolean;
  WL?: boolean;
  WD?: boolean;
  custom?: string;
};
interface ScheduleResult {
  employees: EmployeeState[];
  dates: string[];
  warnings: string[];
}
type Step = 'setup' | 'staff' | 'off' | 'result';

// ─── Static data ─────────────────────────────────────────────────────────────

const DEFAULT_EMPLOYEES: EmployeeDef[] = [
  { name: 'Tony' },
  { name: 'Warren' },
  { name: 'Dan' },
  { name: 'Stephanie' },
  { name: 'Jaime' },
  { name: 'Ethan' },
  { name: 'Nicholas' },
  { name: 'Amanda' },
  { name: 'Mara' },
  { name: 'Daniel' },
  { name: 'Emil' },
  { name: 'Jose' },
  { name: 'Marisella' },
  { name: 'Vanessa' },
  { name: 'Miranda' },
  { name: 'Mehmet' },
  { name: 'ALP' },
  { name: 'Gio' },
  { name: 'Cameron' },
  { name: 'Jane' },
  { name: 'Brittany' },
];

// NEW: the "head cooks / head assistants" — whenever one of them is NOT off (per the
// CURRENT Off Requests state, whether that's a default or a manual override), they
// must work, and their shifts are filled before anyone else's. See the MANDATORY
// FILL pass inside generateSchedule below.
const MANDATORY_NAMES: string[] = ['Tony', 'Warren', 'Dan', 'Stephanie', 'Jaime', 'Ethan'];

const SHIFTS: ShiftKey[] = ['B', 'L', 'D'];
const SHIFT_LABEL: Record<ShiftKey, string> = {
  B: 'Breakfast',
  L: 'Lunch',
  D: 'Dinner',
};
const MAX_SHIFTS = 15;

// ─── Utilities ────────────────────────────────────────────────────────────────

function getDatesInRange(s: string, e: string): string[] {
  const out: string[] = [];
  let cur = new Date(s + 'T00:00:00');
  const end = new Date(e + 'T00:00:00');
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86400000);
  }
  return out;
}
function addDays(d: string, n: number) {
  return new Date(new Date(d + 'T00:00:00').getTime() + n * 86400000)
    .toISOString()
    .slice(0, 10);
}
const fmt = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

// NEW: default Off Request patterns for the 6 mandatory names, based on day of week.
// These are just STARTING VALUES written into the normal Off Requests state — from
// that point on they are ordinary, fully user-editable toggles, exactly like any
// other employee's. Nothing here is a permanent restriction.
//   Warren:    Sunday off all day; Breakfast off every day.
//   Tony:      Breakfast off every day; Tuesday + Wednesday off all day.
//   Dan:       Lunch off every day; Monday + Thursday off all day.
//   Stephanie: Monday–Thursday off all day; Dinner-only on Friday/Saturday/Sunday.
//   Jaime:     Friday + Saturday off all day; Breakfast+Lunch on the other days.
//   Ethan:     Dinner off every day; Wednesday + Thursday off all day.
function buildDefaultOffRequests(dates: string[]): Record<string, Record<string, OffRequest>> {
  const out: Record<string, Record<string, OffRequest>> = {};
  const set = (name: string, day: string, off: OffRequest) => {
    if (!out[name]) out[name] = {};
    out[name][day] = off;
  };
  for (const day of dates) {
    const dow = new Date(day + 'T00:00:00').getDay(); // 0=Sun … 6=Sat
    set('Warren', day, dow === 0 ? { B: true, L: true, D: true } : { B: true });
    set('Tony', day, dow === 2 || dow === 3 ? { B: true, L: true, D: true } : { B: true });
    set('Dan', day, dow === 1 || dow === 4 ? { B: true, L: true, D: true } : { L: true });
    set('Stephanie', day, dow >= 1 && dow <= 4 ? { B: true, L: true, D: true } : { B: true, L: true });
    set('Jaime', day, dow === 5 || dow === 6 ? { B: true, L: true, D: true } : { D: true });
    set('Ethan', day, dow === 3 || dow === 4 ? { B: true, L: true, D: true } : { D: true });
  }
  return out;
}

//function isSunday(day: string): boolean {
 // return new Date(day + 'T00:00:00').getDay() === 0;


// Single source of truth for "is this a custom full-day work assignment (Inventory,
// Training, Catering, ...)?" Used both inside the engine (generateSchedule) and by
// the module-level display helpers (getShiftStr, getPartialOffNote), which don't have
// closure access to the engine's own copy of this check.
function isCustomDay(off: OffRequest | undefined): boolean {
  return !!(off?.custom && off.custom.trim());
}

// ─── Engine ───────────────────────────────────────────────────────────────────

function generateSchedule(
  dates: string[],
  required: Record<string, Record<ShiftKey, number>>,
  offRequests: Record<string, Record<string, OffRequest>>,
  empDefs: EmployeeDef[]
): { employees: EmployeeState[]; warnings: string[] } {
  const employees: EmployeeState[] = empDefs.map((e) => ({
    ...e,
    shiftsAssigned: 0,
    assignedShifts: {},
  }));
  const warnings: string[] = [];
  const rem: Record<string, Record<ShiftKey, number>> = JSON.parse(
    JSON.stringify(required)
  );

  //const byName = (n: string) => employees.find((e) => e.name === n)!;

  // Has this person got a custom full-day work assignment (Inventory, Training, ...)
  // today?
  const hasCustomDay = (name: string, day: string): boolean =>
    isCustomDay(offRequests[name]?.[day]);

  // Does a special assignment block this specific shift? A custom full-day job blocks
  // all three meals; a Waitstaff marker (WB/WL/WD) blocks just its one meal, because
  // the person is working the floor that meal instead of the kitchen. Neither of
  // these is a regular "requested off" preference — they represent the person
  // genuinely being unavailable for kitchen work, so neither is ever overridden by
  // anything else (the mandatory-fill pass below still has to respect them).
  const specialBlock = (emp: EmployeeState, day: string, sh: ShiftKey): boolean => {
    if (hasCustomDay(emp.name, day)) return true;
    const off = offRequests[emp.name]?.[day];
    if (off) {
      if (sh === 'B' && off.WB) return true;
      if (sh === 'L' && off.WL) return true;
      if (sh === 'D' && off.WD) return true;
    }
    return false;
  };

  // PRE-CREDIT PASS — a custom full-day job (Inventory, Training, ...) occupies
  // Breakfast + Lunch + Dinner, exactly like a BLD block, so it charges 3 shift-units,
  // not 1. Crediting this into shiftsAssigned before any scheduling means every
  // downstream rule (MAX_SHIFTS, fair-share ordering, leveling passes) automatically
  // hands out correspondingly fewer regular shifts. A Waitstaff marker isn't credited
  // here at all — that time isn't kitchen work, so it shouldn't count toward (or
  // against) the kitchen shift total, it just blocks the slot above.
  for (const emp of employees) {
    for (const day of dates) {
      if (hasCustomDay(emp.name, day)) emp.shiftsAssigned += 3;
    }
  }

  const wantsOff = (emp: EmployeeState, day: string, sh: ShiftKey): boolean => {
    const off = offRequests[emp.name]?.[day];
    if (!off) return false;
    return !!(off[sh] || (off.B && off.L && off.D));
  };

  const alreadyOn = (emp: EmployeeState, day: string, sh: ShiftKey) =>
    (emp.assignedShifts[day] || []).includes(sh);

  const canTake = (emp: EmployeeState, day: string, sh: ShiftKey): boolean => {
    if (emp.shiftsAssigned >= MAX_SHIFTS) return false;
    if (alreadyOn(emp, day, sh)) return false;
    if (specialBlock(emp, day, sh)) return false;
    if (wantsOff(emp, day, sh)) return false;
    return true;
  };

  // Which shifts is this employee still eligible for today (not already on it, not
  // requested off — whether that request is a manual toggle or a default that
  // hasn't been overridden — and not blocked by a custom assignment or a Waitstaff
  // marker). For Tony on a normal day this is ['L','D']; on a day he's marked
  // WAITSTAFF for Dinner, it would just be ['L'].
  const availableShifts = (emp: EmployeeState, day: string): ShiftKey[] =>
    SHIFTS.filter(
      (sh) =>
        !alreadyOn(emp, day, sh) &&
        !specialBlock(emp, day, sh) &&
        !wantsOff(emp, day, sh)
    );

  // Can this employee be given ALL of their currently-available shifts for the day in
  // one go? For someone fully available that's BLD; for Tony that's L+D. This is what
  // lets the fill pass concentrate work into full days instead of scattering single
  // shifts across the week.
  const canFillCombo = (emp: EmployeeState, day: string): boolean => {
    const avail = availableShifts(emp, day);
    if (avail.length === 0) return false;
    if (emp.shiftsAssigned + avail.length > MAX_SHIFTS) return false;
    return avail.every((sh) => rem[day][sh] > 0);
  };

  // Track pick recency so ties (equal workload) rotate fairly instead of always
  // favoring whoever happens to sit earlier in the employee list.
  let pickClock = 0;
  const lastPicked: Record<string, number> = {};

  const assign = (emp: EmployeeState, day: string, sh: ShiftKey) => {
    if (!emp.assignedShifts[day]) emp.assignedShifts[day] = [];
    if (!alreadyOn(emp, day, sh)) {
      emp.assignedShifts[day].push(sh);
      emp.shiftsAssigned++;
      lastPicked[emp.name] = pickClock++;
      if (rem[day] && rem[day][sh] > 0) rem[day][sh]--;
    }
  };

  // The reverse of `assign` — removes a shift and gives the slot back to `rem`. Used
  // only by the leveling passes below, to move a slot from someone who has more than
  // their category's average to someone who has less, when there's no genuinely free
  // capacity left to hand out.
  const unassign = (emp: EmployeeState, day: string, sh: ShiftKey): boolean => {
    const list = emp.assignedShifts[day];
    const idx = list ? list.indexOf(sh) : -1;
    if (idx === -1) return false;
    list.splice(idx, 1);
    emp.shiftsAssigned--;
    if (rem[day]) rem[day][sh]++;
    return true;
  };

  const assignBLD = (emp: EmployeeState, day: string) => {
    SHIFTS.forEach((sh) => assign(emp, day, sh));
  };

  const assignShift = (emp: EmployeeState, day: string, sh: ShiftKey | 'BLD') => {
    if (sh === 'BLD') assignBLD(emp, day);
    else assign(emp, day, sh);
  };

  // Give an employee every shift they're currently eligible for on this day, in one
  // go — for a fully-available person that's BLD, for Tony that's exactly L+D. This is
  // what lets the fill pass concentrate work into full days out of whatever's
  // available, instead of just an occasional single shift.
  const fillCombo = (emp: EmployeeState, day: string) => {
    availableShifts(emp, day).forEach((sh) => assign(emp, day, sh));
  };

  // const mandatoryPool = employees.filter((e) => MANDATORY_NAMES.includes(e.name));
  const regularPool = employees.filter((e) => !MANDATORY_NAMES.includes(e.name));
  const allPool = regularPool; // the general fair-share fill only ever competes among regularPool — mandatory names are handled by their own dedicated pass below, never through fair-share competition.

  // A SOFT preference for 2 full rest days per 7-day week — used only as a tie-break
  // below, never as a hard rule. Everyone is still limited only by MAX_SHIFTS and can
  // be scheduled on every day of the week when the schedule calls for it; this just
  // nudges an otherwise-tied pick toward someone who wouldn't need to open a 6th or
  // 7th working day, so 2 days off happens naturally where it's easy to arrange,
  // without ever blocking a shift or causing a short-staffed day when it isn't.
  const weekBlocks: string[][] = [];
  for (let i = 0; i < dates.length; i += 7) weekBlocks.push(dates.slice(i, i + 7));
  const blockOfDay: Record<string, string[]> = {};
  for (const block of weekBlocks) for (const day of block) blockOfDay[day] = block;

  const isPreOccupied = (name: string, day: string): boolean => hasCustomDay(name, day);

  const workingDaysInBlock = (emp: EmployeeState, block: string[]): number => {
    let count = 0;
    for (const day of block) {
      if ((emp.assignedShifts[day] || []).length > 0 || isPreOccupied(emp.name, day)) count++;
    }
    return count;
  };

  // 0 = picking this employee for `day` fits within a 2-rest-day week (or they're
  // already working today, so it's not a NEW working day); 1 = it would open up a 6th
  // or 7th working day. Purely a tie-break signal, never a filter.
  const exceedsRestPreference = (emp: EmployeeState, day: string): 0 | 1 => {
    if ((emp.assignedShifts[day] || []).length > 0) return 0;
    const block = blockOfDay[day];
    const preferredMaxWorkingDays = Math.max(0, block.length - 2);
    return workingDaysInBlock(emp, block) < preferredMaxWorkingDays ? 0 : 1;
  };

  // The main fill below treats everyone with pure equal fairness (no priority
  // weighting at all) — this is what keeps the day-to-day distribution as even as
  // possible. The priority edge for Dan/Jaime is applied afterward, in a separate,
  // bounded step (see the leveling and swap passes below), instead of being baked
  // into this competitive loop where a small edge either washes out or snowballs
  // unpredictably depending on how tightly booked a given week happens to be.
  // `day`, when given, layers in the 2-rest-day soft preference.
  const REST_PREFERENCE_WEIGHT = 5;
  const pick = (
    pool: EmployeeState[],
    pred: (e: EmployeeState) => boolean,
    day?: string
  ) =>
    pool.filter(pred).sort((a, b) => {
      const pa = day
        ? a.shiftsAssigned + exceedsRestPreference(a, day) * REST_PREFERENCE_WEIGHT
        : a.shiftsAssigned;
      const pb = day
        ? b.shiftsAssigned + exceedsRestPreference(b, day) * REST_PREFERENCE_WEIGHT
        : b.shiftsAssigned;
      const wd = pa - pb;
      if (wd !== 0) return wd;
      return (lastPicked[a.name] ?? -1) - (lastPicked[b.name] ?? -1);
    })[0] || null;

  // MANDATORY FILL PASS — Tony, Warren, Dan, Stephanie, Jaime, and Ethan are head
  // cooks/assistants: whenever one of them is NOT off that meal (per the CURRENT Off
  // Requests state — a default they haven't touched, or something they changed
  // themselves), they must work, and this runs BEFORE the general fair-share fill
  // below so their shifts are always filled first. It's unconditional (no target, no
  // rest-day preference, no leveling) — since it always runs first and mandatory
  // names are never part of `regularPool`, nothing later can ever take a shift away
  // from them, so no separate "protect this person" logic is needed anywhere else.
  for (const day of dates) {
    for (const name of MANDATORY_NAMES) {
      const emp = employees.find((e) => e.name === name);
      if (!emp) continue;
      if (canFillCombo(emp, day)) {
        fillCombo(emp, day);
      } else {
        // Full combo isn't possible (e.g. MAX_SHIFTS is close) — still grab whatever
        // individual shifts are both available to them and still have room.
        for (const sh of availableShifts(emp, day)) {
          if (canTake(emp, day, sh) && rem[day][sh] > 0) assign(emp, day, sh);
        }
      }
      if (availableShifts(emp, day).length > 0 && (emp.assignedShifts[day] || []).length === 0) {
        warnings.push(
          `⚠️ ${name} should have worked on ${fmt(day)} but couldn't be scheduled — likely the ${MAX_SHIFTS}-shift cap was already reached.`
        );
      }
    }
  }

  // FILL PASS — combo-first, so work concentrates into full BLD days with real days
  // off in between, instead of scattering single shifts across every day of the week.
  for (const day of dates) {
    while (true) {
      const e = pick(allPool, (c) => canFillCombo(c, day), day);
      if (!e) break;
      fillCombo(e, day);
    }
    // Fallback: mop up any single shifts left over where a full combo wasn't possible
    // (e.g. someone's combo needed 2 shifts but only 1 still had room).
    for (const sh of SHIFTS) {
      while (rem[day][sh] > 0) {
        const f = pick(allPool, (c) => canTake(c, day, sh), day);
        if (f) { assignShift(f, day, sh); continue; }
        break;
      }
      // The number entered is a hard maximum — if it still couldn't be filled, warn clearly.
      if (rem[day][sh] > 0) {
        warnings.push(
          `⚠️ SHORT-STAFFED: ${SHIFT_LABEL[sh]} on ${fmt(day)} needs ${required[day][sh]}, only ${required[day][sh] - rem[day][sh]} available — not enough eligible staff.`
        );
      }
    }
  }

  // Try to grant ONE more shift to `emp`, using free capacity if any exists, or
  // otherwise swapping a shift away from a donor who's currently ABOVE that donor
  // group's own floor. `donorSpecs` lets different donor groups use different floors —
  // e.g. regular staff can be drawn down to the regular average, while the priority
  // pool's OWN members can only be drawn down to the priority target, never below it.
  // Without this distinction, priority members could keep "donating" to each other
  // back and forth forever, since taking one below its own target just makes it needy
  // again next round. Returns whether it succeeded, so callers can tell when to give up.
  const grantOneShift = (
    emp: EmployeeState,
    target: number,
    donorSpecs: { pool: EmployeeState[]; floor: number }[]
  ): boolean => {
    for (const day of dates) {
      if (emp.shiftsAssigned >= target) return false;
      // Deliberately single-shift-at-a-time here (no combo shortcut) — this runs near
      // a precise target, and handing out a whole combo in one go could overshoot it.
      for (const sh of SHIFTS) {
        if (!canTake(emp, day, sh)) continue;
        if (rem[day][sh] > 0) {
          assign(emp, day, sh);
          return true;
        }
        for (const { pool, floor } of donorSpecs) {
          // Pick the donor with the MOST shifts (not just the first match), so the
          // cost of each donation lands on whoever can best afford it.
          const donor = pool
            .filter(
              (d) =>
                d.name !== emp.name &&
                d.shiftsAssigned > floor &&
                (d.assignedShifts[day] || []).includes(sh)
            )
            .sort((a, b) => b.shiftsAssigned - a.shiftsAssigned)[0];
          if (donor) {
            unassign(donor, day, sh);
            assign(emp, day, sh);
            return true;
          }
        }
      }
    }
    return false;
  };

  // Bring everyone in `pool` up toward `target`, always giving the next shift to
  // whoever is CURRENTLY furthest behind (re-checked after every grant) rather than
  // working through the pool in a fixed order — otherwise whoever happens to be
  // processed first could use up all the available donor capacity, leaving the last
  // person in the list shortchanged even though they need it just as much.
  const levelPoolToward = (
    pool: EmployeeState[],
    target: number,
    donorSpecs: { pool: EmployeeState[]; floor: number }[]
  ) => {
    const stuck = new Set<string>();
    while (true) {
      const needy = pool
        .filter((e) => e.shiftsAssigned < target && !stuck.has(e.name))
        .sort((a, b) => a.shiftsAssigned - b.shiftsAssigned)[0];
      if (!needy) break;
      if (!grantOneShift(needy, target, donorSpecs)) stuck.add(needy.name);
    }
  };


  // REGULAR LEVELING — bring anyone in the regular (non-mandatory) pool who fell
  // behind (a requested day off, an unlucky rotation, or just how the combo-fill
  // happened to land) back up toward the regular average — swapping a shift over
  // from an above-average peer if there's no free capacity left. Uses floor(avg), not
  // round(avg): with round, a straggler stuck below an otherwise perfectly even pool
  // has no donors (nobody is above the average) and stays stuck; with floor, peers
  // sitting exactly at the average CAN each spare one shift. Mandatory names are never
  // part of `regularPool`, so this can never touch their shifts either as donor or
  // recipient — their count is settled entirely by the MANDATORY FILL pass above.
  if (regularPool.length > 0) {
    const regularAvg = Math.floor(
      regularPool.reduce((s, e) => s + e.shiftsAssigned, 0) / regularPool.length
    );
    levelPoolToward(regularPool, regularAvg, [
      { pool: regularPool, floor: regularAvg },
    ]);
  }

  return { employees, warnings };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

// NO  = employee requested this day off (whether from a default or a manual change)
// OFF = algorithm assigned a rest day (no off request, just no shifts given)
// A custom full-day assignment (Inventory, Training, ...) is shown verbatim.
function getShiftStr(
  emp: EmployeeState,
  day: string,
  offRequests: Record<string, Record<string, OffRequest>>
): string {
  const off = offRequests[emp.name]?.[day];
  if (isCustomDay(off)) return off!.custom!.trim();

  const s = emp.assignedShifts[day] || [];
  // Build segments: consecutive worked meals group together (e.g. "BL"), while a
  // WAITSTAFF-marked meal is always its own separate tag (e.g. "WD") — so a day can
  // read like "L | WD": worked Lunch in the kitchen, covering Waitstaff for Dinner.
  const segments: string[] = [];
  let run = '';
  for (const sh of SHIFTS) {
    const isW = sh === 'B' ? off?.WB : sh === 'L' ? off?.WL : off?.WD;
    if (isW) {
      if (run) { segments.push(run); run = ''; }
      segments.push('W' + sh);
    } else if (s.includes(sh)) {
      run += sh;
    } else if (run) {
      segments.push(run);
      run = '';
    }
  }
  if (run) segments.push(run);

  if (segments.length === 0) {
    const requestedOff = off && (off.B || off.L || off.D);
    return requestedOff ? 'NO' : 'OFF';
  }
  return segments.join(' | ');
}

// A requested-off meal doesn't have to mean the whole day is off — this returns which
// specific meal(s) were requested off on a day the employee still worked SOME shift,
// so the UI can show e.g. "LD" plus a small "(B off)" note instead of just "LD" with
// no indication the Breakfast request was honored. WAITSTAFF-marked meals are already
// shown explicitly in the main display (e.g. "L | WD"), so they're excluded here to
// avoid a redundant note.
function getPartialOffNote(
  emp: EmployeeState,
  day: string,
  offRequests: Record<string, Record<string, OffRequest>>
): string {
  const off = offRequests[emp.name]?.[day];
  if (!off) return '';
  if (isCustomDay(off)) return '';
  const s = emp.assignedShifts[day] || [];
  if (s.length === 0) return '';
  const missed = SHIFTS.filter((sh) => off[sh] && !s.includes(sh));
  return missed.join('');
}

const shiftColor = (str: string): { bg: string; text: string } => {
  if (str === 'NO')  return { bg: '#450a0a', text: '#f87171' }; // requested off — dark red
  if (str === 'OFF') return { bg: '#1e293b', text: '#475569' }; // algorithm rest — dark slate
  if (/W[BLD]/.test(str)) return { bg: '#1e3a5f', text: '#7dd3fc' }; // covering Waitstaff — distinct blue
  if (str === 'BLD') return { bg: '#7c3aed', text: '#fff' };
  if (str === 'BL')  return { bg: '#2563eb', text: '#fff' };
  if (str === 'LD')  return { bg: '#059669', text: '#fff' };
  if (str === 'BD')  return { bg: '#0e7490', text: '#fff' };
  if (str === 'B')   return { bg: '#0ea5e9', text: '#fff' };
  if (str === 'L')   return { bg: '#16a34a', text: '#fff' };
  if (str === 'D')   return { bg: '#d97706', text: '#fff' };
  // Anything else is a custom full-day assignment (Inventory, Training, ...) — teal.
  return { bg: '#134e4a', text: '#5eead4' };
};

// ─── App ──────────────────────────────────────────────────────────────────────

export default function KitchenSchedulerApp() {
  const today = new Date().toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDays(today, 6));
  const [staffInput, setStaffInput] = useState<Record<string, Record<ShiftKey, number>>>({});
  const [offRequests, setOffRequests] = useState<Record<string, Record<string, OffRequest>>>({});
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const [step, setStep] = useState<Step>('setup');
  // Manual, display-only edits on the final results page. Keyed by [name][date],
  // storing whatever text the user typed to replace that cell (e.g. "L" instead of
  // the generated "BLD"). Purely cosmetic — it never touches `schedule` or re-runs
  // the engine, it only overrides what's rendered and what the row's total adds up to.
  const [manualEdits, setManualEdits] = useState<Record<string, Record<string, string>>>({});
  const [editingCell, setEditingCell] = useState<{ name: string; day: string } | null>(null);

  const dates = useMemo(() => {
    if (!startDate || !endDate || startDate > endDate) return [];
    return getDatesInRange(startDate, endDate);
  }, [startDate, endDate]);

  const handleStartChange = (val: string) => {
    setStartDate(val);
    setEndDate(addDays(val, 6));
  };

  const getStaff = (d: string, sh: ShiftKey) => staffInput[d]?.[sh] ?? 10;
  const setStaff = (d: string, sh: ShiftKey, v: number) =>
    setStaffInput((p) => ({ ...p, [d]: { ...p[d], [sh]: v } }));
  const staffWarn = (v: number) => v < 5 || v > 16;

  const initStaff = () => {
    const init: Record<string, Record<ShiftKey, number>> = {};
    dates.forEach((d) => { init[d] = staffInput[d] || { B: 10, L: 10, D: 10 }; });
    setStaffInput(init);
    setStep('staff');
  };

  // B, L and D each cycle through three states: Working → NO/OFF → WAITSTAFF →
  // Working. WAITSTAFF means this person is covering the floor that meal instead of
  // the kitchen — it blocks the kitchen shift (like NO) but is visually and logically
  // distinct: it's excluded from kitchen headcounts/totals, shown with its own color.
  const toggleOff = (name: string, date: string, sh: ShiftKey) => {
    const wKey: 'WB' | 'WL' | 'WD' = sh === 'B' ? 'WB' : sh === 'L' ? 'WL' : 'WD';
    setOffRequests((p) => {
      const cur = p[name]?.[date] ?? {};
      const isOff = !!cur[sh];
      const isW = !!(cur as OffRequest)[wKey];
      const next: OffRequest =
        !isOff && !isW
          ? { ...cur, [sh]: true, [wKey]: false }
          : isOff
            ? { ...cur, [sh]: false, [wKey]: true }
            : { ...cur, [sh]: false, [wKey]: false };
      return { ...p, [name]: { ...p[name], [date]: next } };
    });
  };

  const isWaitstaffShift = (name: string, d: string, sh: ShiftKey): boolean =>
    sh === 'B'
      ? !!offRequests[name]?.[d]?.WB
      : sh === 'L'
        ? !!offRequests[name]?.[d]?.WL
        : !!offRequests[name]?.[d]?.WD;

  // Free-text full-day work assignment (Inventory, Training, Catering, ...).
  const setCustomDay = (name: string, date: string, text: string) =>
    setOffRequests((p) => ({
      ...p,
      [name]: { ...p[name], [date]: { ...p[name]?.[date], custom: text } },
    }));

  const getCustomDay = (name: string, d: string): string =>
    offRequests[name]?.[d]?.custom ?? '';

  const toggleFullDay = (name: string, date: string) =>
    setOffRequests((p) => {
      const allOff = SHIFTS.every((sh) => p[name]?.[date]?.[sh]);
      return { ...p, [name]: { ...p[name], [date]: { B: !allOff, L: !allOff, D: !allOff } } };
    });

  const toggleFullWeek = (name: string) => {
    setOffRequests((p) => {
      const allDaysOff = dates.every((d) => SHIFTS.every((sh) => p[name]?.[d]?.[sh]));
      const updated = { ...p, [name]: { ...p[name] } };
      for (const d of dates) {
        updated[name][d] = { B: !allDaysOff, L: !allDaysOff, D: !allDaysOff };
      }
      return updated;
    });
  };

  const isFullOff = (name: string, d: string) =>
    SHIFTS.every((sh) => offRequests[name]?.[d]?.[sh]);
  const isShiftOff = (name: string, d: string, sh: ShiftKey) =>
    !!offRequests[name]?.[d]?.[sh];
  const isFullWeekOff = (name: string) =>
    dates.length > 0 && dates.every((d) => isFullOff(name, d));

  const [emailTrigger, setEmailTrigger] = useState(0);

  const generate = () => {
    const required: Record<string, Record<ShiftKey, number>> = {};
    dates.forEach((d) => {
      required[d] = { B: getStaff(d, 'B'), L: getStaff(d, 'L'), D: getStaff(d, 'D') };
    });
    const { employees, warnings } = generateSchedule(dates, required, offRequests, DEFAULT_EMPLOYEES);
    setSchedule({ employees, dates, warnings });
    setManualEdits({}); // a fresh schedule means any prior manual edits no longer apply
    setEmailTrigger((n) => n + 1); // background-emails the schedule once it settles (see the effect below)
    setStep('result');
  };

  // What should this cell actually show — the manual edit if one exists for this
  // person/day, otherwise whatever the engine generated.
  const getDisplayShift = (emp: EmployeeState, day: string): string => {
    const edit = manualEdits[emp.name]?.[day];
    if (edit !== undefined) return edit.trim() === '' ? 'OFF' : edit.trim();
    return getShiftStr(emp, day, offRequests);
  };

  // Parses a displayed cell (e.g. "L | WD", "BLD", "Inventory") into the set of
  // meals that count as REGULAR kitchen work — a "W"+letter segment (covering
  // Waitstaff) is deliberately excluded, since that time isn't kitchen work at all.
  const parseKitchenMeals = (display: string): Set<ShiftKey> => {
    const kitchen = new Set<ShiftKey>();
    if (display === 'OFF' || display === 'NO' || display.trim() === '') return kitchen;
    for (const seg of display.split('|').map((s) => s.trim())) {
      if (/^W[BLD]$/.test(seg)) continue; // Waitstaff cover — not kitchen work
      if (/^[BLD]{1,3}$/.test(seg)) {
        for (const ch of seg) kitchen.add(ch as ShiftKey);
      }
      // anything else (custom text) isn't a specific meal at all
    }
    return kitchen;
  };

  // How many REGULAR kitchen shift-units does a displayed cell represent? Excludes
  // WAITSTAFF-covered meals (not kitchen work) and a custom full-day assignment (e.g.
  // "Inventory") — this schedule tracks kitchen shifts worked, not other assignments.
  const countRegularShiftUnits = (display: string): number => parseKitchenMeals(display).size;

  // The row total, recalculated live from what's actually displayed — so editing a
  // single day immediately updates the person's total, without needing to re-run
  // the scheduling engine.
  const getDisplayTotal = (emp: EmployeeState): number =>
    schedule
      ? schedule.dates.reduce(
          (sum, d) => sum + countRegularShiftUnits(getDisplayShift(emp, d)),
          0
        )
      : 0;

  // How many people are CURRENTLY on for a given day/meal as KITCHEN staff —
  // reflecting any manual edits, and excluding anyone on a custom assignment or
  // covering Waitstaff that meal. This is what "Staff per meal" shows: the live
  // actual kitchen count, not just the number originally typed in on the staffing
  // page, and never inflated by someone who's actually on the floor that meal.
  const countStaffForMeal = (day: string, sh: ShiftKey): number => {
    if (!schedule) return 0;
    return schedule.employees.filter((e) =>
      parseKitchenMeals(getDisplayShift(e, day)).has(sh)
    ).length;
  };

  const saveManualEdit = (name: string, day: string, value: string) => {
    setManualEdits((p) => ({ ...p, [name]: { ...p[name], [day]: value } }));
    setEditingCell(null);
  };

  const clearManualEdit = (name: string, day: string) => {
    setManualEdits((p) => {
      const next = { ...p, [name]: { ...p[name] } };
      delete next[name][day];
      return next;
    });
    setEditingCell(null);
  };

  // PDF export — opens a print-optimized view sized for a single US Letter page
  // (8.5 × 11 in) and triggers the browser's print dialog, where the user can print
  // directly or choose "Save as PDF".
  // Builds the full printable/emailable HTML for the CURRENT schedule — the exact
  // same content whether it ends up in the Export PDF print dialog or the
  // background email, since both call this one function.
  const buildScheduleHtml = (): { html: string; rangeLabel: string } | null => {
    if (!schedule) return null;

    const longDay = (d: string) =>
      new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    const monthDay = (d: string) =>
      new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

    const first = schedule.dates[0];
    const last = schedule.dates[schedule.dates.length - 1];
    const firstD = new Date(first + 'T00:00:00');
    const lastD = new Date(last + 'T00:00:00');
    const range =
      firstD.getMonth() === lastD.getMonth()
        ? `${monthDay(first)}–${lastD.getDate()}`
        : `${monthDay(first)} – ${monthDay(last)}`;

    const shiftCellStyle = (s: string) => {
      if (s === 'OFF') return 'color:#999;';
      if (s === 'NO') return 'color:#b91c1c;';
      if (/W[BLD]/.test(s)) return 'background:#dbeafe;color:#1e40af;';
      if (s === 'BLD') return 'background:#ede9fe;';
      if (s === 'BL') return 'background:#e0f2fe;';
      if (s === 'LD') return 'background:#fef9c3;';
      if (!/^[BLD]{1,3}$/.test(s)) return 'background:#ccfbf1;font-size:8.5px;';
      return 'background:#f1f5f9;';
    };

    const headerCells = schedule.dates
      .map(
        (d) =>
          `<th><div class="dow">${longDay(d)}</div><div class="md">${monthDay(d)}</div></th>`
      )
      .join('');

    const bodyRows = schedule.employees
      .map((e) => {
        const cells = schedule.dates
          .map((d) => {
            const s = getDisplayShift(e, d);
            const edited = manualEdits[e.name]?.[d] !== undefined;
            const note = edited ? '' : getPartialOffNote(e, d, offRequests);
            return `<td style="${shiftCellStyle(s)}">${s}${
              note ? `<div class="note">(${note} NO)</div>` : ''
            }</td>`;
          })
          .join('');
        return `<tr><td class="name">${e.name}</td>${cells}<td class="total">${getDisplayTotal(e)}</td></tr>`;
      })
      .join('');

    const staffRow = `<tr class="staffrow"><td class="name stafflabel">Staff per meal</td>${schedule.dates
      .map((d) => {
        const cells = SHIFTS.map((sh) => {
          const actual = countStaffForMeal(d, sh);
          const target = getStaff(d, sh);
          const color = actual < target ? '#b91c1c' : actual > target ? '#b45309' : '#555';
          return `<span style="color:${color}">${actual}/${target}</span>`;
        }).join(' - ');
        return `<td>${cells}</td>`;
      })
      .join('')}<td></td></tr>`;

    const html = `<!DOCTYPE html>
<html>
<head>
<title>Kitchen Staff ${range}</title>
<style>
  @page { size: letter; margin: 0.35in; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 2px 0; letter-spacing: 0.5px; }
  .range { font-size: 13px; color: #444; margin: 0 0 10px 0; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 1px solid #cbd5e1; text-align: center; padding: 3px 2px; font-size: 10.5px; overflow: hidden; }
  th { background: #f1f5f9; font-weight: 700; padding: 4px 2px; }
  th .dow { font-size: 10px; }
  th .md { font-size: 9px; font-weight: 600; color: #555; }
  th:first-child, td.name { width: 84px; text-align: left; padding-left: 6px; }
  th:last-child, td.total { width: 34px; }
  td { font-weight: 700; }
  td.name { font-weight: 600; font-size: 10.5px; white-space: nowrap; }
  td.total { font-weight: 700; }
  .note { font-size: 7px; font-weight: 700; color: #b91c1c; }
  .staffrow td { background: #f8fafc; color: #555; font-size: 9.5px; border-top: 2px solid #94a3b8; }
  .staffrow td.stafflabel { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .legend { margin-top: 6px; font-size: 8.5px; color: #666; }
</style>
</head>
<body>
<h1>Kitchen Staff</h1>
<p class="range">${range}</p>
<table>
  <thead><tr><th>Employee</th>${headerCells}<th>Shifts</th></tr></thead>
  <tbody>${bodyRows}${staffRow}</tbody>
</table>
<div class="legend">B = Breakfast · L = Lunch · D = Dinner · NO = Requested off · W + letter (e.g. WD) = covering Waitstaff that meal, not counted as kitchen staff · Text (e.g. Inventory) = special full-day assignment · Bottom row = kitchen staff needed per meal (B - L - D)</div>
</body>
</html>`;

    return { html, rangeLabel: range };
  };

  const exportPDF = () => {
    const built = buildScheduleHtml();
    if (!built) return;
    const printableHtml = built.html.replace(
      '</body>',
      '<script>window.onload = function(){ window.print(); };</script></body>'
    );
    const w = window.open('', '_blank');
    if (!w) {
      alert('Please allow pop-ups to export the PDF.');
      return;
    }
    w.document.write(printableHtml);
    w.document.close();
  };

  // Fire-and-forget: sends the just-generated schedule to a server-side endpoint,
  // which emails it in the background. Never blocks or shows anything in the UI —
  // if it fails (no endpoint configured, network error, etc.), it's silently
  // swallowed so schedule generation itself is never affected.
  // Fire-and-forget: sends the just-generated schedule to a server-side endpoint,
  // which emails it in the background. This runs as an effect (keyed on
  // `emailTrigger`, bumped once per successful Generate click) rather than being
  // called directly from `generate()`, because `schedule` is a React state value —
  // reading it synchronously right after `setSchedule()` would still see the OLD
  // value. Waiting for the effect guarantees `buildScheduleHtml()` sees the fresh
  // schedule that was just generated. Never blocks or shows anything in the UI — if
  // it fails (no endpoint configured, network error, etc.), it's silently swallowed
  // so schedule generation itself is never affected. `emailTrigger === 0` is the
  // initial-mount value, so nothing fires until the first real generation.
  useEffect(() => {
    if (emailTrigger === 0) return;
    const built = buildScheduleHtml();
    if (!built) return;
    fetch('/api/send-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: built.html, rangeLabel: built.rangeLabel }),
    }).catch(() => {
      // Intentionally ignored — see comment above.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailTrigger]);

  const btnPrimary = (on = true): React.CSSProperties => ({
    background: on ? '#0e7490' : '#334155',
    color: on ? '#fff' : '#64748b',
    border: 'none',
    borderRadius: 10,
    padding: '11px 28px',
    fontSize: 14,
    fontWeight: 700,
    cursor: on ? 'pointer' : 'default',
  });

  const btnBack: React.CSSProperties = {
    background: '#1e293b',
    border: '1px solid #334155',
    color: '#94a3b8',
    borderRadius: 8,
    padding: '7px 16px',
    cursor: 'pointer',
    fontSize: 13,
  };

  const inputDate: React.CSSProperties = {
    width: '100%',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '10px 14px',
    color: '#f1f5f9',
    fontSize: 15,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const STEPS: Step[] = ['setup', 'staff', 'off', 'result'];
  const stepIdx = STEPS.indexOf(step);

  const ColHeader = ({ d }: { d: string }) => (
    <th style={{ padding: '8px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155', textAlign: 'center', minWidth: 70 }}>
      <div style={{ fontSize: 10 }}>{new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</div>
      <div style={{ fontSize: 11, color: '#cbd5e1' }}>{new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
    </th>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', fontFamily: "'Inter',system-ui,sans-serif", color: '#e2e8f0' }}>
      {/* Header */}
      <div style={{ background: '#1e293b', borderBottom: '1px solid #334155', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 32, height: 32, background: '#0e7490', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🍳</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Ridin Hy Ranch</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>Kitchen Scheduler</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {STEPS.map((s, i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', background: i <= stepIdx ? '#0e7490' : '#334155', color: i <= stepIdx ? '#fff' : '#64748b' }}>
                  {i + 1}
                </div>
                {i < STEPS.length - 1 && <div style={{ width: 14, height: 2, background: i < stepIdx ? '#0e7490' : '#334155' }} />}
              </div>
            ))}
          </div>
          {step === 'result' && (
            <button onClick={exportPDF} style={{ ...btnPrimary(), padding: '8px 16px', fontSize: 13 }}>↓ Export PDF</button>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 16px' }}>

        {/* STEP 1 */}
        {step === 'setup' && (
          <div style={{ maxWidth: 460, margin: '0 auto' }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6, color: '#f8fafc' }}>Select Week</h2>
            <p style={{ color: '#64748b', marginBottom: 28, fontSize: 14 }}>Pick a start date — end date auto-sets to +7 days.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Start date</label>
                <input type="date" value={startDate} onChange={(e) => handleStartChange(e.target.value)} style={inputDate} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>End date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputDate} />
              </div>
            </div>
            {dates.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 13, color: '#64748b' }}>{dates.length} days · {fmt(dates[0])} – {fmt(dates[dates.length - 1])}</div>
            )}
            <button disabled={dates.length === 0} onClick={initStaff} style={{ ...btnPrimary(dates.length > 0), marginTop: 28, width: '100%' }}>
              Next: Staff requirements →
            </button>
          </div>
        )}

        {/* STEP 2 */}
        {step === 'staff' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
              <button onClick={() => setStep('setup')} style={btnBack}>← Back</button>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', margin: 0 }}>Max Staff per Shift</h2>
                <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>Maximum number of kitchen staff needed on each shift. Default 10. Red = unusual value (below 5 or above 16).</p>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '190px repeat(3,1fr)', gap: 8, marginBottom: 8, paddingLeft: 16 }}>
              <div />
              {SHIFTS.map((sh) => (
                <div key={sh} style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#64748b' }}>{sh} — {SHIFT_LABEL[sh]}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dates.map((d) => (
                <div key={d} style={{ display: 'grid', gridTemplateColumns: '190px repeat(3,1fr)', gap: 8, alignItems: 'center', background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#cbd5e1' }}>{fmt(d)}</div>
                  {SHIFTS.map((sh) => {
                    const val = getStaff(d, sh);
                    const warn = staffWarn(val);
                    return (
                      <div key={sh} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                        <input type="number" min={1} max={30} value={val}
                          onChange={(e) => setStaff(d, sh, parseInt(e.target.value) || 0)}
                          style={{ width: 72, textAlign: 'center', padding: '8px', borderRadius: 7, fontSize: 16, fontWeight: 700, outline: 'none', background: warn ? '#450a0a' : '#0f172a', border: `2px solid ${warn ? '#b91c1c' : '#475569'}`, color: warn ? '#fca5a5' : '#f1f5f9' }}
                        />
                        {warn && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 600 }}>Unusual</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                setOffRequests((prev) => {
                  const next = { ...prev };
                  const defaults = buildDefaultOffRequests(dates);
                  for (const name of Object.keys(defaults)) {
                    if (!next[name]) next[name] = {};
                    for (const day of Object.keys(defaults[name])) {
                      // Only fill in the default if this specific person/day has
                      // never been touched — so re-visiting this step never
                      // clobbers a manual change.
                      if (next[name][day] === undefined) {
                        next[name][day] = defaults[name][day];
                      }
                    }
                  }
                  return next;
                });
                setStep('off');
              }}
              style={{ ...btnPrimary(), marginTop: 24 }}
            >
              Next: Off requests →
            </button>
          </div>
        )}

        {/* STEP 3 */}
        {step === 'off' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <button onClick={() => setStep('staff')} style={btnBack}>← Back</button>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', margin: 0 }}>Off Requests</h2>
                <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
                  Toggle a full day off or specific meals. Use <strong style={{ color: '#fca5a5' }}>Week OFF</strong> to mark the entire week at once.
                  {' '}Type in the small box (e.g. <strong style={{ color: '#5eead4' }}>Inventory</strong>, Training) for a special full-day assignment — busy all day, counts as 3 worked shifts, shown verbatim.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { label: 'Week OFF', bg: '#7f1d1d', color: '#fca5a5', border: '#b91c1c' },
                { label: 'Full day OFF', bg: '#450a0a', color: '#fca5a5', border: '#b91c1c' },
                { label: 'Meal OFF', bg: '#422006', color: '#fdba74', border: '#c2410c' },
                { label: 'Working', bg: '#1e293b', color: '#64748b', border: '#334155' },
              ].map(({ label, bg, color, border }) => (
                <span key={label} style={{ background: bg, color, borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600, border: `1px solid ${border}` }}>{label}</span>
              ))}
            </div>

            <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid #334155' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#1e293b' }}>
                    <th style={{ textAlign: 'left', padding: '12px 16px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155', position: 'sticky', left: 0, background: '#1e293b', zIndex: 2, minWidth: 210 }}>
                      Employee
                    </th>
                    {dates.map((d) => <ColHeader key={d} d={d} />)}
                  </tr>
                </thead>
                <tbody>
                  {DEFAULT_EMPLOYEES.map((emp, i) => {
                    const rowBg = i % 2 === 0 ? '#0f172a' : '#0d1117';
                    const weekOff = isFullWeekOff(emp.name);
                    return (
                      <tr key={emp.name} style={{ background: rowBg }}>
                        <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: rowBg, zIndex: 1, borderRight: '1px solid #1e293b' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600 }}>{emp.name}</span>
                          </div>
                          <button
                            onClick={() => toggleFullWeek(emp.name)}
                            style={{
                              marginTop: 4,
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: 4,
                              border: 'none',
                              cursor: 'pointer',
                              background: weekOff ? '#b91c1c' : '#7f1d1d44',
                              color: weekOff ? '#fff' : '#fca5a5',
                            }}
                          >
                            {weekOff ? 'Week OFF ✕' : 'Week OFF?'}
                          </button>
                        </td>
                        {dates.map((d) => {
                          const fullOff = isFullOff(emp.name, d);
                          return (
                            <td key={d} style={{ padding: '5px 3px', textAlign: 'center' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
                                <button
                                  onClick={() => toggleFullDay(emp.name, d)}
                                  style={{ fontSize: 10, fontWeight: 700, padding: '3px 0', borderRadius: 4, border: 'none', cursor: 'pointer', width: '94%', background: fullOff ? '#b91c1c' : '#0f172a', color: fullOff ? '#fff' : '#475569' }}
                                >
                                  {fullOff ? 'OFF ✕' : 'Day off?'}
                                </button>
                                {!fullOff && (
                                  <div style={{ display: 'contents' }}>
                                    <div style={{ display: 'flex', gap: 2 }}>
                                      {SHIFTS.map((sh) => {
                                        const shOff = isShiftOff(emp.name, d, sh);
                                        const shWaitstaff = isWaitstaffShift(emp.name, d, sh);
                                        return (
                                          <button key={sh}
                                            onClick={() => toggleOff(emp.name, d, sh)}
                                            title={
                                              shWaitstaff
                                                ? `Covering Waitstaff for ${SHIFT_LABEL[sh]} — click to return to normal`
                                                : shOff
                                                  ? `${SHIFT_LABEL[sh]} requested off — click for Waitstaff`
                                                  : `Click to request ${SHIFT_LABEL[sh]} off`
                                            }
                                            style={{
                                              fontSize: 10, fontWeight: 700, width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer',
                                              background: shWaitstaff ? '#1e3a5f' : shOff ? '#c2410c' : '#1e293b',
                                              color: shWaitstaff ? '#7dd3fc' : shOff ? '#fff' : '#475569',
                                            }}>
                                            {shWaitstaff ? 'W' + sh : sh}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    <input
                                      value={getCustomDay(emp.name, d)}
                                      onChange={(e) => setCustomDay(emp.name, d, e.target.value)}
                                      placeholder="job…"
                                      style={{
                                        width: '92%',
                                        fontSize: 9,
                                        fontWeight: 700,
                                        padding: '2px 4px',
                                        borderRadius: 4,
                                        border: getCustomDay(emp.name, d).trim() ? '1px solid #14b8a6' : '1px solid #1e293b',
                                        background: getCustomDay(emp.name, d).trim() ? '#134e4a' : '#0f172a',
                                        color: getCustomDay(emp.name, d).trim() ? '#5eead4' : '#64748b',
                                        textAlign: 'center',
                                        outline: 'none',
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button onClick={generate} style={{ ...btnPrimary(), marginTop: 24 }}>Generate schedule →</button>
          </div>
        )}

        {/* STEP 4 */}
        {step === 'result' && schedule && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <button onClick={() => setStep('off')} style={btnBack}>← Back</button>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  Kitchen Schedule · {fmt(schedule.dates[0])} – {fmt(schedule.dates[schedule.dates.length - 1])}
                </h2>
                <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>{schedule.employees.length} kitchen staff · {schedule.dates.length} days</p>
                <p style={{ color: '#64748b', fontSize: 12, margin: '2px 0 0 0' }}>
                  Click any cell to manually edit it — totals update automatically. Edited cells show a <span style={{ color: '#fbbf24' }}>dashed gold outline</span>; click the ✕ to revert.
                </p>
              </div>
            </div>

            {schedule.warnings.length > 0 && (
              <div style={{ background: '#1c1917', border: '1px solid #78350f', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24', marginBottom: 6, letterSpacing: '0.05em' }}>SCHEDULE NOTES</div>
                {schedule.warnings.map((w, i) => (
                  <div key={i} style={{ fontSize: 13, color: '#fcd34d', marginBottom: i < schedule.warnings.length - 1 ? 4 : 0 }}>{w}</div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {['B', 'L', 'D', 'BL', 'LD', 'BD', 'BLD', 'WD', 'Inventory', 'OFF', 'NO'].map((s) => {
                const c = shiftColor(s);
                return (
                  <span key={s} style={{ background: c.bg, color: c.text, borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 700, border: '1px solid #334155' }}>{s}</span>
                );
              })}
            </div>

            <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid #334155' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#1e293b' }}>
                    <th style={{ textAlign: 'left', padding: '12px 16px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: '#1e293b', zIndex: 2 }}>Employee</th>
                    {schedule.dates.map((d) => <ColHeader key={d} d={d} />)}
                    <th style={{ padding: '10px 10px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155', textAlign: 'center', whiteSpace: 'nowrap' }}>Shifts</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.employees.map((emp, i) => {
                    const rowBg = i % 2 === 0 ? '#0f172a' : '#0d1117';
                    return (
                      <tr key={emp.name} style={{ background: rowBg }}>
                        <td style={{ padding: '9px 16px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: rowBg, zIndex: 1, borderRight: '1px solid #1e293b' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{emp.name}</span>
                          </div>
                        </td>
                        {schedule.dates.map((d) => {
                          const isEditing = editingCell?.name === emp.name && editingCell?.day === d;
                          const display = getDisplayShift(emp, d);
                          const isEdited = manualEdits[emp.name]?.[d] !== undefined;
                          const c = shiftColor(display);
                          const partialOff = getPartialOffNote(emp, d, offRequests);

                          if (isEditing) {
                            return (
                              <td key={d} style={{ textAlign: 'center', padding: '4px 3px' }}>
                                <input
                                  autoFocus
                                  defaultValue={display === 'OFF' || display === 'NO' ? '' : display}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveManualEdit(emp.name, d, (e.target as HTMLInputElement).value);
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  onBlur={(e) => saveManualEdit(emp.name, d, e.target.value)}
                                  style={{ width: 44, fontSize: 11, fontWeight: 700, textAlign: 'center', padding: '4px 2px', borderRadius: 6, border: '1px solid #0e7490', background: '#083344', color: '#e2e8f0', outline: 'none' }}
                                />
                              </td>
                            );
                          }
                          return (
                            <td
                              key={d}
                              onClick={() => setEditingCell({ name: emp.name, day: d })}
                              title="Click to manually edit this cell"
                              style={{ textAlign: 'center', padding: '5px 3px', cursor: 'pointer' }}
                            >
                              <span style={{ position: 'relative', display: 'inline-block', background: c.bg, color: c.text, borderRadius: 6, padding: '4px 6px', fontWeight: 700, fontSize: 11, minWidth: 30, outline: isEdited ? '1.5px dashed #fbbf24' : 'none', outlineOffset: 2 }}>
                                {display}
                                {partialOff && !isEdited && (
                                  <span style={{ display: 'block', fontSize: 8, fontWeight: 700, opacity: 0.85, marginTop: 1 }}>
                                    ({partialOff} NO)
                                  </span>
                                )}
                                {isEdited && (
                                  <span
                                    onClick={(e) => { e.stopPropagation(); clearManualEdit(emp.name, d); }}
                                    title="Revert to generated value"
                                    style={{ position: 'absolute', top: -6, right: -6, width: 14, height: 14, borderRadius: '50%', background: '#fbbf24', color: '#1e1b4b', fontSize: 9, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', lineHeight: 1 }}
                                  >
                                    ✕
                                  </span>
                                )}
                              </span>
                            </td>
                          );
                        })}
                        <td style={{ textAlign: 'center', padding: '9px 10px', fontWeight: 700, whiteSpace: 'nowrap', color: '#94a3b8' }}>
                          {getDisplayTotal(emp)}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Staff-per-meal summary row — shows the LIVE current headcount per
                      meal (actual/target), reflecting manual edits and excluding anyone
                      on a custom assignment. Styled to match the shift badges: small
                      and discreet but readable. */}
                  <tr style={{ background: '#1e293b' }}>
                    <td style={{ padding: '7px 16px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: '#1e293b', zIndex: 1, borderRight: '1px solid #1e293b', borderTop: '1px solid #334155' }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>Staff per meal</span>
                    </td>
                    {schedule.dates.map((d) => {
                      const parts = SHIFTS.map((sh) => {
                        const actual = countStaffForMeal(d, sh);
                        const target = getStaff(d, sh);
                        // Flag BOTH directions of deviation — short-staffed (red, more
                        // urgent) and over-staffed (amber, less urgent but still worth
                        // noticing) — not just when short.
                        const color =
                          actual < target ? '#f87171' : actual > target ? '#fbbf24' : '#94a3b8';
                        return { actual, target, color };
                      });
                      return (
                        <td key={d} style={{ textAlign: 'center', padding: '5px 3px', borderTop: '1px solid #334155' }}>
                          <span style={{ display: 'inline-flex', gap: 3, borderRadius: 6, padding: '4px 6px', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>
                            {parts.map((p, idx) => (
                              <span key={idx} style={{ color: p.color }}>
                                {idx > 0 && <span style={{ color: '#475569' }}> - </span>}
                                {p.actual}/{p.target}
                              </span>
                            ))}
                          </span>
                        </td>
                      );
                    })}
                    <td style={{ borderTop: '1px solid #334155' }} />
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(155px,1fr))', gap: 10 }}>
              {[
                { label: 'Total Kitchen Staff', val: schedule.employees.length },
                { label: 'Days', val: schedule.dates.length },
                { label: 'Max Shifts/Person', val: MAX_SHIFTS },
                { label: 'Avg Shifts/Person', val: (schedule.employees.reduce((s, e) => s + getDisplayTotal(e), 0) / schedule.employees.length).toFixed(1) },
              ].map(({ label, val }) => (
                <div key={label} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#f1f5f9' }}>{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
