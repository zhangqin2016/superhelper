// Only the latest queued view needs HTTP. The running request is allowed to
// finish so its durable authorization/receipt processing is never interrupted.
export function createLatestOpenQueue() {
  let tail = Promise.resolve();
  return (operation, isCurrent) => {
    const task = tail.catch(() => undefined).then(() => isCurrent() ? operation() : null);
    tail = task.catch(() => undefined);
    return task;
  };
}
