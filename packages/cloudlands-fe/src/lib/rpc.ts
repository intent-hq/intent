// Thin, typed client over the bridge — the redux/saga replacement for this slice.
import { bridgeRpc } from "./bridge";
import type { RpcMethods } from "./types";

// Typed JSON-RPC call. The method name constrains both params and result shape,
// so callers get full inference, e.g. `await rpc("workspace.list")`.
export async function rpc<M extends keyof RpcMethods>(
  method: M,
  params: RpcMethods[M]["params"] = {} as RpcMethods[M]["params"],
): Promise<RpcMethods[M]["result"]> {
  return bridgeRpc<RpcMethods[M]["result"]>(
    method,
    params as Record<string, unknown>,
  );
}
