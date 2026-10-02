import type { DeliveryTask } from "./contracts.js";

export type TaskExecutionResult<T> = {
  task: DeliveryTask;
  value: T;
};

export type TaskSchedulerOptions<T> = {
  tasks: DeliveryTask[];
  maxParallel: number;
  execute: (task: DeliveryTask) => Promise<T>;
  onBatchComplete: (
    batch: Array<TaskExecutionResult<T>>,
  ) => Promise<void>;
  onTaskStarted?: (task: DeliveryTask) => void;
  onTaskCompleted?: (task: DeliveryTask) => void;
};

function validateTasks(tasks: DeliveryTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate delivery task id: ${task.id}`);
    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself`);
      }
    }
  }
}

export async function runTaskPlan<T>(
  options: TaskSchedulerOptions<T>,
): Promise<Array<TaskExecutionResult<T>>> {
  validateTasks(options.tasks);

  const maxParallel = Math.max(1, Math.floor(options.maxParallel));
  const pending = new Map(options.tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const output: Array<TaskExecutionResult<T>> = [];

  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((task) => task.dependsOn.every((dependency) => completed.has(dependency)))
      .slice(0, maxParallel);

    if (ready.length === 0) {
      const unresolved = [...pending.keys()].join(", ");
      throw new Error(`Delivery task dependency cycle or blocked plan: ${unresolved}`);
    }

    const settled = await Promise.allSettled(
      ready.map(async (task) => {
        options.onTaskStarted?.(task);
        const value = await options.execute(task);
        return { task, value };
      }),
    );

    const failed = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (failed) {
      throw failed.reason instanceof Error
        ? failed.reason
        : new Error(String(failed.reason));
    }

    const batch = settled.map(
      (item) => (item as PromiseFulfilledResult<TaskExecutionResult<T>>).value,
    );

    await options.onBatchComplete(batch);
    for (const item of batch) {
      pending.delete(item.task.id);
      completed.add(item.task.id);
      output.push(item);
      options.onTaskCompleted?.(item.task);
    }
  }

  return output;
}
