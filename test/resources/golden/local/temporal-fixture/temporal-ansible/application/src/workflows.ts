import { proxyActivities, setHandler, sleep, defineQuery } from '@temporalio/workflow';
import type * as activities from './activities';

export type WorkflowPhase = 'delaying' | 'running-activity' | 'completed';
export interface WorkflowStatus { phase: WorkflowPhase; }
export interface WorkflowResult { workflowId: string; value: string; attempts: number; }

export const statusQuery = defineQuery<WorkflowStatus>('status');

export async function durableWorkflow(
  workflowId: string,
  delaySeconds: number,
  failures: number,
  maximumAttempts: number,
): Promise<WorkflowResult> {
  let phase: WorkflowPhase = 'delaying';
  setHandler(statusQuery, () => ({ phase }));
  await sleep(`${delaySeconds} seconds`);
  phase = 'running-activity';
  const { retryableActivity } = proxyActivities<typeof activities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts, initialInterval: '1 second', backoffCoefficient: 1 },
  });
  const result = await retryableActivity(workflowId, failures);
  phase = 'completed';
  return { workflowId, ...result };
}
