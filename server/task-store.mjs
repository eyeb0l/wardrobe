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
export async function reservePaidCall(kind) {
  if (!["text", "image"].includes(kind)) throw new Error("Unknown paid request kind");
  const file = `${DATA_ROOT}/.api-usage.json`;
  const day = new Date().toISOString().slice(0, 10);
  let usage;
  try { usage = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!usage || usage.day !== day) usage = { day, calls: 0 };
  // Legacy aggregate usage remains charged to images for the rest of that day.
  // Keep `calls` for compatibility with older backups and conservative rollback.
  const field = kind === "image" ? "calls" : "textCalls";
  const count = usage[field] ?? (field === "textCalls" ? 0 : NaN);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid daily API usage");
  const fallback = kind === "image" ? 40 : 1000;
  const configured = Number(kind === "image"
    ? process.env.WARDROBE_DAILY_IMAGE_API_LIMIT || process.env.WARDROBE_DAILY_API_LIMIT || fallback
    : process.env.WARDROBE_DAILY_TEXT_API_LIMIT || fallback);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
  const label = kind === "image" ? "image generation" : "text/vision";
  if (count >= limit) throw Object.assign(new Error(`The daily limit of ${limit} ${label} API requests has been reached. Try again tomorrow (UTC).`), { status: 429 });
  await writeFile(file, JSON.stringify({ ...usage, [field]: count + 1 }));
}
