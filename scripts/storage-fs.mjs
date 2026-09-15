import * as local from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

// The default remains the real filesystem. A hosted request chooses its store
// explicitly, and asynchronous work inherits that choice without global state.
const context = new AsyncLocalStorage();
export const withStorage = (store, callback) => context.run(store, callback);
export const currentStorage = () => context.getStore();
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
