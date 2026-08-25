export interface ReconcileResult {
  at: string;
  fixed: number;
  failed: number;
}

export let reconcileState: ReconcileResult | null = null;

export function setReconcileState(result: ReconcileResult): void {
  reconcileState = result;
}
