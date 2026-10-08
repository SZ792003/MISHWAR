export type MigrationContext = {
  db: {
    doc: (path: string) => {
      get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
    };
    collection: (path: string) => {
      limit: (count: number) => { get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }> };
    };
  };
  dryRun: boolean;
  log: (message: string) => void;
};

export type Migration = {
  id: string;
  description: string;
  run: (context: MigrationContext) => Promise<void>;
};
