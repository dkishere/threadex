import type { TestContext } from "node:test";

export function mockSubmissionStorage(t: TestContext) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const values = new Map<string, string>();
    const localStorage = {
        get length() { return values.size; },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); }
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        localStorage, dispatchEvent() {}, matchMedia: () => ({ matches: false })
    } });
    t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
        else Reflect.deleteProperty(globalThis, "window");
    });
    return localStorage;
}
