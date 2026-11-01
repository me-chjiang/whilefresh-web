export type Service = "deepseek" | "lexmount" | "lexmountProjectId";

export interface CredentialProvider {
  key(service: Service): string;
  isConfigured(): boolean;
}

type CredentialValues = Partial<Record<Service, string>>;

export class StaticCredentialProvider implements CredentialProvider {
  private readonly keys: Record<Service, string> = {
    deepseek: "",
    lexmount: "",
    lexmountProjectId: "",
  };

  constructor(
    initial: string | CredentialValues = "",
    lexmount = "",
    lexmountProjectId = "",
  ) {
    if (typeof initial === "string") {
      this.keys.deepseek = initial;
      this.keys.lexmount = lexmount;
      this.keys.lexmountProjectId = lexmountProjectId;
    } else {
      for (const service of Object.keys(initial) as Service[]) {
        const value = initial[service];
        if (value !== undefined) {
          this.keys[service] = value;
        }
      }
    }
  }

  key(service: Service): string {
    return this.keys[service];
  }

  isConfigured(): boolean {
    return Object.values(this.keys).some((value) => value.length > 0);
  }

  setKey(service: Service, key: string): void {
    this.keys[service] = key;
  }
}

export class LayeredCredentialProvider implements CredentialProvider {
  constructor(
    private readonly primary: CredentialProvider,
    private readonly fallback: CredentialProvider,
  ) {}

  key(service: Service): string {
    const value = this.primary.key(service);
    return value.length > 0 ? value : this.fallback.key(service);
  }

  isConfigured(): boolean {
    const services: Service[] = ["deepseek", "lexmount", "lexmountProjectId"];
    return services.some(
      (service) => this.key(service).length > 0,
    );
  }
}

export class EnvCredentialProvider implements CredentialProvider {
  private readonly values: StaticCredentialProvider;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.values = new StaticCredentialProvider({
      deepseek: env.WHILEFRESH_DEEPSEEK_API_KEY?.trim() ?? "",
      lexmount: env.WHILEFRESH_LEXMOUNT_API_KEY?.trim() ?? "",
      lexmountProjectId: env.WHILEFRESH_LEXMOUNT_PROJECT_ID?.trim() ?? "",
    });
  }

  key(service: Service): string {
    return this.values.key(service);
  }

  isConfigured(): boolean {
    return this.values.isConfigured();
  }
}
