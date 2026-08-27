import { activityInfo, log } from '@temporalio/activity';

export interface ActivityResult {
  value: string;
  attempts: number;
}

export async function retryableActivity(workflowId: string, failures: number): Promise<ActivityResult> {
  const attempt = activityInfo().attempt;
  log.info('retryable activity attempt', { workflowId, attempt, failures });
  if (attempt <= failures) {
    throw new Error(`intentional retry ${attempt} of ${failures}`);
  }
  return { value: `TEMPORAL:${workflowId}:OK`, attempts: attempt };
}
