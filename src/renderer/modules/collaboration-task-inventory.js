/**
 * The files a received task knows about but has not brought down yet.
 *
 * A task copy can arrive with its file list materialized lazily: the inventory
 * is what the sender recorded, and "remote" entries are the ones still only on
 * the other side. It is a request the user makes and a section painted into the
 * task detail, with its own two pieces of state — the last inventory read and
 * whether that read failed — which nothing else in the task panel touches.
 */
export function createTaskInventoryView({ node, tr, button, runWorkflow, repaint }) {
  let inventory = null, inventoryError = false;

  function reset() { inventory = null; inventoryError = false; }

// Online-only inventory: files the task copy knows about but has not brought
// to disk. Nothing here is a placeholder; materializing writes exact bytes.
function paintInventory(body, task) {
  const section = node("section", "remote-task-section remote-task-inventory"); section.setAttribute("role", "status");
  section.append(node("h4", "", tr("inventory")));
  const counts = inventory.counts;
  if (!counts.remote) section.append(node("p", "remote-task-meta", tr("inventoryComplete", { count: counts.total })));
  else {
    section.append(node("p", "remote-task-meta", tr("inventoryRemote", { count: counts.remote, total: counts.total, size: formatBytes(counts.remoteBytes) })));
    const list = node("ul", "remote-task-files");
    for (const file of inventory.files.filter(item => item.state === "remote").slice(0, 50)) { const row = node("li", ""); row.append(node("span", "", file.path), node("span", "remote-task-meta", `${tr("inventoryOnline")} · ${formatBytes(file.sizeBytes)}`)); list.append(row); }
    section.append(list);
    if (inventory.truncated || counts.remote > 50) section.append(node("p", "remote-task-meta", tr("inventoryMore", { count: counts.remote })));
    section.append(button("task-materialize", tr("materializeAll"), async () => {
      const result = await runWorkflow({ operation: "materialize", taskId: task.id }); if (!result) return;
      if (result.ok && result.inventory) inventory = { taskId: task.id, ...result.inventory }; else inventoryError = true;
      repaint();
    }));
  }
  if (inventoryError) section.append(node("p", "", tr("inventoryFailed")));
  body.append(section);
}
function formatBytes(value) { const units = ["B", "KB", "MB", "GB"]; let size = Number(value) || 0, index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; } return `${index ? size.toFixed(1) : size} ${units[index]}`; }
async function showInventory(task) {
  const result = await runWorkflow({ operation: "inventory", taskId: task.id }); if (!result) return;
  inventoryError = !result.ok; inventory = result.ok && result.inventory ? { taskId: task.id, ...result.inventory } : null;
  repaint();
}

  /** Paints only when the last read belongs to this task, as the caller used to check. */
  function paint(body, task) {
    if (inventory?.taskId !== task.id) return;
    paintInventory(body, task);
  }

  return { paint, show: showInventory, reset };
}
