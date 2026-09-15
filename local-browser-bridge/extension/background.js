import { reactInspectExpression } from "./reactInspect.js";
import { reactContextMetadata } from "./reactContext.js";
const defaultDaemonUrl = "ws://127.0.0.1:9327/extension";
// Keep a short grace period so a sequence of agent commands reuses one
// debugger attachment, then return the tab to Chrome when control is idle.
const debuggerIdleTimeoutMs = 5_000;
const contextKeyPrefix = "codex-browser-bridge:context:";
const contextScreenshotRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const contextStorageCleanupAlarm = "local-browser-bridge:cleanup-context-storage";
const maxContextScreenshotCount = 50;
const maxContextScreenshotBytes = 100 * 1024 * 1024;
const contextStorageDatabaseName = "local-browser-bridge-context";
const contextScreenshotStoreName = "screenshots";
const pageSnapshotRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const pageSnapshotStoreName = "pageSnapshots";
const maxPageSnapshotCount = 500;
const maxPageSnapshotBytes = 25 * 1024 * 1024;
const chromeApiNamespaces = new Set([
    "bookmarks",
    "browsingData",
    "contentSettings",
    "cookies",
    "downloads",
    "history",
    "management",
    "sessions",
    "storage",
    "tabGroups",
    "tabs",
    "windows"
]);
let socket;
let retry;
const pendingAuthorizations = new Map();
const pendingPageValueRequests = new Map();
const attached = new Set();
const debuggerDetachTimers = new Map();
let contextStorageDatabase;
void connect();
void injectExistingContentScripts();
scheduleContextStorageCleanup();
chrome.runtime.onStartup.addListener(() => { void connect(); void injectExistingContentScripts(); scheduleContextStorageCleanup(); });
chrome.runtime.onInstalled.addListener(() => { void connect(); void injectExistingContentScripts(); scheduleContextStorageCleanup(); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { void runtime(message, sender).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; });
chrome.debugger.onDetach.addListener((source) => { if (Number.isInteger(source.tabId))
    forgetDebugger(source.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => forgetDebugger(tabId));
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === contextStorageCleanupAlarm)
    void cleanupContextStorage(); });
async function config() {
    const settings = await chrome.storage.local.get({ daemonUrl: defaultDaemonUrl, extensionToken: "", websiteGrants: {} });
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(settings.extensionToken)) {
        settings.extensionToken = extensionCredential();
        await chrome.storage.local.set({ extensionToken: settings.extensionToken });
    }
    return settings;
}
async function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)
        return;
    if (retry)
        clearTimeout(retry);
    const { daemonUrl, extensionToken } = await config();
    if (!extensionToken)
        return;
    const url = new URL(daemonUrl);
    url.searchParams.set("extensionId", chrome.runtime.id);
    url.searchParams.set("token", extensionToken);
    socket = new WebSocket(url);
    socket.addEventListener("open", () => void injectExistingContentScripts());
    socket.addEventListener("message", (event) => void fromDaemon(String(event.data)));
    socket.addEventListener("close", () => { rejectPageValueRequests("Disconnected from the local daemon."); retry = setTimeout(() => void connect(), 2_000); });
    socket.addEventListener("error", () => socket?.close());
}
async function fromDaemon(raw) {
    let message;
    try {
        message = JSON.parse(raw);
    }
    catch {
        return;
    }
    if (message.type === "ping") {
        socket?.send(JSON.stringify({ type: "pong" }));
        return;
    }
    if (message.type === "pageValueMappingsResponse" && typeof message.id === "string") {
        const pending = pendingPageValueRequests.get(message.id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        pendingPageValueRequests.delete(message.id);
        message.ok === true ? pending.resolve(message.result) : pending.reject(new Error(typeof message.error === "string" ? message.error : "Page-value mapping request failed."));
        return;
    }
    if (message.type === "websiteAuthorizationRequest")
        return authorizeRequest(message);
    if (message.type !== "command" || typeof message.id !== "string")
        return;
    try {
        socket?.send(JSON.stringify({ id: message.id, ok: true, result: await execute(message.command) }));
    }
    catch (error) {
        socket?.send(JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
}
async function authorizeRequest(message) {
    if (typeof message.requestId !== "string" || typeof message.origin !== "string" || !Array.isArray(message.scopes))
        return;
    const request = { requestId: message.requestId, origin: new URL(message.origin).origin, scopes: message.scopes.filter((scope) => scope === "tabs.read" || scope === "page.read" || scope === "page.interact") };
    if (!request.scopes.length)
        return;
    const grants = (await config()).websiteGrants;
    const grant = grants[request.origin];
    if (grant && (!grant.expiresAt || grant.expiresAt > Date.now()) && request.scopes.every((scope) => grant.scopes.includes(scope)))
        return decision(request.requestId, true, request.scopes, grant.expiresAt);
    if (grant?.expiresAt && grant.expiresAt <= Date.now()) {
        delete grants[request.origin];
        await chrome.storage.local.set({ websiteGrants: grants });
    }
    pendingAuthorizations.set(request.requestId, request);
    await chrome.windows.create({ url: chrome.runtime.getURL(`approval.html?requestId=${encodeURIComponent(request.requestId)}`), type: "popup", width: 460, height: 410, focused: true });
}
async function runtime(message, sender) {
    if (message?.type === "settings") {
        const { daemonUrl } = await config();
        return { daemonUrl, connected: socket?.readyState === WebSocket.OPEN };
    }
    if (message?.type === "saveSettings") {
        const daemonUrl = daemonWebSocketUrl(message.daemonUrl);
        await chrome.storage.local.set({ daemonUrl });
        socket?.close();
        await connect();
        void injectExistingContentScripts();
        return { saved: true };
    }
    if (message?.type === "authorizationRequest")
        return pendingAuthorizations.get(message.requestId) || null;
    if (message?.type === "authorization") {
        const request = pendingAuthorizations.get(message.requestId);
        if (!request)
            throw new Error("Authorization request has expired.");
        pendingAuthorizations.delete(message.requestId);
        const expiresAt = message.duration === "always" ? null : Date.now() + (message.duration === "hour" ? 3_600_000 : 600_000);
        if (message.allow) {
            const state = await config();
            state.websiteGrants[request.origin] = { scopes: request.scopes, expiresAt, updatedAt: Date.now() };
            await chrome.storage.local.set({ websiteGrants: state.websiteGrants });
        }
        decision(request.requestId, message.allow === true, message.allow ? request.scopes : [], expiresAt);
        return { sent: true };
    }
    if (message?.type === "websiteGrants")
        return (await config()).websiteGrants;
    if (message?.type === "revokeWebsiteGrant") {
        const state = await config();
        if (message.origin === "*")
            await chrome.storage.local.remove("websiteGrants");
        else if (typeof message.origin === "string") {
            delete state.websiteGrants[message.origin];
            await chrome.storage.local.set({ websiteGrants: state.websiteGrants });
        }
        return { revoked: true };
    }
    if (message?.type === "pageValueMappings")
        return pageValueMappings("get");
    if (message?.type === "setPageValueMappings")
        return pageValueMappings("set", message.mappings);
    if (message?.type === "pageInjectionConfig")
        return pageInjectionConfig(sender);
    if (message?.type === "captureContextScreenshot")
        return captureContextScreenshot(sender);
    if (message?.type === "storePageSnapshot")
        return storePageSnapshot(message.key, message.snapshot, sender);
    if (message?.type === "enrichPageContext")
        return enrichPageContext(message.context, sender);
    if (message?.type === "submitPageContext")
        return submitPageContext(message.context, sender, message.receiverTabId);
    throw new Error("Unknown extension message.");
}
function decision(requestId, allow, scopes, expiresAt) { socket?.send(JSON.stringify({ type: "authorizationDecision", requestId, allow, scopes, expiresAt })); }
function pageValueMappings(action, mappings) {
    if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new Error("The extension is not connected to the local daemon.");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingPageValueRequests.delete(id); reject(new Error("Page-value mapping request timed out.")); }, 15_000);
        pendingPageValueRequests.set(id, { resolve, reject, timer });
        try {
            socket.send(JSON.stringify({ type: "pageValueMappingsRequest", id, action, ...(action === "set" ? { mappings } : {}) }));
        }
        catch (error) {
            clearTimeout(timer);
            pendingPageValueRequests.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
function rejectPageValueRequests(message) { for (const pending of pendingPageValueRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
} pendingPageValueRequests.clear(); }
async function pageInjectionConfig(sender) {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    if (!Number.isInteger(tabId) || typeof tabUrl !== "string")
        throw new Error("Page injection requires an HTTP(S) tab.");
    const page = new URL(tabUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:")
        throw new Error("Page injection requires an HTTP(S) tab.");
    const currentTabReceiver = await injectionReceiverForTab(sender.tab);
    let mappings = [];
    if (socket?.readyState === WebSocket.OPEN) {
        try {
            const result = await pageValueMappings("get");
            if (Array.isArray(result.mappings))
                mappings = result.mappings;
        }
        catch { /* Menu remains usable without configured values. */ }
    }
    // A receiver can also be the source page: this makes it possible to attach
    // context for a control in Session Manager itself. Otherwise use another
    // registered loopback receiver, excluding the source tab.
    return { enabled: true, tabId: tabId, mappings, receiver: currentTabReceiver ?? await findInjectionReceiver(tabId) };
}
async function captureContextScreenshot(sender) {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    const tabUrl = sender.tab?.url;
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId) || typeof tabUrl !== "string")
        throw new Error("Screenshot capture requires an HTTP(S) tab.");
    const page = new URL(tabUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:")
        throw new Error("Screenshot capture requires an HTTP(S) tab.");
    const active = (await chrome.tabs.query({ active: true, windowId: windowId }))[0];
    if (active?.id !== tabId)
        throw new Error("The source tab is no longer active.");
    const pngDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const png = dataUrlBlob(pngDataUrl, "image/png");
    const image = await createImageBitmap(png);
    try {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        if (!context)
            throw new Error("WebP conversion is unavailable.");
        context.drawImage(image, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
        if (blob.type !== "image/webp")
            throw new Error("Chrome did not produce a WebP screenshot.");
        const capturedAt = new Date().toISOString();
        const stored = {
            key: `${contextKeyPrefix}${tabId}:${crypto.randomUUID()}`,
            blob,
            capturedAt,
            expiresAt: Date.now() + contextScreenshotRetentionMs,
            mimeType: "image/webp",
            width: image.width,
            height: image.height,
            size: blob.size
        };
        await putContextScreenshot(stored);
        void cleanupContextStorage();
        return { key: stored.key, mimeType: stored.mimeType, capturedAt, width: stored.width, height: stored.height };
    }
    finally {
        image.close();
    }
}
async function storePageSnapshot(keyValue, snapshotValue, sender) {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    if (!Number.isInteger(tabId) || typeof tabUrl !== "string" || !record(snapshotValue))
        throw new Error("Page snapshot requires an HTTP(S) tab.");
    const page = new URL(tabUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:")
        throw new Error("Page snapshot requires an HTTP(S) tab.");
    const key = string(keyValue, "key");
    if (!key.startsWith(`${contextKeyPrefix}${tabId}:`))
        throw new Error("Invalid page snapshot key.");
    if (snapshotValue.kind !== "browser-bridge-context-snapshot" || snapshotValue.tabId !== tabId || snapshotValue.url !== tabUrl)
        throw new Error("Invalid page snapshot payload.");
    const serialized = JSON.stringify(snapshotValue);
    if (serialized.length > 256_000)
        throw new Error("Page snapshot payload is too large.");
    const capturedAt = typeof snapshotValue.capturedAt === "string" && Number.isFinite(Date.parse(snapshotValue.capturedAt))
        ? snapshotValue.capturedAt
        : new Date().toISOString();
    const stored = {
        key,
        snapshot: snapshotValue,
        capturedAt,
        expiresAt: Date.now() + pageSnapshotRetentionMs,
        size: new Blob([serialized]).size
    };
    await putPageSnapshot(stored);
    void cleanupContextStorage();
    return { key };
}
async function submitPageContext(input, sender, receiverTabId) {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    if (!Number.isInteger(tabId) || typeof tabUrl !== "string" || !record(input) || input.kind !== "browser-bridge-context")
        throw new Error("Invalid page context.");
    if (typeof input["extension-context-key"] !== "string" || JSON.stringify(input).length > 512_000)
        throw new Error("Invalid page context payload.");
    if (!Number.isInteger(receiverTabId))
        throw new Error("The target agent tab is no longer registered.");
    const context = await withReactComponents({ ...input, tabId, url: tabUrl }, tabId);
    const target = await chrome.tabs.get(receiverTabId);
    const receiver = await injectionReceiverForTab(target);
    if (!receiver)
        throw new Error("The target agent tab is no longer registered.");
    const injected = await chrome.tabs.sendMessage(receiver.tabId, { type: "injectBrowserContext", context });
    if (injected?.ok !== true)
        throw new Error("The target agent tab rejected the page context.");
    await chrome.windows.update(receiver.windowId, { focused: true });
    await chrome.tabs.update(receiver.tabId, { active: true });
    return { added: true, receiver: { tabId: receiver.tabId, name: receiver.name } };
}
async function enrichPageContext(input, sender) {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    if (!Number.isInteger(tabId) || typeof tabUrl !== "string" || !record(input) || input.kind !== "browser-bridge-context")
        throw new Error("Invalid page context.");
    return withReactComponents({ ...input, tabId, url: tabUrl }, tabId);
}
async function withReactComponents(context, tabId) {
    const selector = typeof context.selector === "string" ? context.selector : "";
    if (!selector)
        return context;
    try {
        const inspection = await evaluate(tabId, reactInspectExpression(selector));
        if (!record(inspection))
            return context;
        return { ...context, ...reactContextMetadata(inspection) };
    }
    catch {
        // Context capture must still work on pages that reject debugger attachment.
        return context;
    }
}
async function findInjectionReceiver(excludeTabId) {
    const tabs = (await chrome.tabs.query({})).filter((tab) => tab.id !== excludeTabId && isLoopbackPage(tab.url));
    tabs.sort((left, right) => Number(right.active) - Number(left.active) || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
    for (const tab of tabs) {
        const receiver = await injectionReceiverForTab(tab);
        if (receiver)
            return receiver;
    }
    return null;
}
async function injectionReceiverForTab(tab) {
    if (!Number.isInteger(tab.id) || !Number.isInteger(tab.windowId) || !isLoopbackPage(tab.url))
        return null;
    try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "browserContextReceiver" });
        const name = typeof response?.name === "string" ? response.name.trim().slice(0, 120) : "";
        return name ? { tabId: tab.id, windowId: tab.windowId, name } : null;
    }
    catch {
        return null;
    }
}
function isLoopbackPage(value) {
    try {
        const url = new URL(value || "");
        return (url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    }
    catch {
        return false;
    }
}
async function injectExistingContentScripts() {
    if (!chrome.scripting)
        return;
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter((item) => {
        try {
            const url = new URL(item.url || "");
            return typeof item.id === "number" && (url.protocol === "http:" || url.protocol === "https:");
        }
        catch {
            return false;
        }
    }).map(async (item) => {
        await chrome.scripting.executeScript({
            target: { tabId: item.id },
            world: "MAIN",
            func: () => {
                const legacyWindow = window;
                legacyWindow.__codexBrowserBridgeContextMenu?.dispose?.();
                delete legacyWindow.__codexBrowserBridgeContextMenu;
                for (const menu of document.querySelectorAll("[data-codex-browser-bridge-menu],[data-local-browser-bridge-menu],[data-local-browser-bridge-highlight]"))
                    menu.remove();
            }
        });
        await chrome.scripting.executeScript({ target: { tabId: item.id }, files: ["content.js"] });
    }));
}
async function execute(command) {
    if (command.type === "listTabs")
        return listTabs();
    if (command.type === "listWindows")
        return chrome.windows.getAll({ populate: true });
    if (command.type === "listTargets")
        return chrome.debugger.getTargets();
    if (command.type === "chromeApi")
        return callChromeApi(command.namespace, command.method, command.args);
    if (command.type === "getContextScreenshot")
        return getContextScreenshot(string(command.key, "key"));
    if (command.type === "getPageSnapshot")
        return getPageSnapshot(string(command.key, "key"));
    if (command.type === "createTab") {
        return chrome.tabs.create({
            url: optional(command.url),
            active: command.active !== false,
            windowId: Number.isInteger(command.windowId) ? command.windowId : undefined
        });
    }
    const tabId = tab(command.tabId);
    switch (command.type) {
        case "activateTab": {
            const value = await chrome.tabs.get(tabId);
            await chrome.windows.update(value.windowId, { focused: true });
            return chrome.tabs.update(tabId, { active: true });
        }
        case "closeTab":
            await chrome.tabs.remove(tabId);
            return {};
        case "navigate": return send(tabId, "Page.navigate", { url: string(command.url, "url") });
        case "reload": return send(tabId, "Page.reload", { ignoreCache: Boolean(command.ignoreCache) });
        case "evaluate": return evaluate(tabId, string(command.expression, "expression"));
        case "reactInspect": return evaluate(tabId, reactInspectExpression(string(command.selector, "selector")));
        case "clickSelector": return click(tabId, string(command.selector, "selector"));
        case "typeSelector": return type(tabId, string(command.selector, "selector"), string(command.text, "text", true));
        case "screenshot": {
            const result = await send(tabId, "Page.captureScreenshot", { format: "png", fromSurface: true });
            return { dataUrl: `data:image/png;base64,${result.data}` };
        }
        case "snapshot": return send(tabId, "DOMSnapshot.captureSnapshot", { computedStyles: [] });
        case "pageContext": return pageContext(tabId, typeof command.selector === "string" ? command.selector : undefined);
        case "cdp": return send(tabId, string(command.method, "method"), record(command.params) ? command.params : {});
        default: throw new Error(`Unknown browser command: ${String(command.type)}`);
    }
}
function scheduleContextStorageCleanup() {
    chrome.alarms.create(contextStorageCleanupAlarm, { delayInMinutes: 1, periodInMinutes: 60 });
    void cleanupContextStorage();
}
async function screenshotDatabase() {
    if (!contextStorageDatabase) {
        contextStorageDatabase = new Promise((resolve, reject) => {
            const request = indexedDB.open(contextStorageDatabaseName, 2);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(contextScreenshotStoreName)) {
                    request.result.createObjectStore(contextScreenshotStoreName, { keyPath: "key" });
                }
                if (!request.result.objectStoreNames.contains(pageSnapshotStoreName)) {
                    request.result.createObjectStore(pageSnapshotStoreName, { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Could not open screenshot storage."));
            request.onblocked = () => reject(new Error("Screenshot storage upgrade is blocked."));
        });
    }
    return contextStorageDatabase;
}
async function putContextScreenshot(value) {
    const database = await screenshotDatabase();
    const transaction = database.transaction(contextScreenshotStoreName, "readwrite");
    transaction.objectStore(contextScreenshotStoreName).put(value);
    await transactionComplete(transaction);
}
async function putPageSnapshot(value) {
    const database = await screenshotDatabase();
    const transaction = database.transaction(pageSnapshotStoreName, "readwrite");
    transaction.objectStore(pageSnapshotStoreName).put(value);
    await transactionComplete(transaction);
}
async function getContextScreenshot(key) {
    if (!key.startsWith(contextKeyPrefix))
        throw new Error("Invalid context screenshot key.");
    const database = await screenshotDatabase();
    const transaction = database.transaction(contextScreenshotStoreName, "readonly");
    const stored = await idbResult(transaction.objectStore(contextScreenshotStoreName).get(key));
    await transactionComplete(transaction);
    if (!stored || stored.expiresAt <= Date.now()) {
        if (stored)
            void deleteStoredContexts(contextScreenshotStoreName, [key]);
        throw new Error("Context screenshot was not found or has expired.");
    }
    return {
        key: stored.key,
        dataUrl: await blobDataUrl(stored.blob),
        capturedAt: stored.capturedAt,
        expiresAt: new Date(stored.expiresAt).toISOString(),
        mimeType: stored.mimeType,
        width: stored.width,
        height: stored.height,
        size: stored.size
    };
}
async function getPageSnapshot(key) {
    if (!key.startsWith(contextKeyPrefix))
        throw new Error("Invalid page snapshot key.");
    const database = await screenshotDatabase();
    const transaction = database.transaction(pageSnapshotStoreName, "readonly");
    const stored = await idbResult(transaction.objectStore(pageSnapshotStoreName).get(key));
    await transactionComplete(transaction);
    if (!stored || stored.expiresAt <= Date.now()) {
        if (stored)
            void deleteStoredContexts(pageSnapshotStoreName, [key]);
        throw new Error("Page snapshot was not found or has expired.");
    }
    return {
        key: stored.key,
        snapshot: stored.snapshot,
        capturedAt: stored.capturedAt,
        expiresAt: new Date(stored.expiresAt).toISOString(),
        size: stored.size
    };
}
async function cleanupContextStorage() {
    try {
        const database = await screenshotDatabase();
        const transaction = database.transaction([contextScreenshotStoreName, pageSnapshotStoreName], "readonly");
        const screenshots = await idbResult(transaction.objectStore(contextScreenshotStoreName).getAll());
        const pageSnapshots = await idbResult(transaction.objectStore(pageSnapshotStoreName).getAll());
        await transactionComplete(transaction);
        const screenshotRemovals = storageRemovals(screenshots, maxContextScreenshotCount, maxContextScreenshotBytes);
        const pageSnapshotRemovals = storageRemovals(pageSnapshots, maxPageSnapshotCount, maxPageSnapshotBytes);
        if (screenshotRemovals.length)
            await deleteStoredContexts(contextScreenshotStoreName, screenshotRemovals);
        if (pageSnapshotRemovals.length)
            await deleteStoredContexts(pageSnapshotStoreName, pageSnapshotRemovals);
    }
    catch {
        // Temporary context cleanup is best-effort and retries on the next alarm.
    }
}
function storageRemovals(values, maxCount, maxBytes) {
    const removals = [];
    let keptCount = 0;
    let keptBytes = 0;
    for (const value of values.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))) {
        const keep = value.expiresAt > Date.now() && keptCount < maxCount && keptBytes + value.size <= maxBytes;
        if (!keep) {
            removals.push(value.key);
            continue;
        }
        keptCount += 1;
        keptBytes += value.size;
    }
    return removals;
}
async function deleteStoredContexts(storeName, keys) {
    const database = await screenshotDatabase();
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    for (const key of keys)
        store.delete(key);
    await transactionComplete(transaction);
}
function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Screenshot storage transaction failed."));
        transaction.onabort = () => reject(transaction.error || new Error("Screenshot storage transaction was aborted."));
    });
}
function idbResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Screenshot storage request failed."));
    });
}
function dataUrlBlob(dataUrl, expectedMimeType) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
    if (!match || match[1] !== expectedMimeType)
        throw new Error("Chrome returned an invalid screenshot.");
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: expectedMimeType });
}
async function blobDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
}
async function send(tabId, method, params = {}) {
    cancelDebuggerDetach(tabId);
    if (!attached.has(tabId)) {
        await chrome.debugger.attach({ tabId }, "1.3");
        attached.add(tabId);
    }
    try {
        return await chrome.debugger.sendCommand({ tabId }, method, params);
    }
    finally {
        scheduleDebuggerDetach(tabId);
    }
}
function scheduleDebuggerDetach(tabId) {
    if (!attached.has(tabId))
        return;
    cancelDebuggerDetach(tabId);
    debuggerDetachTimers.set(tabId, setTimeout(() => { void detachDebugger(tabId); }, debuggerIdleTimeoutMs));
}
function cancelDebuggerDetach(tabId) {
    const timer = debuggerDetachTimers.get(tabId);
    if (timer !== undefined)
        clearTimeout(timer);
    debuggerDetachTimers.delete(tabId);
}
async function detachDebugger(tabId) {
    cancelDebuggerDetach(tabId);
    if (!attached.has(tabId))
        return;
    try {
        await chrome.debugger.detach({ tabId });
    }
    catch {
        // Chrome also detaches automatically when the tab disappears or another
        // debugger claims it. Either result means this extension has no control.
    }
    finally {
        attached.delete(tabId);
    }
}
function forgetDebugger(tabId) {
    cancelDebuggerDetach(tabId);
    attached.delete(tabId);
}
async function evaluate(tabId, expression) { const result = await send(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.text || "Evaluation failed"); return result.result?.value; }
async function click(tabId, selector) { const point = await evaluate(tabId, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("Element not found"); e.scrollIntoView({block:"center",inline:"center"}); const r=e.getBoundingClientRect(); if (!r.width || !r.height) throw new Error("Element has no clickable area"); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`); await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }); await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }); return point; }
async function type(tabId, selector, text) { await evaluate(tabId, `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!(e instanceof HTMLElement)) throw new Error("Element not found"); e.focus(); if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) e.select(); else if (!e.isContentEditable) throw new Error("Element is not editable"); return true; })()`); await send(tabId, "Input.insertText", { text }); return { typed: text.length }; }
async function pageContext(tabId, selector) { return evaluate(tabId, `(() => { const path=(element)=>{if(!element||element.nodeType!==1)return null;const parts=[];for(let node=element;node&&node.nodeType===1&&parts.length<8;node=node.parentElement){if(node.id){parts.unshift('#'+CSS.escape(node.id));break}let part=node.tagName.toLowerCase();const siblings=[...(node.parentElement?.children||[])].filter((sibling)=>sibling.tagName===node.tagName);if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part)}return parts.join(' > ')};const element=${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.activeElement || document.documentElement"}||document.documentElement;return{tabId:${tabId},url:location.href,title:document.title,selector:path(element),selectedText:(getSelection()?.toString().trim()||'').slice(0,20000),element:{tagName:element?.tagName?.toLowerCase()||null,id:element?.id||null,className:typeof element?.className==='string'?element.className:null,role:element?.getAttribute?.('role')||null,ariaLabel:element?.getAttribute?.('aria-label')||null}}})()`); }
async function listTabs() { const values = await chrome.tabs.query({}); return values.map(({ id, url, title, active, windowId, status }) => ({ id, url, title, active, windowId, status })); }
async function callChromeApi(namespaceValue, methodValue, args) {
    const namespace = string(namespaceValue, "namespace");
    const methodName = string(methodValue, "method");
    if (!chromeApiNamespaces.has(namespace))
        throw new Error(`Chrome API namespace is not allowed: ${namespace}`);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(methodName) || methodName.startsWith("on"))
        throw new Error("A valid Chrome API method is required.");
    const api = chrome[namespace];
    const method = api?.[methodName];
    if (typeof method !== "function")
        throw new Error(`Chrome API method is unavailable: ${namespace}.${methodName}`);
    return Reflect.apply(method, api, Array.isArray(args) ? args : []);
}
function tab(value) { if (!Number.isInteger(value) || value < 0)
    throw new Error("A valid tabId is required."); return value; }
function string(value, name, empty = false) { if (typeof value !== "string" || (!empty && !value.trim()))
    throw new Error(`${name} is required.`); return value; }
function optional(value) { return typeof value === "string" && value.trim() ? value : undefined; }
function daemonWebSocketUrl(value) { const url = new URL(String(value || defaultDaemonUrl)); if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1")
    throw new Error("Daemon URL must be a ws://127.0.0.1 URL."); return url.toString(); }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function extensionCredential() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
