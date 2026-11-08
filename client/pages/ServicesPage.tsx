import { useCallback, useEffect, useState } from "react";

import type { ServiceSourcesDto } from "../../shared/api";
import { useAppShell } from "../App";
import { api } from "../api";
import { KeyField } from "../components/KeyField";
import { PageHeader } from "../components/PageHeader";

export function ServicesPage() {
  const { goBack, refresh } = useAppShell();
  const [sources, setSources] = useState<ServiceSourcesDto | null>(null);

  const refreshSources = useCallback(async () => {
    const next = await api.services();
    setSources(next);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void api
      .services()
      .then((next) => {
        if (active) {
          setSources(next);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="page-shell">
      <PageHeader
        heading="服务"
        actionText="返回"
        onAction={goBack}
      />

      <div
        style={{
          display: "grid",
          gap: "var(--gap)",
          marginTop: "var(--gap-small)",
        }}
      >
        <KeyField
          label="DeepSeek 密钥"
          field="deepseek"
          source={sources?.deepseek ?? "none"}
          onRefresh={refreshSources}
        />
        <KeyField
          label="Lexmount 密钥"
          field="lexmount"
          source={sources?.lexmount ?? "none"}
          onRefresh={refreshSources}
        />
        <KeyField
          label="Lexmount 项目 ID"
          field="lexmountProject"
          source={sources?.lexmountProject ?? "none"}
          onRefresh={refreshSources}
        />
      </div>
    </section>
  );
}
