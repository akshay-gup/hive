// The part of Cloudflare's Workers runtime that src/worker.ts uses, declared here so the Node build
// can check the file without Cloudflare's type package. Cloudflare provides the module at run time.
declare module "cloudflare:workers" {
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
  }
  export interface WorkflowEvent<Params> {
    payload: Readonly<Params>;
    timestamp: Date;
    instanceId: string;
  }
  export interface WorkflowStepConfig {
    retries?: {
      limit: number;
      delay: string | number;
      backoff?: "constant" | "linear" | "exponential";
    };
    timeout?: string | number;
  }
  export abstract class WorkflowStep {
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: ExecutionContext;
    protected env: Env;
    constructor(ctx: ExecutionContext, env: Env);
    abstract run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<unknown>;
  }
}
