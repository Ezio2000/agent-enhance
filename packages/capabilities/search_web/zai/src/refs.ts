/** Session-scoped z-reference store: search results get stable IDs that later open calls resolve. */
export interface RefEntry {
  url: string;
  title?: string;
}
export class RefStore {
  private readonly refs = new Map<string, RefEntry>();
  private next = 1;
  constructor(private readonly capacity = 64) {}

  add(entry: RefEntry): string {
    const id = `z${this.next++}`;
    this.refs.set(id, entry);
    while (this.refs.size > this.capacity) {
      const oldest = this.refs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.refs.delete(oldest);
    }
    return id;
  }

  resolve(refId: string): RefEntry | undefined {
    return this.refs.get(refId);
  }

  known(): string[] {
    return [...this.refs.keys()];
  }

  reset(): void {
    this.refs.clear();
    this.next = 1;
  }
}
