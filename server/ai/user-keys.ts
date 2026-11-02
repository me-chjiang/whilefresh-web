import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  EnvCredentialProvider,
  type CredentialProvider,
  type Service,
} from "./credentials.js";

export type UserKeyField = "deepseek" | "lexmount" | "lexmountProject";
export type KeySource = "user" | "builtin" | "none";

const SECRET_NAMES: Readonly<Record<Service, string>> = {
  deepseek: "deepseek-key",
  lexmount: "lexmount-key",
  lexmountProjectId: "lexmount-project-id",
};

const SERVICES: Readonly<Record<UserKeyField, Service>> = {
  deepseek: "deepseek",
  lexmount: "lexmount",
  lexmountProject: "lexmountProjectId",
};

const INVALID_VALUE = /[\s\p{Cc}\p{Noncharacter_Code_Point}]/u;

export class UserKeyStore implements CredentialProvider {
  private readonly dataDir: string;
  private readonly path: string;
  private readonly env: CredentialProvider;
  private values: Record<string, unknown>;

  constructor(
    dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dataDir = dataDir;
    this.path = join(dataDir, "secrets.json");
    this.env = new EnvCredentialProvider(env);
    this.ensureDirectory();
    this.values = this.read();
  }

  key(service: Service): string {
    const value = this.values[SECRET_NAMES[service]];
    return typeof value === "string" ? value : "";
  }

  isConfigured(): boolean {
    return this.key("deepseek").length > 0
      || this.key("lexmount").length > 0
      || this.key("lexmountProjectId").length > 0;
  }

  keySource(field: UserKeyField): KeySource {
    const service = SERVICES[field];
    if (this.key(service).length > 0) {
      return "user";
    }
    return this.env.key(service).length > 0 ? "builtin" : "none";
  }

  save(field: UserKeyField, value: string): boolean {
    const service = SERVICES[field];
    if (!service) {
      return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return this.clear(field);
    }
    if (INVALID_VALUE.test(trimmed)) {
      return false;
    }

    const next = { ...this.values, [SECRET_NAMES[service]]: trimmed };
    if (!this.write(next)) {
      return false;
    }
    this.values = next;
    return true;
  }

  clear(field: UserKeyField): boolean {
    const service = SERVICES[field];
    if (!service) {
      return false;
    }
    const name = SECRET_NAMES[service];
    if (!(name in this.values)) {
      return true;
    }
    const next = { ...this.values };
    delete next[name];
    if (!this.write(next)) {
      return false;
    }
    this.values = next;
    return true;
  }

  private ensureDirectory(): boolean {
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      chmodSync(this.dataDir, 0o700);
      return true;
    } catch {
      return false;
    }
  }

  private read(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return typeof parsed === "object"
        && parsed !== null
        && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private write(values: Record<string, unknown>): boolean {
    if (!this.ensureDirectory()) {
      return false;
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(values), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      return true;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created.
      }
      return false;
    }
  }
}
