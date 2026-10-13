import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Plugin } from 'vite';
import type { ClassSession, GiftCard, Student } from '../../types';
import type { OpsContext } from '../../context/data/shared';

export const mixedIds = {
  session: '10000000-0000-0000-0000-000000000001', sede: '20000000-0000-0000-0000-000000000001',
  mesa: '30000000-0000-0000-0000-000000000001', torno: '30000000-0000-0000-0000-000000000002',
  mesaBlock: '40000000-0000-0000-0000-000000000001', tornoBlock: '40000000-0000-0000-0000-000000000002',
  mesaTeacher: '50000000-0000-0000-0000-000000000001', tornoTeacher: '50000000-0000-0000-0000-000000000002',
  manual: '60000000-0000-0000-0000-000000000001', gift: '70000000-0000-0000-0000-000000000001'
};
export const mixedSession: ClassSession = {
  id: mixedIds.session, sedeId: mixedIds.sede, revision: 7, attendancePolicyVersion: 2,
  date: '2026-10-12', startTime: '10:00', endTime: '12:00', classType: 'mixto', capacity: 6,
  students: ['Alex Same', 'Alex Same'], studentIds: [mixedIds.mesa, mixedIds.torno], sessionAudience: 'ambos',
  manualCreditIdByStudentId: { [mixedIds.mesa]: mixedIds.manual }, giftCardIdByStudentId: { [mixedIds.torno]: mixedIds.gift },
  activityBlocks: [
    { id: mixedIds.mesaBlock, activityType: 'mesa', teacherId: mixedIds.mesaTeacher, capacity: 4, studentIds: [mixedIds.mesa] },
    { id: mixedIds.tornoBlock, activityType: 'torno', teacherId: mixedIds.tornoTeacher, capacity: 2, studentIds: [mixedIds.torno] }
  ],
  businessStateByStudentId: Object.fromEntries(([
    [mixedIds.mesa, 'mesa', mixedIds.mesaBlock, mixedIds.mesaTeacher, 4],
    [mixedIds.torno, 'torno', mixedIds.tornoBlock, mixedIds.tornoTeacher, 2]
  ] as const).map(([id, activity, block, teacher, capacity]) => [id, { reservationState: 'reserved', billingState: 'unfinalized',
    fundingActivityType: activity, fundingActivityBlockId: block, activityTeacherId: teacher, activityCapacity: capacity, activitySourceVerified: true }]))
};
export const mixedSessionIsolationPlugin = (): Plugin => ({
  name: 'mixed-session-local-only', enforce: 'pre',
  resolveId(source) {
    if (/supabaseClient(?:\.ts)?$/.test(source)) return '\0mixed-session-client';
    if (/(?:^|\/)toast(?:\.ts)?$/.test(source)) return '\0mixed-session-toast';
    if (/supabase-js|AuthContext|DataContext/.test(source)) throw new Error(`Forbidden mixed harness import: ${source}`);
  },
  load(id) {
    if (id === '\0mixed-session-client') return 'export { supabase } from "/tests/fixtures/mixed-session-ops-harness.tsx";';
    if (id === '\0mixed-session-toast') return 'export const showError = message => window.__mixed.errors.push(message); export const showWarning = showError;';
  }
});

const transport = async (request: any) => {
  const response = await fetch('/__mixed-session-ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw new Error('Synthetic response loss');
  return response.json();
};
export const supabase = {
  from(table: string): never { throw new Error(`Standalone table access forbidden: ${table}`); },
  rpc: (name: string, args: any) => transport({ kind: 'rpc', name, args })
};

if (typeof window !== 'undefined') void Promise.all([
  import('../../context/data/sessionOps'), import('../../context/data/sessionAttendanceOps'),
  import('../../utils/sessionBusiness'), import('../../utils/studentCredits'), import('../../components/CalendarView')
]).then(([ops, intents, business, credits, calendar]) => {
  let session = structuredClone(mixedSession);
  let lifetime = 1;
  const errors: string[] = [];
  const uiSaves: any[] = [];
  const manual = { id: mixedIds.manual, studentId: mixedIds.mesa, sedeId: mixedIds.sede, mode: 'new_manual' as const,
    activity: 'mesa' as const, allocatedClasses: 4, remainingClasses: 3, startsOn: '2026-06-01', endsOn: '2026-12-31',
    reason: 'Original approval', evidence: 'Original evidence', approvedBy: 'owner', approvedAt: '2026-06-01T12:00:00Z' };
  const students: Student[] = [mixedIds.mesa, mixedIds.torno].map(id => ({ id, sedeId: mixedIds.sede,
    name: 'Alex', surname: 'Same', phone: '', status: 'new', classesRemaining: 0, legacyManualBalance: 0,
    studentCategory: 'temporal', manualCredits: id === mixedIds.mesa ? [manual] : [] }));
  const gifts: GiftCard[] = [{ id: mixedIds.gift, sedeId: mixedIds.sede, buyer: 'Sender', recipient: 'Alex Same',
    recipientStudentId: mixedIds.torno, numClasses: 4, sessionsUsed: 1, sessionsRemaining: 3, type: 'torno',
    paymentStatus: 'paid', status: 'active', activatedAt: '2026-06-01', expiryDate: '2026-12-31', createdAt: '2026-06-01T12:00:00Z' }];
  const context = (): OpsContext => {
    const captured = lifetime;
    const assertScope = () => { if (captured !== lifetime) throw new Error('Mixed scope lifetime changed'); };
    const noSetter = () => { throw new Error('No receipt snapshot may be applied to live state'); };
    return { sedeId: mixedIds.sede, assertScope, students, sessions: [structuredClone(session)], giftCards: gifts,
      capacityDefaults: [], pieces: [], isSuperAdmin: false, operationLockRef: { current: false },
      setStudents: noSetter, setSessions: noSetter, setGiftCards: noSetter, setTeachers: noSetter, setPieces: noSetter,
      setInventoryItems: noSetter, setInventoryMovements: noSetter,
      safeReload: async () => {
        const response = await transport({ kind: 'refresh' });
        assertScope();
        if (response.error) throw new Error(response.error.message);
        if (response.session) session = response.session;
      }
    };
  };
  (window as any).__mixed = {
    errors, configure: (value: any) => { if (value.session) session = value.session; if (value.invalidate) lifetime++; },
    snapshot: () => ({ session, uiSaves, storage: Object.fromEntries(Object.entries(sessionStorage)) }),
    run: async (name: string, args: any[] = []) => {
      try { return { ok: true, value: await (ops as any)[name](context(), ...args) }; }
      catch (error: any) { return { ok: false, error: error.message }; }
    },
    intent: (value: any) => {
      const intent = intents.createSessionReservationIntent(mixedIds.session, 7, mixedIds.sede, value.metadata,
        value.studentIds, value.gifts, 'original-input', 'original-key', value.manual, value.blocks);
      const before = JSON.stringify(intent);
      value.metadata.nested = { changed: true };
      value.studentIds.reverse(); value.gifts[mixedIds.torno] = 'changed'; value.manual[mixedIds.mesa] = 'changed';
      if (value.blocks?.length) { value.blocks[0].student_ids.push('changed'); value.blocks[0].teacher_id = 'changed'; }
      return { args: intent.args, stable: before === JSON.stringify(intent), callerEditable: !Object.isFrozen(value.metadata),
        frozen: Object.isFrozen(intent.args) && Object.isFrozen(intent.args.p_metadata)
          && Object.isFrozen(intent.args.p_student_ids) && Object.isFrozen(intent.args.p_gift_card_ids)
          && Object.isFrozen(intent.args.p_manual_credit_ids) && (!intent.args.p_activity_blocks
            || (Object.isFrozen(intent.args.p_activity_blocks) && intent.args.p_activity_blocks.every((block: any) => Object.isFrozen(block) && Object.isFrozen(block.student_ids)))) };
    },
    availability: (changes: any = {}) => {
      const source = { ...structuredClone(mixedSession), completedAt: '2026-10-12T12:00:00Z', ...changes };
      const profiles = students.map(student => {
        const isManual = student.id === mixedIds.mesa;
        const penaltyId = `penalty-${student.id}`;
        Object.assign(source.businessStateByStudentId![student.id], { penaltyId, penaltyState: 'pending', billingState: 'incident',
          billingKind: 'no_show', finalizedRevision: 5, fundingManualCreditId: isManual ? mixedIds.manual : undefined,
          fundingGiftCardId: isManual ? undefined : mixedIds.gift });
        return { student_id: student.id, sede_id: student.sedeId, legacy_observed_balance: 0,
          legacy_raw_state: { id: student.id, sede_id: student.sedeId, classes_remaining: 0, current_membership_period_id: null, student_category: 'temporal' },
          can_reconcile_legacy: false, can_approve_manual_credit: true,
          manual_credits: isManual ? [{ entitlement_id: manual.id, student_id: student.id, sede_id: student.sedeId,
            mode: manual.mode, quantity: 4, remaining_classes: 3, activity: 'mesa', starts_on: manual.startsOn, ends_on: manual.endsOn,
            reason: manual.reason, evidence: manual.evidence, approved_by: manual.approvedBy, approved_at: manual.approvedAt }] : [],
          penalty_incidents: [{ penalty_id: penaltyId, student_id: student.id, sede_id: student.sedeId,
            session_id: source.id, expected_revision: 7, incident_revision: 5, kind: 'no_show', penalty_state: 'pending',
            original_period_id: null, original_gift_card_id: isManual ? null : mixedIds.gift,
            original_manual_credit_id: isManual ? mixedIds.manual : null, incident_reason: 'Original incident', is_pending: true, is_waived: false }]
        };
      });
      return credits.attachStudentCreditProfiles(students, profiles, [source], gifts, '2026-10-12').map(student => student.pendingPenalties![0]);
    },
    attachBusiness: (rows: any[]) => business.attachSessionBusinessState(session, rows),
    render: (readOnly = false) => createRoot(document.getElementById('root')!).render(<MemoryRouter><calendar.default
      readOnly={readOnly} sessions={[session]} students={students} giftCards={gifts}
      teachers={[{ id: mixedIds.mesaTeacher, name: 'Mesa Teacher' }, { id: mixedIds.tornoTeacher, name: 'Torno Teacher' }]}
      workshopSchedule={[]} workshopScheduleExceptions={[]} capacityDefaults={[]}
      onAddSession={async value => { uiSaves.push(value); }} onUpdateSession={async (id, value) => { uiSaves.push({ id, ...value }); return true; }}
    /></MemoryRouter>)
  };
  document.body.dataset.ready = 'true';
});
