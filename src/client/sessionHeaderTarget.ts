import { createContext } from "react";

/** Explicit portal destination for the session main block, wherever it is mounted. */
export const SessionHeaderTarget = createContext<Element | null | undefined>(undefined);
