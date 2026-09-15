import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "../scripts/storage-fs.mjs";
import { DATA_ROOT } from "./plugins.mjs";

const TASKS = `${DATA_ROOT}/.tasks`;
export const taskPath = (id) => {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid task ID");
  return `${TASKS}/${id}.json`;
};
export const readTask = async (id) => JSON.parse(await readFile(taskPath(id), "utf8"));
export const saveTask = async (task) => writeFile(taskPath(task.id), JSON.stringify(task));

export async function createTask(payload) {
  const task = { id: payload.taskId || randomUUID(), payload, state: "pending", step: 0, createdAt: new Date().toISOString() };
  await mkdir(TASKS, { recursive: true });
  await writeFile(taskPath(task.id), JSON.stringify(task), { flag: "wx" });
  return task;
}

// Count dispatches conservatively, before sending anything to the paid API.
// An uncertain request consumes its allowance even when no result is saved.
export async function reservePaidCall() {
  const file = `${DATA_ROOT}/.api-usage.json`;
  const day = new Date().toISOString().slice(0, 10);
  let usage;
  try { usage = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!usage || usage.day !== day) usage = { day, calls: 0 };
  const configured = Number(process.env.WARDROBE_DAILY_API_LIMIT || 40);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 40;
  if (usage.calls >= limit) throw Object.assign(new Error(`The daily limit of ${limit} API requests has been reached. Try again tomorrow.`), { status: 429 });
  await writeFile(file, JSON.stringify({ day, calls: usage.calls + 1 }));
}
