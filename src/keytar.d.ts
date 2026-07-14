// keytar is an OPTIONAL native dependency, loaded via dynamic import and
// externalized at build time. It is not installed by default (no native build
// step); session-store.ts falls back to a 0600 file store when absent. This
// ambient declaration lets tsc resolve the dynamic import without the package
// being present.
declare module "keytar" {
  export function getPassword(service: string, account: string): Promise<string | null>;
  export function setPassword(service: string, account: string, password: string): Promise<void>;
  export function deletePassword(service: string, account: string): Promise<boolean>;
}
