import type { Provider } from "../types.ts";
import { ashby } from "./ashby.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import type { Adapter } from "./shared.ts";

export { TOKEN_RE } from "./shared.ts";
export type { Adapter } from "./shared.ts";

export const adapters: Record<Provider, Adapter> = { greenhouse, lever, ashby };
