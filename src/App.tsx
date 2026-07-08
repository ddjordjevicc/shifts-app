import { useState, useMemo } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmployeeDef {
  name: string;
  isHead: boolean;
}
interface EmployeeState extends EmployeeDef {
  shiftsAssigned: number;
  assignedShifts: Record<string, string[]>;
}
type ShiftKey = 'B' | 'L' | 'D';
type OffRequest = Partial<Record<ShiftKey, boolean>>;
interface ScheduleResult {
  employees: EmployeeState[];
  dates: string[];
  warnings: string[];
}
type Step = 'setup' | 'staff' | 'off' | 'result';

// ─── Static data ─────────────────────────────────────────────────────────────

const DEFAULT_EMPLOYEES: EmployeeDef[] = [
  { name: 'Victor', isHead: true },
  { name: 'Nikita', isHead: true },
  { name: 'Anna', isHead: false },
  { name: 'Brooke', isHead: false },
  { name: 'Amelia', isHead: false },
  { name: 'Dogukan', isHead: false },
  { name: 'Mehj', isHead: false },
  { name: 'Lily', isHead: false },
  { name: 'Nevin', isHead: false },
  { name: 'Jaemasen', isHead: false },
  { name: 'Julia', isHead: false },
  { name: 'Mihajlo', isHead: false },
  { name: 'Aleksa', isHead: false },
  { name: 'Veronika', isHead: false },
  { name: 'Gio', isHead: false },
  { name: 'Abby', isHead: false },
  { name: 'Addison', isHead: false },
  { name: 'Roman', isHead: false },
  { name: 'Dusan', isHead: false },
  { name: 'Sven', isHead: false },
  { name: 'Ante', isHead: false },
  { name: 'Cosmin', isHead: false },
  { name: 'Cosmina', isHead: false },
];

const DEFAULT_PAIRS: [string, string][] = [
  ['Nikita', 'Anna'],
  ['Sven', 'Ante'],
];

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

// ─── Engine ───────────────────────────────────────────────────────────────────

function generateSchedule(
  dates: string[],
  required: Record<string, Record<ShiftKey, number>>,
  offRequests: Record<string, Record<string, OffRequest>>,
  pairs: [string, string][],
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

  const primaryToMirror: Record<string, string> = {};
  const mirrorSet = new Set<string>();
  for (const [pri, mir] of pairs) {
    primaryToMirror[pri] = mir;
    mirrorSet.add(mir);
  }

  const byName = (n: string) => employees.find((e) => e.name === n)!;

  const wantsOff = (emp: EmployeeState, day: string, sh: ShiftKey): boolean => {
    const off = offRequests[emp.name]?.[day];
    if (!off) return false;
    return !!(off[sh] || (off.B && off.L && off.D));
  };

  const alreadyOn = (emp: EmployeeState, day: string, sh: ShiftKey) =>
    (emp.assignedShifts[day] || []).includes(sh);

  const canTake = (
    emp: EmployeeState,
    day: string,
    sh: ShiftKey,
    ignoreOff = false
  ): boolean => {
    if (emp.shiftsAssigned >= MAX_SHIFTS) return false;
    if (alreadyOn(emp, day, sh)) return false;
    if (!ignoreOff && wantsOff(emp, day, sh)) return false;
    return true;
  };

  const canTakeBLD = (emp: EmployeeState, day: string): boolean =>
    emp.shiftsAssigned + 3 <= MAX_SHIFTS &&
    SHIFTS.every((sh) => !alreadyOn(emp, day, sh) && !wantsOff(emp, day, sh));

  const assign = (emp: EmployeeState, day: string, sh: ShiftKey) => {
    if (!emp.assignedShifts[day]) emp.assignedShifts[day] = [];
    if (!alreadyOn(emp, day, sh)) {
      emp.assignedShifts[day].push(sh);
      emp.shiftsAssigned++;
    }
  };

  const assignBLD = (emp: EmployeeState, day: string) =>
    SHIFTS.forEach((sh) => assign(emp, day, sh));

  const syncMirror = (primaryName: string, day: string) => {
    const mirrorName = primaryToMirror[primaryName];
    if (!mirrorName) return;
    const mirror = byName(mirrorName);
    const primary = byName(primaryName);
    mirror.shiftsAssigned -= (mirror.assignedShifts[day] || []).length;
    mirror.assignedShifts[day] = [];
    for (const sh of (primary.assignedShifts[day] || []) as ShiftKey[]) {
      if (mirror.shiftsAssigned < MAX_SHIFTS) {
        mirror.assignedShifts[day].push(sh);
        mirror.shiftsAssigned++;
      }
    }
  };

  const assignAndSync = (
    emp: EmployeeState,
    day: string,
    sh: ShiftKey | 'BLD'
  ) => {
    if (sh === 'BLD') assignBLD(emp, day);
    else assign(emp, day, sh);
    if (primaryToMirror[emp.name]) syncMirror(emp.name, day);
  };

  const activeEmps = employees.filter((e) => !mirrorSet.has(e.name));
  const headPool = activeEmps.filter((e) => e.isHead);
  const otherPool = activeEmps.filter((e) => !e.isHead);

  const pick = (pool: EmployeeState[], pred: (e: EmployeeState) => boolean) =>
    pool.filter(pred).sort((a, b) => a.shiftsAssigned - b.shiftsAssigned)[0] ||
    null;

  // PRE-PLANNING PASS
  for (const day of dates) {
    for (const sh of SHIFTS) {
      if (headPool.some((h) => alreadyOn(h, day, sh))) continue;

      const headsSorted = [...headPool].sort(
        (a, b) =>
          MAX_SHIFTS - b.shiftsAssigned - (MAX_SHIFTS - a.shiftsAssigned)
      );

      let placed = false;

      if (!placed && rem[day].B > 0 && rem[day].L > 0 && rem[day].D > 0) {
        for (const h of headsSorted) {
          if (canTakeBLD(h, day)) {
            assignAndSync(h, day, 'BLD');
            rem[day].B--;
            rem[day].L--;
            rem[day].D--;
            placed = true;
            break;
          }
        }
      }

      if (placed) continue;

      for (const h of headsSorted) {
        if (canTake(h, day, sh)) {
          assignAndSync(h, day, sh);
          if (rem[day][sh] > 0) rem[day][sh]--;
          placed = true;
          break;
        }
      }

      if (placed) continue;

      for (const h of headsSorted) {
        if (canTake(h, day, sh, true)) {
          assignAndSync(h, day, sh);
          if (rem[day][sh] > 0) rem[day][sh]--;
          warnings.push(
            `📋 ${h.name}: off overridden for ${SHIFT_LABEL[sh]} on ${fmt(day)} — Head Waiter required every meal`
          );
          placed = true;
          break;
        }
      }

      if (!placed) {
        warnings.push(
          `⚠️ IMPOSSIBLE: Both Head Waiters are at the ${MAX_SHIFTS}-shift limit. Cannot cover ${SHIFT_LABEL[sh]} on ${fmt(day)}.`
        );
      }
    }
    for (const pri of Object.keys(primaryToMirror)) syncMirror(pri, day);
  }

  // FILL PASS
  for (const day of dates) {
    const bldRem = () => Math.min(rem[day].B, rem[day].L, rem[day].D);

    while (bldRem() > 0) {
      const h = pick(headPool, (e) => canTakeBLD(e, day));
      if (!h) break;
      assignAndSync(h, day, 'BLD');
      rem[day].B--;
      rem[day].L--;
      rem[day].D--;
    }
    while (bldRem() > 0) {
      const o = pick(otherPool, (e) => canTakeBLD(e, day));
      if (!o) break;
      assignAndSync(o, day, 'BLD');
      rem[day].B--;
      rem[day].L--;
      rem[day].D--;
    }
    for (const sh of SHIFTS) {
      while (rem[day][sh] > 0) {
        const fh = pick(headPool, (e) => canTake(e, day, sh));
        if (fh) { assignAndSync(fh, day, sh); rem[day][sh]--; continue; }
        const fo = pick(otherPool, (e) => canTake(e, day, sh));
        if (fo) { assignAndSync(fo, day, sh); rem[day][sh]--; continue; }
        break;
      }
    }
    for (const pri of Object.keys(primaryToMirror)) syncMirror(pri, day);
  }

  // Top up Nikita
  const nikita = byName('Nikita');
  if (nikita) {
    outer: for (const day of dates) {
      if (nikita.shiftsAssigned >= MAX_SHIFTS) break;
      if (canTakeBLD(nikita, day)) {
        assignBLD(nikita, day);
        syncMirror('Nikita', day);
        continue;
      }
      for (const sh of SHIFTS) {
        if (nikita.shiftsAssigned >= MAX_SHIFTS) break outer;
        if (canTake(nikita, day, sh)) {
          assign(nikita, day, sh);
          syncMirror('Nikita', day);
        }
      }
    }
  }

  for (const day of dates)
    for (const pri of Object.keys(primaryToMirror)) syncMirror(pri, day);

  for (const day of dates) {
    for (const sh of SHIFTS) {
      if (!headPool.some((h) => alreadyOn(h, day, sh)))
        warnings.push(`⚠️ VERIFY FAIL: No head waiter on ${SHIFT_LABEL[sh]} — ${fmt(day)}`);
    }
  }

  return { employees, warnings };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

// NO  = employee requested this day off
// OFF = algorithm assigned a rest day (no off request, just no shifts given)
function getShiftStr(
  emp: EmployeeState,
  day: string,
  offRequests: Record<string, Record<string, OffRequest>>
): string {
  const s = emp.assignedShifts[day];
  if (!s || s.length === 0) {
    const off = offRequests[emp.name]?.[day];
    const requestedOff = off && (off.B || off.L || off.D);
    return requestedOff ? 'NO' : 'OFF';
  }
  return SHIFTS.filter((sh) => s.includes(sh)).join('');
}

const shiftColor = (str: string): { bg: string; text: string } => {
  if (str === 'NO')  return { bg: '#450a0a', text: '#f87171' }; // requested off — dark red
  if (str === 'OFF') return { bg: '#1e293b', text: '#475569' }; // algorithm rest — dark slate
  if (str === 'BLD') return { bg: '#7c3aed', text: '#fff' };
  if (str === 'BL')  return { bg: '#2563eb', text: '#fff' };
  if (str === 'LD')  return { bg: '#059669', text: '#fff' };
  if (str === 'BD')  return { bg: '#0891b2', text: '#fff' };
  if (str === 'B')   return { bg: '#0ea5e9', text: '#fff' };
  if (str === 'L')   return { bg: '#16a34a', text: '#fff' };
  if (str === 'D')   return { bg: '#d97706', text: '#fff' };
  return { bg: '#334155', text: '#e2e8f0' };
};

// ─── App ──────────────────────────────────────────────────────────────────────

export default function ShiftsApp() {
  const today = new Date().toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDays(today, 6));
  const [staffInput, setStaffInput] = useState<Record<string, Record<ShiftKey, number>>>({});
  const [offRequests, setOffRequests] = useState<Record<string, Record<string, OffRequest>>>({});
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const [step, setStep] = useState<Step>('setup');
  const [pairs, setPairs] = useState<[string, string][]>(DEFAULT_PAIRS);
  const [showPairs, setShowPairs] = useState(false);
  const [newPri, setNewPri] = useState('');
  const [newMir, setNewMir] = useState('');

  const dates = useMemo(() => {
    if (!startDate || !endDate || startDate > endDate) return [];
    return getDatesInRange(startDate, endDate);
  }, [startDate, endDate]);

  const handleStartChange = (val: string) => {
    setStartDate(val);
    setEndDate(addDays(val, 6));
  };

  const usedInPair = useMemo(() => {
    const s = new Set<string>();
    for (const [p, m] of pairs) { s.add(p); s.add(m); }
    return s;
  }, [pairs]);

  const pairMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [p, mi] of pairs) { m[p] = mi; m[mi] = p; }
    return m;
  }, [pairs]);

  const mirrorSet = useMemo(() => new Set(pairs.map(([, m]) => m)), [pairs]);

  const addPair = () => {
    if (!newPri || !newMir || newPri === newMir) return;
    setPairs((p) => [...p, [newPri, newMir]]);
    setNewPri('');
    setNewMir('');
  };
  const removePair = (idx: number) =>
    setPairs((p) => p.filter((_, i) => i !== idx));

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

  const toggleOff = (name: string, date: string, sh: ShiftKey) =>
    setOffRequests((p) => ({
      ...p,
      [name]: { ...p[name], [date]: { ...p[name]?.[date], [sh]: !p[name]?.[date]?.[sh] } },
    }));

  const toggleFullDay = (name: string, date: string) =>
    setOffRequests((p) => {
      const allOff = SHIFTS.every((sh) => p[name]?.[date]?.[sh]);
      return { ...p, [name]: { ...p[name], [date]: { B: !allOff, L: !allOff, D: !allOff } } };
    });

  // CHANGE 2: Toggle ALL days off for an employee at once
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

  const generate = () => {
    const required: Record<string, Record<ShiftKey, number>> = {};
    dates.forEach((d) => {
      required[d] = { B: getStaff(d, 'B'), L: getStaff(d, 'L'), D: getStaff(d, 'D') };
    });
    const { employees, warnings } = generateSchedule(dates, required, offRequests, pairs, DEFAULT_EMPLOYEES);
    setSchedule({ employees, dates, warnings });
    setStep('result');
  };

  const exportCSV = () => {
    if (!schedule) return;
    const rows = [['Name', 'Head Waiter', ...schedule.dates, 'Total Shifts']];
    schedule.employees.forEach((e) =>
      rows.push([
        e.name,
        e.isHead ? 'Yes' : 'No',
        ...schedule.dates.map((d) => getShiftStr(e, d, offRequests)),
        String(e.shiftsAssigned),
      ])
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' })
    );
    a.download = `shifts-${schedule.dates[0]}.csv`;
    a.click();
  };

  const btnPrimary = (on = true): React.CSSProperties => ({
    background: on ? '#7c3aed' : '#334155',
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

  const selectStyle: React.CSSProperties = {
    background: '#0f172a',
    border: '1px solid #475569',
    borderRadius: 8,
    padding: '8px 12px',
    color: '#f1f5f9',
    fontSize: 13,
    outline: 'none',
    flex: 1,
  };

  const STEPS: Step[] = ['setup', 'staff', 'off', 'result'];
  const stepIdx = STEPS.indexOf(step);

  const HeadBadge = () => (
    <span style={{ background: '#7c3aed22', color: '#a78bfa', fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 4, border: '1px solid #7c3aed44' }}>
      HEAD
    </span>
  );

  const PairBadge = ({ name }: { name: string }) => {
    const partner = pairMap[name];
    if (!partner) return null;
    return (
      <span style={{ background: '#06402B', color: '#4ade80', fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 4, border: '1px solid #16a34a55' }}>
        ↔ {partner}
      </span>
    );
  };

  const ColHeader = ({ d }: { d: string }) => (
    <th style={{ padding: '8px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155', textAlign: 'center', minWidth: 70 }}>
      <div style={{ fontSize: 10 }}>{new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</div>
      <div style={{ fontSize: 11, color: '#cbd5e1' }}>{new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
    </th>
  );

  const PairsModal = () => (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) setShowPairs(false); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 28, width: 440, maxWidth: '92vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#f8fafc' }}>Paired Schedules</h3>
          <button onClick={() => setShowPairs(false)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 0, marginBottom: 20 }}>
          Paired employees always share the same shifts. The <strong style={{ color: '#cbd5e1' }}>primary</strong> is scheduled normally; the <strong style={{ color: '#4ade80' }}>mirror</strong> copies them automatically.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {pairs.length === 0 && (
            <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>No pairs configured</div>
          )}
          {pairs.map(([pri, mir], idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: '#e2e8f0' }}>{pri}</span>
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 6 }}>primary</span>
              </div>
              <span style={{ color: '#4ade80', fontWeight: 900, fontSize: 16 }}>↔</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: '#4ade80' }}>{mir}</span>
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 6 }}>mirror</span>
              </div>
              <button onClick={() => removePair(idx)} style={{ background: '#450a0a', border: 'none', color: '#fca5a5', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid #334155', paddingTop: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 10, letterSpacing: '0.05em' }}>ADD NEW PAIR</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <select value={newPri} onChange={(e) => setNewPri(e.target.value)} style={selectStyle}>
              <option value="">Primary…</option>
              {DEFAULT_EMPLOYEES.filter((e) => !usedInPair.has(e.name) && e.name !== newMir).map((e) => (
                <option key={e.name} value={e.name}>{e.name}{e.isHead ? ' (HEAD)' : ''}</option>
              ))}
            </select>
            <span style={{ color: '#4ade80', fontWeight: 900, fontSize: 18 }}>↔</span>
            <select value={newMir} onChange={(e) => setNewMir(e.target.value)} style={selectStyle}>
              <option value="">Mirror…</option>
              {DEFAULT_EMPLOYEES.filter((e) => !usedInPair.has(e.name) && e.name !== newPri).map((e) => (
                <option key={e.name} value={e.name}>{e.name}{e.isHead ? ' (HEAD)' : ''}</option>
              ))}
            </select>
          </div>
          <button
            onClick={addPair}
            disabled={!newPri || !newMir || newPri === newMir}
            style={{ ...btnPrimary(!!(newPri && newMir && newPri !== newMir)), width: '100%', padding: '10px' }}
          >
            {newPri && newMir && newPri !== newMir ? `+ Pair ${newPri} ↔ ${newMir}` : 'Select two employees above'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', fontFamily: "'Inter',system-ui,sans-serif", color: '#e2e8f0' }}>
      {showPairs && <PairsModal />}

      {/* Header */}
      <div style={{ background: '#1e293b', borderBottom: '1px solid #334155', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 32, height: 32, background: '#7c3aed', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>⬡</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Ridin Hy Ranch</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>Shift Scheduler</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setShowPairs(true)} style={{ background: '#06402B', border: '1px solid #16a34a55', color: '#4ade80', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            ↔ Pairs ({pairs.length})
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {STEPS.map((s, i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', background: i <= stepIdx ? '#7c3aed' : '#334155', color: i <= stepIdx ? '#fff' : '#64748b' }}>
                  {i + 1}
                </div>
                {i < STEPS.length - 1 && <div style={{ width: 14, height: 2, background: i < stepIdx ? '#7c3aed' : '#334155' }} />}
              </div>
            ))}
          </div>
          {step === 'result' && (
            <button onClick={exportCSV} style={{ ...btnPrimary(), padding: '8px 16px', fontSize: 13 }}>↓ Export CSV</button>
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
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', margin: 0 }}>Staff per Shift</h2>
                <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>Default 10. Red = unusual value (below 5 or above 16).</p>
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
                          style={{ width: 72, textAlign: 'center', padding: '8px', borderRadius: 7, fontSize: 16, fontWeight: 700, outline: 'none', background: warn ? '#450a0a' : '#0f172a', border: `2px solid ${warn ? '#dc2626' : '#475569'}`, color: warn ? '#fca5a5' : '#f1f5f9' }}
                        />
                        {warn && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 600 }}>Unusual</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <button onClick={() => setStep('off')} style={{ ...btnPrimary(), marginTop: 24 }}>Next: Off requests →</button>
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
                  Mirror employees (↔) are auto-synced. Head Waiter off requests may be overridden if needed.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { label: 'Week OFF', bg: '#7f1d1d', color: '#fca5a5', border: '#dc2626' },
                { label: 'Full day OFF', bg: '#450a0a', color: '#fca5a5', border: '#dc2626' },
                { label: 'Meal OFF', bg: '#422006', color: '#fdba74', border: '#ea580c' },
                { label: 'Working', bg: '#1e293b', color: '#64748b', border: '#334155' },
                { label: '↔ Auto-mirror', bg: '#06402B', color: '#4ade80', border: '#16a34a' },
              ].map(({ label, bg, color, border }) => (
                <span key={label} style={{ background: bg, color, borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600, border: `1px solid ${border}` }}>{label}</span>
              ))}
            </div>

            <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid #334155' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#1e293b' }}>
                    {/* CHANGE 2: employee column header now also has "Week OFF" sub-header */}
                    <th style={{ textAlign: 'left', padding: '12px 16px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #334155', position: 'sticky', left: 0, background: '#1e293b', zIndex: 2, minWidth: 210 }}>
                      Employee
                    </th>
                    {dates.map((d) => <ColHeader key={d} d={d} />)}
                  </tr>
                </thead>
                <tbody>
                  {DEFAULT_EMPLOYEES.map((emp, i) => {
                    const isMirror = mirrorSet.has(emp.name);
                    const rowBg = i % 2 === 0 ? '#0f172a' : '#0d1117';
                    const weekOff = isFullWeekOff(emp.name);
                    return (
                      <tr key={emp.name} style={{ background: rowBg, opacity: isMirror ? 0.5 : 1 }}>
                        <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: rowBg, zIndex: 1, borderRight: '1px solid #1e293b' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 600 }}>{emp.name}</span>
                            {emp.isHead && <HeadBadge />}
                            <PairBadge name={emp.name} />
                          </div>
                          {/* CHANGE 2: Week OFF button under employee name */}
                          {!isMirror && (
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
                                background: weekOff ? '#dc2626' : '#7f1d1d44',
                                color: weekOff ? '#fff' : '#fca5a5',
                              }}
                            >
                              {weekOff ? 'Week OFF ✕' : 'Week OFF?'}
                            </button>
                          )}
                        </td>
                        {dates.map((d) => {
                          if (isMirror)
                            return (
                              <td key={d} style={{ textAlign: 'center', padding: '6px 4px' }}>
                                <div style={{ fontSize: 10, color: '#334155', fontStyle: 'italic' }}>auto</div>
                              </td>
                            );
                          const fullOff = isFullOff(emp.name, d);
                          return (
                            <td key={d} style={{ padding: '5px 3px', textAlign: 'center' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
                                <button
                                  onClick={() => toggleFullDay(emp.name, d)}
                                  style={{ fontSize: 10, fontWeight: 700, padding: '3px 0', borderRadius: 4, border: 'none', cursor: 'pointer', width: '94%', background: fullOff ? '#dc2626' : '#0f172a', color: fullOff ? '#fff' : '#475569' }}
                                >
                                  {fullOff ? 'OFF ✕' : 'Day off?'}
                                </button>
                                {!fullOff && (
                                  <div style={{ display: 'flex', gap: 2 }}>
                                    {SHIFTS.map((sh) => {
                                      const shOff = isShiftOff(emp.name, d, sh);
                                      return (
                                        <button key={sh} onClick={() => toggleOff(emp.name, d, sh)}
                                          style={{ fontSize: 10, fontWeight: 700, width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', background: shOff ? '#ea580c' : '#1e293b', color: shOff ? '#fff' : '#475569' }}>
                                          {sh}
                                        </button>
                                      );
                                    })}
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
            <button onClick={generate} style={{ ...btnPrimary(), marginTop: 24 }}>Generate Schedule →</button>
          </div>
        )}

        {/* STEP 4 */}
        {step === 'result' && schedule && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <button onClick={() => setStep('off')} style={btnBack}>← Back</button>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  Schedule · {fmt(schedule.dates[0])} – {fmt(schedule.dates[schedule.dates.length - 1])}
                </h2>
                <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>{schedule.employees.length} employees · {schedule.dates.length} days</p>
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
              {['B', 'L', 'D', 'BL', 'LD', 'BD', 'BLD', 'OFF', 'NO'].map((s) => {
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
                    const hasPair = !!pairMap[emp.name];
                    const base = i % 2 === 0 ? '#0f172a' : '#0d1117';
                    const rowBg = hasPair ? (i % 2 === 0 ? '#0f1a14' : '#0b1510') : base;
                    return (
                      <tr key={emp.name} style={{ background: rowBg }}>
                        <td style={{ padding: '9px 16px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: rowBg, zIndex: 1, borderRight: '1px solid #1e293b' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{emp.name}</span>
                            {emp.isHead && <HeadBadge />}
                            <PairBadge name={emp.name} />
                          </div>
                        </td>
                        {schedule.dates.map((d) => {
                          const s = getShiftStr(emp, d, offRequests);
                          const c = shiftColor(s);
                          return (
                            <td key={d} style={{ textAlign: 'center', padding: '5px 3px' }}>
                              <span style={{ display: 'inline-block', background: c.bg, color: c.text, borderRadius: 6, padding: '4px 6px', fontWeight: 700, fontSize: 11, minWidth: 30 }}>{s}</span>
                            </td>
                          );
                        })}
                        <td style={{ textAlign: 'center', padding: '9px 10px', fontWeight: 700, color: emp.isHead ? '#a78bfa' : '#94a3b8' }}>
                          {emp.shiftsAssigned}
                          {emp.isHead && emp.shiftsAssigned !== MAX_SHIFTS && (
                            <span style={{ fontSize: 10, color: '#f87171', marginLeft: 4 }}>≠{MAX_SHIFTS}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(155px,1fr))', gap: 10 }}>
              {[
                { label: 'Total Staff', val: schedule.employees.length },
                { label: 'Head Waiters', val: schedule.employees.filter((e) => e.isHead).length },
                { label: 'Days', val: schedule.dates.length },
                { label: 'Max Shifts/Person', val: MAX_SHIFTS },
                { label: 'Avg Shifts/Person', val: (schedule.employees.reduce((s, e) => s + e.shiftsAssigned, 0) / schedule.employees.length).toFixed(1) },
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
