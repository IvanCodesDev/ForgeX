import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import { createIdentityService, identityErrorState, type IdentityService, type IdentityState } from "./identity-client";

interface IdentityContextValue {
  readonly state: IdentityState;
  readonly loginHref: string | null;
  readonly logoutPending: boolean;
  refresh(): void;
  logout(): Promise<void>;
}

interface IdentityProviderProps {
  readonly runtimeMode: RuntimeMode;
  readonly children: ReactNode;
  readonly env?: ImportMetaEnv;
  readonly service?: IdentityService;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);
const DEFAULT_IDENTITY_ENV: ImportMetaEnv = import.meta.env;

function messageFrom(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "身份服务暂时不可用";
}

export function IdentityProvider({ runtimeMode, children, env, service }: IdentityProviderProps) {
  const activeEnv = env ?? DEFAULT_IDENTITY_ENV;
  const activeService = useMemo(
    () => service ?? createIdentityService(runtimeMode, activeEnv),
    [activeEnv, runtimeMode, service]
  );
  const [state, setState] = useState<IdentityState>(activeService.initialState);
  const [revision, setRevision] = useState(0);
  const [logoutPending, setLogoutPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState(activeService.initialState);
    if (activeService.initialState.mode !== "offline") {
      void activeService.load(controller.signal).then(
        (nextState) => setState(nextState),
        (error: unknown) => {
          if (!controller.signal.aborted) setState(identityErrorState(messageFrom(error)));
        }
      );
    }
    return () => controller.abort();
  }, [activeService, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const logout = useCallback(async () => {
    setLogoutPending(true);
    try {
      await activeService.logout();
      refresh();
    } catch (error) {
      setState(identityErrorState(messageFrom(error)));
    } finally {
      setLogoutPending(false);
    }
  }, [activeService, refresh]);

  const value = useMemo<IdentityContextValue>(
    () => ({ state, loginHref: activeService.loginHref, logoutPending, refresh, logout }),
    [activeService.loginHref, logout, logoutPending, refresh, state]
  );
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("useIdentity 必须在 IdentityProvider 内使用");
  return value;
}
