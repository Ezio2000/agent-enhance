import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
/** Watch parent directories so atomic replacements and newly created sources are observed. */
export function watchServiceSources(paths: readonly string[], changed: () => void): () => void {
  let watchers: FSWatcher[] = [],
    timer: NodeJS.Timeout | undefined,
    closed = false;
  const targets = [...new Set(paths.map((path) => resolve(path)))];
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!closed) {
        start();
        changed();
      }
    }, 150);
    timer.unref();
  };
  const start = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    const directories = new Set<string>();
    for (const target of targets) {
      let directory = dirname(target);
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      directories.add(directory);
    }
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, file) => {
          if (file) {
            const touched = join(directory, String(file));
            if (!targets.some((target) => target === touched || target.startsWith(`${touched}/`))) return;
          }
          schedule();
        });
        watcher.on("error", schedule);
        watchers.push(watcher);
      } catch {
        /* A source can disappear while wiring; discovery reports its current state. */
      }
    }
  };
  start();
  return () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
