import { auth } from "./api";
import { unlock } from "./lock";

// A file into the pool (ADR-046): its bytes as the body of one request,
// with progress as the browser sends it; the rest (Oraknid to the
// provider) comes on the live socket as `transfer` frames of the same id.

export interface Uploaded {
  providerId: string;
  path: string;
  size: number;
  providerName: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function uploadFile(
  file: Blob & { name: string },
  o: {
    folder: string;
    /** A provider's id, or "auto": where the rule puts it. */
    provider: string;
    replace?: boolean;
    transfer: string;
    onProgress?: (sent: number, total: number) => void;
  },
): Promise<Uploaded> {
  const q = new URLSearchParams({
    folder: o.folder,
    name: file.name,
    size: String(file.size),
    provider: o.provider,
    transfer: o.transfer,
    ...(o.replace ? { replace: "1" } : {}),
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/cloud/upload?${q}`);
    const token = auth.token();
    const session = unlock.get();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    if (session) xhr.setRequestHeader("x-oraknid-unlock", session);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => o.onProgress?.(e.loaded, e.total || file.size);
    xhr.onload = () => {
      let body: { message?: string } & Partial<Uploaded> = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {}
      if (xhr.status === 423) unlock.locked();
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Uploaded);
      else
        reject(new UploadError(body.message ?? `The upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new UploadError("The connection to Oraknid broke.", 0));
    xhr.onabort = () => reject(new UploadError("Stopped.", 0));
    xhr.send(file);
  });
}
