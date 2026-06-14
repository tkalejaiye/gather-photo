import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type UploadStatus = "queued" | "uploading" | "done" | "failed";

export interface UploadItem {
  id: string;            // uuid
  eventSlug: string;
  uploaderToken: string;
  uploaderName?: string;
  blob: Blob;            // compressed image
  path: string;          // target storage object name
  contentHash: string;
  bytes: number;
  status: UploadStatus;
  progress: number;      // 0..1
  attempts: number;
  createdAt: number;
}

interface GatherDB extends DBSchema {
  uploads: { key: string; value: UploadItem; indexes: { byStatus: UploadStatus } };
}

const DB_NAME = "gather-photo";
const VERSION = 1;

async function db(): Promise<IDBPDatabase<GatherDB>> {
  return openDB<GatherDB>(DB_NAME, VERSION, {
    upgrade(d) {
      const store = d.createObjectStore("uploads", { keyPath: "id" });
      store.createIndex("byStatus", "status");
    },
  });
}

export async function enqueue(item: UploadItem): Promise<void> {
  await (await db()).put("uploads", item);
}

export async function update(id: string, patch: Partial<UploadItem>): Promise<void> {
  const d = await db();
  const existing = await d.get("uploads", id);
  if (existing) await d.put("uploads", { ...existing, ...patch });
}

export async function getByStatus(statuses: UploadStatus[]): Promise<UploadItem[]> {
  const d = await db();
  const all = await d.getAll("uploads");
  return all.filter((i) => statuses.includes(i.status));
}

export async function remove(id: string): Promise<void> {
  await (await db()).delete("uploads", id);
}
