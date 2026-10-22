import { getCredits, useQuery } from "wasp/client/operations";

export function useCredits(enabled = true) {
  return useQuery(getCredits, undefined, { enabled, refetchOnWindowFocus: true });
}
