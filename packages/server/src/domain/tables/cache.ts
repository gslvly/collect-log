import type { TableDefinition } from './types.js';

export type TableDefinitionLoader = () => Promise<TableDefinition | null>;

export class TableMetadataCache {
  constructor(private readonly maxEntries = 1000) {}

  private readonly entries = new Map<string, Promise<TableDefinition | null>>();

  get(projectId: string, loader: TableDefinitionLoader): Promise<TableDefinition | null> {
    const cached = this.entries.get(projectId);
    if (cached !== undefined) {
      return cached;
    }

    const pending = loader()
      .then((definition) => {
        if (this.entries.get(projectId) === pending && definition === null) {
          this.entries.delete(projectId);
        }
        return definition;
      })
      .catch((error: unknown) => {
        if (this.entries.get(projectId) === pending) {
          this.entries.delete(projectId);
        }
        throw error;
      });
    this.entries.set(projectId, pending);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined && oldest !== projectId) {
        this.entries.delete(oldest);
      }
    }
    return pending;
  }

  invalidate(projectId: string): void {
    this.entries.delete(projectId);
  }

  clear(): void {
    this.entries.clear();
  }

  has(projectId: string): boolean {
    return this.entries.has(projectId);
  }
}

export const tableMetadataCache = new TableMetadataCache();
