/** What a spike found, step by step. */
export interface SpikeStep {
  name: string;
  ms: number;
  ok: boolean;
  note?: string;
}
export interface SpikeReport {
  workspaceId: string;
  url?: string;
  steps: SpikeStep[];
  ok: boolean;
}

/** Records the steps of a spike, each timed, and the first failure's words; a step that fails is thrown again. */
export function recorder(workspaceId: string, log: (line: string) => void = () => {}) {
  const report: SpikeReport = { workspaceId, steps: [], ok: true };
  const step = async <T>(name: string, run: () => Promise<T>, note?: (value: T) => string) => {
    const started = Date.now();
    try {
      const value = await run();
      const done: SpikeStep = { name, ms: Date.now() - started, ok: true, note: note?.(value) };
      report.steps.push(done);
      log(`  ${name}: ${(done.ms / 1000).toFixed(1)}s${done.note ? ` (${done.note})` : ""}`);
      return value;
    } catch (error) {
      const failed: SpikeStep = {
        name,
        ms: Date.now() - started,
        ok: false,
        note: error instanceof Error ? error.message : String(error),
      };
      report.steps.push(failed);
      report.ok = false;
      log(`  ${name}: FAILED after ${(failed.ms / 1000).toFixed(1)}s: ${failed.note}`);
      throw error;
    }
  };
  return { report, step };
}
