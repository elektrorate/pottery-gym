/** True when the scalar-adjustment RPC is not installed yet. Other errors must surface. */
export const isMissingScalarAdjustmentRpc = (error: { code?: string; message?: string } | null | undefined) => {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  const message = error.message || '';
  return /adjust_student_scalar_classes/i.test(message)
    && /schema cache|could not find|does not exist/i.test(message);
};
