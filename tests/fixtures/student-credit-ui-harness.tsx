import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import StudentList from '../../components/StudentList';
import type { Student, ManualCreditIntent, PenaltySettlementIntent, SessionBusinessIntent, PendingStudentCreditOperation } from '../../types';

const studentId = '20000000-0000-0000-0000-000000000001';
const otherId = '20000000-0000-0000-0000-000000000002';
const sedeId = '10000000-0000-0000-0000-000000000001';
const sessionId = '30000000-0000-0000-0000-000000000001';
const penaltyId = '40000000-0000-0000-0000-000000000001';
const originalId = '50000000-0000-0000-0000-000000000001';
const currentId = '50000000-0000-0000-0000-000000000002';
const actorId = '60000000-0000-0000-0000-000000000001';
const settlementId = '70000000-0000-0000-0000-000000000001';
const initialStudents: Student[] = [studentId, otherId].map(id => ({
  id, sedeId, name: 'Alex', surname: 'Perez', phone: id === studentId ? '111' : '222',
  classesRemaining: 4, legacyManualBalance: 4, bonosAsignados: 4, status: 'new',
  studentCategory: 'temporal', paymentStatus: null, manualCredits: [],
  pendingPenalties: [{ id: id === studentId ? penaltyId : '40000000-0000-0000-0000-000000000002',
    studentId: id, sedeId, sessionId, sessionDate: '2026-10-11', sessionStart: '18:00', sessionRevision: 7,
    kind: 'no_show', state: 'pending', originalGiftCardId: originalId, reason: 'Sin credito valido al finalizar', canSettle: true }]
}));
type Intent = ManualCreditIntent | PenaltySettlementIntent | SessionBusinessIntent;
interface StoredOperation { descriptor: PendingStudentCreditOperation; input: Intent }
const sqlError = (message: string, code = 'P0001') => Object.assign(new Error(message), { code });

// Synthetic callback/receipt store only. This fixture is not SQL/API permission evidence.
// It remains mounted while StudentList is removed, matching the main-owned recovery boundary.
const Harness = () => {
  const [students, setStudents] = useState(initialStudents);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [ledger, setLedger] = useState<unknown[]>([]);
  const [forbiddenCalls, setForbiddenCalls] = useState<string[]>([]);
  const [pendingDescriptors, setPendingDescriptors] = useState<PendingStudentCreditOperation[]>([]);
  const [retryCalls, setRetryCalls] = useState<unknown[]>([]);
  const [sourceBalance, setSourceBalance] = useState(3);
  const [mounted, setMounted] = useState(true);
  const [ownerHint, setOwnerHint] = useState(true);
  const [callbacks, setCallbacks] = useState({ approve: true, settle: true, waive: true, getter: true, retry: true });
  const persisted = useRef(structuredClone(initialStudents));
  const operations = useRef(new Map<string, StoredOperation>());
  const receipts = useRef(new Map<string, string>());
  const behavior = useRef('success');
  const actor = useRef('owner');
  const source = useRef({ id: originalId, valid: true, remaining: 3 });
  const previous = useRef<Intent | null>(null);
  const publishPending = () => setPendingDescriptors([...operations.current.values()].map(item => item.descriptor));
  const publish = () => setStudents(structuredClone(persisted.current));
  const refresh = async () => {
    if (['refresh-failure', 'unmount-refresh-failure', 'rollback-refresh-failure'].includes(behavior.current)) {
      if (behavior.current === 'unmount-refresh-failure') setMounted(false);
      throw new Error('Recarga sintetica perdida tras commit.');
    }
    if (behavior.current === 'deferred-refresh') await new Promise<void>(resolve => window.addEventListener('credit-test-refresh', () => resolve(), { once: true }));
    publish();
  };
  const execute = async (stored: StoredOperation) => {
    const { input, descriptor } = stored;
    setCalls(items => [...items, { operation: descriptor.operation, input,
      frozen: Object.isFrozen(input), sameObjectAsPrevious: previous.current === input }]);
    previous.current = input;
    const existing = operations.current.get(input.studentId);
    if (existing && existing.input !== input) throw new Error('No sustituir el intento pendiente.');
    operations.current.set(input.studentId, stored);
    publishPending();
    try {
      if (behavior.current === 'waiting') await new Promise<void>(resolve => window.addEventListener('credit-test-release', () => resolve(), { once: true }));
      if (behavior.current === 'transport') throw new Error('Conexion sintetica sin confirmar.');
      // Actor and entity scope are rechecked even when a receipt already exists.
      if (actor.current !== 'owner') throw sqlError('Solo el propietario de esta sede puede gestionar creditos.', '42501');
      const student = persisted.current.find(person => person.id === input.studentId);
      if (!student || student.sedeId !== sedeId) throw sqlError('Alumno fuera de la sede.', '42501');
      const signature = JSON.stringify(input);
      if (receipts.current.has(input.requestKey) && receipts.current.get(input.requestKey) !== signature) throw sqlError('Recibo con datos diferentes.');
      if (!receipts.current.has(input.requestKey)) {
        if (behavior.current === 'rollback' || behavior.current === 'rollback-refresh-failure') throw sqlError('Rechazo SQL sintetico.');
        if (behavior.current === 'stale') {
          persisted.current = persisted.current.map(person => person.id === input.studentId ? { ...person, classesRemaining: 2,
            legacyManualBalance: 2, pendingPenalties: person.pendingPenalties?.map(penalty => ({ ...penalty, sessionRevision: 8 })) } : person);
          throw sqlError('El saldo o la revision cambio.', '40001');
        }
        if (descriptor.operation === 'approve_manual') {
          const credit = input as ManualCreditIntent;
          if (credit.mode === 'reconcile_legacy') {
            if (credit.expectedLegacyBalance !== (student.legacyManualBalance ?? null)) throw sqlError('Saldo legado obsoleto.', '40001');
            if (student.canReconcileLegacy === false || student.studentCategory === 'membresia'
              || student.effectivePeriodId || student.materializedPeriodId || student.membershipPeriods?.length
              || !Number.isSafeInteger(student.legacyManualBalance) || !(student.legacyManualBalance! > 0)
              || student.manualCredits?.some(item => item.mode === 'reconcile_legacy')) throw sqlError('No hay saldo conciliable.');
            if (credit.quantity !== student.legacyManualBalance) throw sqlError('La conciliacion requiere el saldo completo.');
          }
          persisted.current = persisted.current.map(person => person.id === input.studentId ? { ...person,
            ...(credit.mode === 'reconcile_legacy' ? { canReconcileLegacy: false } : {}),
            manualCredits: [...(person.manualCredits || []), { id: input.requestKey, studentId: input.studentId, sedeId,
              mode: credit.mode, activity: credit.activity, allocatedClasses: credit.quantity, remainingClasses: credit.quantity,
              startsOn: credit.startsOn, endsOn: credit.endsOn, reason: credit.reason, evidence: credit.evidence,
              approvedBy: actorId, approvedAt: '2026-10-12T08:00:00Z' }] } : person);
          setLedger(items => [...items, { operation: descriptor.operation, studentId: input.studentId, creditId: input.requestKey, quantity: credit.quantity }]);
        } else {
          const penalty = student.pendingPenalties?.find(item => descriptor.operation === 'settle_penalty'
            ? item.id === (input as PenaltySettlementIntent).penaltyId : item.sessionId === (input as SessionBusinessIntent).sessionId);
          if (!penalty || penalty.studentId !== input.studentId || penalty.sedeId !== sedeId
            || (descriptor.operation === 'settle_penalty' ? penalty.state !== 'pending' : !['pending', 'charged'].includes(penalty.state))) throw sqlError('Incidencia no atribuible al alumno.');
          if (penalty.sessionRevision !== (input as PenaltySettlementIntent).expectedRevision) throw sqlError('Revision obsoleta.', '40001');
          const original = penalty.originalPeriodId || penalty.originalGiftCardId || penalty.originalManualCreditId;
          if (descriptor.operation === 'settle_penalty') {
            if (original !== source.current.id || !source.current.valid || source.current.remaining <= 0) throw sqlError('El derecho original no es utilizable.');
            source.current.remaining -= 1;
            setLedger(items => [...items, { operation: descriptor.operation, studentId: input.studentId, penaltyId: penalty.id, sourceId: original, delta: -1 }]);
          } else {
            if (penalty.state === 'charged') {
              if (original !== source.current.id) throw sqlError('El cargo no tiene un derecho original atribuible.');
              source.current.remaining += 1;
            }
            setLedger(items => [...items, { operation: descriptor.operation, studentId: input.studentId, penaltyId: penalty.id,
              reason: input.reason, delta: penalty.state === 'charged' ? 1 : 0,
              ...(penalty.state === 'charged' ? { sourceId: original } : {}) }]);
          }
          setSourceBalance(source.current.remaining);
          persisted.current = persisted.current.map(person => person.id === input.studentId ? { ...person,
            pendingPenalties: person.pendingPenalties?.map(item => ({ ...item, sessionRevision: item.sessionRevision + 1,
              ...(item.id === penalty.id ? { state: descriptor.operation === 'settle_penalty' ? 'charged' as const : 'waived' as const, canSettle: false,
                ...(descriptor.operation === 'settle_penalty' ? { settlementId: input.requestKey, settlementReason: input.reason,
                  settledBy: actorId, settledAt: '2026-10-12T08:00:00Z' } : {}) } : {}) })) } : person);
        }
        receipts.current.set(input.requestKey, signature);
        if (behavior.current === 'lost-response') throw new Error('Respuesta sintetica perdida tras commit.');
      }
      await refresh();
      operations.current.delete(input.studentId);
      publishPending();
    } catch (error: any) {
      if (/^[0-9A-Z]{5}$/.test(error?.code || '') && !['08000', '08003', '08006', '57014'].includes(error.code)) {
        await refresh();
        operations.current.delete(input.studentId);
        publishPending();
      }
      throw error;
    }
  };
  const start = async (operation: PendingStudentCreditOperation['operation'], input: Intent) => {
    if (behavior.current === 'validation') throw new Error('Validacion local antes de guardar el intento.');
    return execute({ input,
      descriptor: Object.freeze({ operation, studentId: input.studentId, requestKey: input.requestKey, reason: input.reason,
        ...('penaltyId' in input ? { penaltyId: input.penaltyId } : {}), ...('sessionId' in input ? { sessionId: input.sessionId } : {}) }) });
  };
  const getPending = (id: string) => operations.current.get(id)?.descriptor || null;
  const retry = async (id: string) => {
    const stored = operations.current.get(id);
    if (!stored) throw new Error('No hay intento pendiente.');
    setRetryCalls(items => [...items, { studentId: id, requestKey: stored.input.requestKey }]);
    await execute(stored);
  };
  useEffect(() => {
    const configure = (event: Event) => {
      const { fixture, mode, role, hint } = (event as CustomEvent<{ fixture?: string; mode?: string; role?: string; hint?: boolean }>).detail;
      if (mode) behavior.current = mode;
      if (role) actor.current = role;
      if (hint !== undefined) setOwnerHint(hint);
      if (!fixture) return;
      if (fixture === 'unmount') { setMounted(false); return; }
      if (fixture === 'remount') { publish(); setMounted(true); return; }
      if (fixture.startsWith('no-')) {
        const field = fixture.slice(3) as keyof typeof callbacks;
        setCallbacks(value => ({ ...value, [field]: false })); return;
      }
      if (fixture === 'roll-forward') {
        persisted.current = persisted.current.map(person => ({ ...person, classesRemaining: 9, legacyManualBalance: 2,
          pendingPenalties: person.pendingPenalties?.map(item => ({ ...item, sessionRevision: item.sessionRevision + 4 })) }));
        return;
      }
      if (fixture === 'remove-student') { persisted.current = persisted.current.filter(person => person.id !== studentId); publish(); return; }
      if (fixture === 'change-raw-without-refresh') {
        persisted.current = persisted.current.map(person => person.id === studentId ? { ...person, legacyManualBalance: 2 } : person);
        return;
      }
      let roster = structuredClone(initialStudents);
      if (fixture === 'unknown') { roster[0].legacyManualBalance = null; roster[0].classesRemaining = 0; }
      if (fixture === 'missing-observation') delete roster[0].legacyManualBalance;
      if (fixture === 'zero') { roster[0].legacyManualBalance = 0; roster[0].classesRemaining = 0; }
      if (fixture === 'managed') {
        roster[0] = { ...roster[0], studentCategory: 'membresia', status: 'membresia', paymentStatus: 'pending',
          effectivePeriodId: currentId, materializedPeriodId: currentId, membershipActivatedAt: '2026-10-12', expiryDate: '2026-11-12',
          membershipPeriods: [{ id: currentId, studentId, startsOn: '2026-10-12', endsOn: '2026-11-12', paymentStatus: 'pending' }] };
      }
      if (fixture.startsWith('historical-membership')) {
        roster[0].membershipPeriods = [{ id: currentId, studentId, startsOn: '2026-01-01', endsOn: '2026-02-01', paymentStatus: 'paid' }];
        if (fixture === 'historical-membership-allowed') roster[0].canReconcileLegacy = true;
      }
      if (fixture === 'reconcile-blocked') roster[0].canReconcileLegacy = false;
      if (fixture === 'reconcile-allowed') roster[0].canReconcileLegacy = true;
      if (fixture === 'reconciled-allowed') {
        roster[0].canReconcileLegacy = true;
        roster[0].manualCredits = [{ id: originalId, studentId, sedeId, mode: 'reconcile_legacy', activity: 'mesa',
          allocatedClasses: 4, remainingClasses: 3, startsOn: '2026-10-01', endsOn: '2026-10-31',
          reason: 'Conciliacion completa anterior', evidence: 'Origen documentado', approvedBy: actorId, approvedAt: '2026-10-10T08:00:00Z' }];
      }
      const penalty = roster[0].pendingPenalties![0];
      if (fixture === 'late') penalty.kind = 'late_cancellation';
      if (fixture === 'period') { delete penalty.originalGiftCardId; penalty.originalPeriodId = originalId; }
      if (fixture === 'manual') { delete penalty.originalGiftCardId; penalty.originalManualCreditId = originalId; }
      if (fixture === 'source-unusable') { penalty.canSettle = false; penalty.blockedReason = 'Derecho original vencido o sin saldo'; source.current.valid = false; }
      if (fixture === 'stale-source-hint') source.current.valid = false;
      if (fixture === 'missing-source') { delete penalty.originalGiftCardId; penalty.canSettle = true; }
      if (fixture === 'ambiguous-source') penalty.originalPeriodId = currentId;
      if (fixture === 'missing-revision') delete penalty.sessionRevision;
      if (fixture === 'missing-sede') delete roster[0].sedeId;
      if (fixture === 'wrong-entity') penalty.studentId = otherId;
      if (fixture === 'missing-hint') delete penalty.canSettle;
      if (fixture === 'charged' || fixture === 'waived') {
        penalty.state = fixture;
        penalty.canSettle = false;
        Object.assign(penalty, { settlementId, settlementReason: 'Motivo de liquidacion original',
          settledBy: actorId, settledAt: '2026-10-11T20:00:00Z' });
        source.current.remaining = fixture === 'charged' ? 2 : 3;
        setSourceBalance(source.current.remaining);
      }
      if (fixture === 'resolved-no-audit') { penalty.state = 'charged'; penalty.canSettle = false; }
      if (fixture === 'long-audit') {
        penalty.reason = 'Origen y revision administrativa documentada. '.repeat(40);
        roster[0].manualCredits = [{ id: originalId, studentId, sedeId, mode: 'new_manual', activity: 'torno',
          allocatedClasses: 3, remainingClasses: 2, startsOn: '2026-10-01', endsOn: '2026-10-31',
          reason: 'Motivo documentado. '.repeat(20), evidence: 'Documento-de-origen-'.repeat(40),
          approvedBy: '60000000-0000-0000-0000-000000000001', approvedAt: '2026-10-10T08:00:00Z' }];
      }
      persisted.current = roster; publish();
    };
    window.addEventListener('credit-test-configure', configure);
    return () => window.removeEventListener('credit-test-configure', configure);
  }, []);
  const forbidden = async (name: string) => { setForbiddenCalls(items => [...items, name]); throw new Error(`Forbidden profile write: ${name}`); };
  return <>
    <output hidden data-testid="calls">{JSON.stringify(calls)}</output>
    <output hidden data-testid="ledger">{JSON.stringify(ledger)}</output>
    <output hidden data-testid="students">{JSON.stringify(students)}</output>
    <output hidden data-testid="pending-operations">{JSON.stringify(pendingDescriptors)}</output>
    <output hidden data-testid="retry-calls">{JSON.stringify(retryCalls)}</output>
    <output hidden data-testid="original-source-balance">{sourceBalance}</output>
    <output hidden data-testid="forbidden-calls">{JSON.stringify(forbiddenCalls)}</output>
    <main style={{ height: '100dvh' }}>{mounted ? <StudentList students={students}
      onAddStudent={() => forbidden('add')} onUpdate={() => forbidden('update')} onDeleteStudent={() => forbidden('delete')}
      onRenew={() => forbidden('renew')} onAdjustClasses={() => forbidden('adjust')} canAdjustClasses={false}
      onConfirmPayment={() => forbidden('confirm-payment')} onActivateMembership={() => forbidden('activate')}
      onApproveManualCredit={callbacks.approve ? input => start('approve_manual', input) : undefined}
      onSettlePendingPenalty={callbacks.settle ? input => start('settle_penalty', input) : undefined}
      onWaivePendingPenalty={callbacks.waive ? input => start('waive_penalty', input) : undefined}
      canManageStudentCredits={ownerHint ? person => person.sedeId === sedeId : undefined}
      getPendingStudentCreditOperation={callbacks.getter ? getPending : undefined}
      onRetryPendingStudentCreditOperation={callbacks.retry ? retry : undefined} /> : <div role="alert" data-testid="student-load-error">
        No se pudo cargar el perfil.
        <button type="button" onClick={() => { publish(); setMounted(true); }}>Recargar datos sin repetir escrituras</button>
      </div>}</main>
  </>;
};
createRoot(document.getElementById('root')!).render(<Harness />);
