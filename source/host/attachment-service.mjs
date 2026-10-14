import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";
import { ProtocolError, nowIso, requireString } from "../shared/protocol.mjs";

const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const VIRTUAL_PREFIX = "fabushi-attachment://";

function ownerKey(ownerId) {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
}
function initialState() {
  return { version: 1, owners: {} };
}
function cleanFilename(value) {
  const name = requireString(value, "filename", { max: 240 }).replace(/[\\/]/g, "_").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!name || name === "." || name === "..") throw new ProtocolError("INVALID_ARGUMENT", "Attachment filename is invalid");
  return name;
}
function decodeBase64(value) {
  const text = requireString(value, "bytesBase64", { max: Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 32 });
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new ProtocolError("INVALID_ARGUMENT", "Attachment payload is not valid base64");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ProtocolError("ATTACHMENT_TOO_LARGE", "Attachment exceeds the 24 MiB Web limit");
  return bytes;
}
function mimeType(value) {
  if (typeof value !== "string" || !value.trim()) return "application/octet-stream";
  const mime = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime.slice(0, 160) : "application/octet-stream";
}
function virtualPath(id) {
  return `${VIRTUAL_PREFIX}${id}`;
}
function idFromPath(value) {
  const text = requireString(value, "path", { max: 512 });
  if (!text.startsWith(VIRTUAL_PREFIX)) throw new ProtocolError("ATTACHMENT_PATH_INVALID", "Attachment path is not a Fabushi virtual attachment URI");
  const id = text.slice(VIRTUAL_PREFIX.length);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProtocolError("ATTACHMENT_PATH_INVALID", "Attachment path has an invalid id");
  return id;
}
function isTextMime(mime) {
  return mime.startsWith("text/") || ["application/json","application/xml","application/javascript","application/x-javascript","application/yaml","application/x-yaml"].includes(mime);
}
function isImageMime(mime) {
  return ["image/png","image/jpeg","image/webp","image/gif"].includes(mime);
}

export class AttachmentService {
  constructor({ dataDir = process.env.FABUSHI_HOST_DATA_DIR || path.resolve(".data/host") } = {}) {
    this.root = path.join(dataDir, "attachments");
    this.store = new AtomicJsonStore(path.join(dataDir, "attachments.json"), initialState);
  }

  async runtimeCommand(ownerId, command) {
    switch (command.type) {
      case "attachment.upload": return [await this.upload(ownerId, command)];
      case "attachment.readText": return [await this.readText(ownerId, command)];
      case "attachment.readChunk": return [await this.readChunk(ownerId, command)];
      case "attachment.readImage": return [await this.readImage(ownerId, command)];
      case "search.media": return [await this.searchMedia(ownerId, command)];
      default: throw new ProtocolError("COMMAND_NOT_IMPLEMENTED", `Attachment command is not supported: ${command.type}`);
    }
  }

  async upload(ownerId, command) {
    const agentId = requireString(command.agentId, "agentId", { max: 256 });
    const filename = cleanFilename(command.filename);
    const bytes = decodeBase64(command.bytesBase64);
    const id = randomUUID();
    const storageName = `${id}.bin`;
    const directory = path.join(this.root, ownerKey(ownerId), createHash("sha256").update(agentId).digest("hex").slice(0, 24));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, storageName), bytes, { mode: 0o600, flag: "wx" });
    const record = {
      id,
      agentId,
      name: filename,
      mimeType: mimeType(command.mimeType),
      sizeBytes: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
      storageName,
      storageScope: path.basename(directory),
      createdAt: nowIso(),
    };
    await this.store.update((state) => {
      const key = ownerKey(ownerId);
      state.owners[key] ??= { attachments: {} };
      state.owners[key].attachments ??= {};
      state.owners[key].attachments[id] = record;
    });
    return {
      type: "attachment.stored",
      timestamp: nowIso(),
      attachment: {
        id,
        agentId,
        name: filename,
        path: virtualPath(id),
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        hash: record.hash,
      },
    };
  }

  async readText(ownerId, command) {
    const { record, bytes } = await this.#read(ownerId, command.path, command.agentId);
    if (!isTextMime(record.mimeType)) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, MAX_TEXT_BYTES)));
      } catch {
        return { type: "attachment.text", timestamp: nowIso(), result: { path: virtualPath(record.id), kind: "binary", truncated: bytes.length > MAX_TEXT_BYTES, bytes: bytes.length } };
      }
    }
    const slice = bytes.subarray(0, Math.min(bytes.length, MAX_TEXT_BYTES));
    const text = new TextDecoder("utf-8").decode(slice);
    return {
      type: "attachment.text",
      timestamp: nowIso(),
      result: { path: virtualPath(record.id), kind: "text", text, truncated: bytes.length > slice.length, bytes: bytes.length },
    };
  }

  async readChunk(ownerId, command) {
    const { record, bytes } = await this.#read(ownerId, command.path, command.agentId);
    const offset = Number(command.offset);
    const length = Number(command.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) {
      throw new ProtocolError("INVALID_ARGUMENT", "Attachment chunk range is invalid");
    }
    const chunk = bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length));
    return {
      type: "attachment.chunk",
      timestamp: nowIso(),
      result: { path: virtualPath(record.id), bytesBase64: chunk.toString("base64"), totalSize: bytes.length, mime: record.mimeType },
    };
  }

  async readImage(ownerId, command) {
    const { record, bytes } = await this.#read(ownerId, command.path, command.agentId);
    if (!isImageMime(record.mimeType)) throw new ProtocolError("ATTACHMENT_NOT_IMAGE", "Attachment is not a supported image type");
    if (bytes.length > MAX_IMAGE_BYTES) throw new ProtocolError("ATTACHMENT_IMAGE_TOO_LARGE", "Image exceeds the inline preview limit");
    return {
      type: "attachment.image",
      timestamp: nowIso(),
      result: { path: virtualPath(record.id), dataUrl: `data:${record.mimeType};base64,${bytes.toString("base64")}` },
    };
  }

  async searchMedia(ownerId, command) {
    const query = typeof command.query === "string" ? command.query.normalize("NFKC").trim().toLocaleLowerCase() : "";
    const limit = Number.isSafeInteger(command.limit) ? Math.min(Math.max(command.limit, 1), 100) : 50;
    const state = await this.store.read();
    const records = Object.values(state.owners[ownerKey(ownerId)]?.attachments ?? {});
    const matches = records
      .filter((record) => isImageMime(record.mimeType) && (!query || [record.name, record.mimeType, record.agentId].some((value) => String(value).toLocaleLowerCase().includes(query))))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map((record) => ({
        agentId: record.agentId,
        agentName: record.agentId === "assistant" ? "Mahayana" : record.agentId,
        path: virtualPath(record.id),
        name: record.name,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        timestampMs: Date.parse(record.createdAt) || 0,
      }));
    return { type: "search.media", timestamp: nowIso(), query: command.query ?? "", matches };
  }

  async #read(ownerId, attachmentPath, agentId) {
    const id = idFromPath(attachmentPath);
    const state = await this.store.read();
    const record = state.owners[ownerKey(ownerId)]?.attachments?.[id];
    if (!record) throw new ProtocolError("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    if (agentId && record.agentId !== agentId) throw new ProtocolError("ATTACHMENT_AGENT_MISMATCH", "Attachment does not belong to this agent");
    const directory = path.join(this.root, ownerKey(ownerId), record.storageScope);
    const filePath = path.join(directory, record.storageName);
    const relative = path.relative(directory, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ProtocolError("ATTACHMENT_PATH_INVALID", "Attachment storage path escaped its owner scope");
    const bytes = await readFile(filePath);
    if (bytes.length !== record.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== record.hash) {
      throw new ProtocolError("ATTACHMENT_INTEGRITY_FAILED", "Attachment integrity check failed");
    }
    return { record, bytes };
  }
}
