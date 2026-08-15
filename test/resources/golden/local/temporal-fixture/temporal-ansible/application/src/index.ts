import express from 'express';
import { Connection, Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { durableWorkflow, statusQuery, WorkflowResult } from './workflows';
import * as activities from './activities';

const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'temporal:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'benchmark';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'reference';
const defaultDelay = Number(process.env.DEFAULT_DELAY_SECONDS ?? '120');
const failures = Number(process.env.ACTIVITY_FAILURES ?? '2');
const maximumAttempts = Number(process.env.ACTIVITY_MAXIMUM_ATTEMPTS ?? '5');
const port = Number(process.env.PORT ?? '3000');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

async function main(): Promise<void> {
  const connection = await Connection.connect({ address: temporalAddress });
  const client = new Client({ connection, namespace });
  const workerConnection = await NativeConnection.connect({ address: temporalAddress });
  const worker = await Worker.create({
    connection: workerConnection,
    namespace,
    taskQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  void worker.run().catch((error) => {
    console.error('worker stopped', error);
    process.exit(1);
  });

  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/healthz', (_request, response) => response.json({ ok: true, temporal: 'connected' }));

  app.post('/workflows', async (request, response, next) => {
    try {
      const workflowId = request.body?.workflowId;
      const delaySeconds = request.body?.delaySeconds ?? defaultDelay;
      if (typeof workflowId !== 'string' || !idPattern.test(workflowId)) {
        response.status(400).json({ error: 'workflowId must match the supported identifier syntax' });
        return;
      }
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) {
        response.status(400).json({ error: 'delaySeconds must be an integer from 1 through 86400' });
        return;
      }
      try {
        await client.workflow.start(durableWorkflow, {
          workflowId,
          taskQueue,
          args: [workflowId, delaySeconds, failures, maximumAttempts],
        });
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          response.status(409).json({ error: 'workflow ID already exists', workflowId });
          return;
        }
        throw error;
      }
      response.status(202).json({ workflowId, statusUrl: `/workflows/${encodeURIComponent(workflowId)}` });
    } catch (error) { next(error); }
  });

  app.get('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflowId = request.params.workflowId;
      if (!idPattern.test(workflowId)) {
        response.status(400).json({ error: 'invalid workflowId' });
        return;
      }
      const handle = client.workflow.getHandle(workflowId);
      const description = await handle.describe();
      const temporalStatus = description.status.name;
      let phase: string = temporalStatus.toLowerCase();
      let result: WorkflowResult | undefined;
      if (temporalStatus === 'RUNNING') {
        phase = (await handle.query(statusQuery)).phase;
      } else if (temporalStatus === 'COMPLETED') {
        result = await handle.result();
        phase = 'completed';
      }
      response.json({ workflowId, phase, temporalStatus, ...(result ? { result } : {}) });
    } catch (error: any) {
      if (error?.name === 'WorkflowNotFoundError') {
        response.status(404).json({ error: 'workflow not found' });
        return;
      }
      next(error);
    }
  });

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(error);
    response.status(500).json({ error: 'internal error' });
  });
  app.listen(port, '0.0.0.0', () => console.log(`reference API listening on ${port}`));
}

main().catch((error) => { console.error(error); process.exit(1); });
