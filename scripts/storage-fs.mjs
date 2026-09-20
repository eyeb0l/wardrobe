import * as local from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

// The default remains the real filesystem. A hosted request chooses its store
// explicitly, and asynchronous work inherits that choice without global state.
const context = new AsyncLocalStorage();
export const withStorage = (store, callback) => context.run(store, callback);
export const currentStorage = () => context.getStore();
// A hosted immutable image identity always comes from a fresh path lookup.
// Local files are mutable, so callers must fall back to checking their bytes.
export const imageIdentity = async (file) => context.getStore()?.imageIdentity?.(file);
const operation = (name) => (...args) => (context.getStore() ?? local)[name](...args);
export const readFile = operation("readFile");
export const writeFile = operation("writeFile");
export const mkdir = operation("mkdir");
export const readdir = operation("readdir");
export const rename = operation("rename");
export const rm = operation("rm");
export const stat = operation("stat");
export const lstat = operation("lstat");
export const realpath = operation("realpath");
export const copyFile = operation("copyFile");
export const link = operation("link");

// Metadata-only callers can resolve a directory's candidates in one hosted
// query. Keep the filesystem checks here for local use and adapter fallbacks:
// lexical containment alone is not sufficient in the presence of symlinks.
export async function containedFiles(directory, filenames) {
  const names = [...new Set(filenames)].filter((name) => typeof name === "string" && name.length > 0 &&
    name === path.basename(name) && ![".", ".."].includes(name) && !/[\\\0]/.test(name));
  const storage = context.getStore();
  if (storage?.containedFiles) return storage.containedFiles(directory, names);
  const found = new Map();
  if (!names.length) return found;
  let base;
  try {
    base = await realpath(directory);
    if (!(await stat(base)).isDirectory()) return found;
  } catch (failure) {
    if (["ENOENT", "ENOTDIR"].includes(failure.code)) return found;
    throw failure;
  }
  const files = await Promise.all(names.map(async (name) => {
    try {
      const resolved = await realpath(path.join(directory, name));
      if (resolved.startsWith(`${base}${path.sep}`) && (await stat(resolved)).isFile()) return [name, resolved];
    } catch (failure) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(failure.code)) throw failure;
    }
  }));
  for (const entry of files) if (entry) found.set(...entry);
  return found;
}
